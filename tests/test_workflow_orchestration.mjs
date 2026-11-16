import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createWorkflowService, workflowCommand } from '../skills/pr-cycle/scripts/kanban-workflow-api.mjs';
import * as git from '../skills/pr-cycle/scripts/workflow-git.mjs';

const exec = promisify(execFile);
const sqlite = `import sqlite3,json,sys,uuid
p=json.loads(sys.argv[2]); c=sqlite3.connect(sys.argv[1]);c.row_factory=sqlite3.Row
args=[uuid.UUID(x['uuid']).bytes if isinstance(x,dict) and 'uuid' in x else x for x in p.get('args',[])]
if 'script' in p: c.executescript(p['script']); result=[]
else: result=[dict(x) for x in c.execute(p['sql'],args)]
c.commit();print(json.dumps(result,default=lambda x:str(uuid.UUID(bytes=x))))`;

async function fixture(t, children = []) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-roundtrip-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { database: path.join(directory, 'db.sqlite'), python: 'python' };
  const db = async (sql, args = []) => JSON.parse((await exec('python', ['-c', sqlite, config.database, JSON.stringify(typeof sql === 'string' ? { sql, args } : sql)])).stdout);
  await db({ script: `CREATE TABLE tasks(id BLOB PRIMARY KEY,project_id BLOB,title TEXT,description TEXT,status TEXT);
    CREATE TABLE workspaces(id BLOB PRIMARY KEY,task_id BLOB,container_ref TEXT,branch TEXT);
    CREATE TABLE sessions(id BLOB PRIMARY KEY,workspace_id BLOB,executor TEXT);
    CREATE TABLE execution_processes(id BLOB PRIMARY KEY,session_id BLOB,run_reason TEXT,executor_action TEXT,status TEXT,exit_code INTEGER,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE execution_process_logs(execution_id BLOB,logs TEXT,inserted_at TEXT DEFAULT CURRENT_TIMESTAMP);` });
  const project = randomUUID(), task = randomUUID(), repo = randomUUID();
  const id = uuid => ({ uuid });
  await db('INSERT INTO tasks VALUES(?,?,?,?,?)', [id(task), id(project), '导出功能', '导出 CSV 并处理空列表', 'todo']);
  const calls = [], profiles = { executors: { CLAUDE_CODE: { APPROVALS: { CLAUDE_CODE: { base_command_override: 'node local-cli.mjs claude', approvals: true } } } } };
  let head = 'a'.repeat(40), failSecurity = false, failImplementation = false, dirty = false, rejectAncestor = false;
  const workspaces = [], heads = new Map(), targets = new Map();
  const integrationHead = 'e'.repeat(40);
  const api = async (route, body, method) => {
    calls.push({ route, body, method });
    if (route === '/api/profiles') {
      if (body) { profiles.executors = body.executors; return body; }
      return { content: JSON.stringify(profiles) };
    }
    if (route.endsWith('/repositories')) return [{ id: repo, name: 'repo', path: directory, default_target_branch: 'main' }];
    if (route === '/api/task-attempts') {
      const workspace = randomUUID();
      const target = body.repos[0].target_branch;
      const predecessor = workspaces.find(w => w.branch===target);
      heads.set(workspace,predecessor ? heads.get(predecessor.id) : 'a'.repeat(40)); targets.set(workspace,target);
      const branch = 'feature-'+(workspaces.length+1);
      workspaces.push({id:workspace,branch});
      await db('INSERT INTO workspaces VALUES(?,?,?,?)', [id(workspace),id(task),directory,branch]);
      return { id: workspace };
    }
    if (route === '/api/sessions') {
      const session = randomUUID();
      await db('INSERT INTO sessions VALUES(?,?,?)', [id(session),id(body.workspace_id),body.executor]);
      return { id: session };
    }
    if (route.endsWith('/follow-up')) {
      const session = route.split('/')[3], processId = randomUUID(), role = body.executor_profile_id.variant;
      const response = role === 'PR_CYCLE_PLAN' ? { plan: '实现导出，验证空列表', risk: children.length ? 'P2' : 'P1', summary: '已规划导出和边界验证', children }
        : { passed: !(role === 'PR_CYCLE_SECURITY' && failSecurity) && !(role === 'PR_CYCLE_IMPLEMENTATION' && failImplementation), summary: role + '已核对', details: '证据' };
      if (role === 'PR_CYCLE_IMPLEMENTATION') {
        const owner = (await db('SELECT workspace_id FROM sessions WHERE id=?',[id(session)]))[0].workspace_id;
        head=String.fromCharCode(98+workspaces.findIndex(w=>w.id===owner)).repeat(40); heads.set(owner,head);
      }
      const executorAction = JSON.stringify({ typ: { type: 'CodingAgentInitialRequest', executor_profile_id: body.executor_profile_id } });
      await db('INSERT INTO execution_processes(id,session_id,run_reason,executor_action,status,exit_code) VALUES(?,?,?,?,?,?)', [id(processId),id(session),'codingagent',executorAction,'completed',0]);
      const terminal = JSON.stringify({ type:'result',is_error:false,result:'PR_CYCLE_RESULT:'+JSON.stringify(response) })+'\n';
      await db('INSERT INTO execution_process_logs(execution_id,logs) VALUES(?,?)', [id(processId),JSON.stringify({Stdout:terminal})]);
      return { id: processId };
    }
    if (route.endsWith('/branch-status')) { const ws=route.split('/')[3]; return [{repo_id:repo,head_oid:heads.get(ws),has_uncommitted_changes:dirty,untracked_count:0,target_branch_name:targets.get(ws)}]; }
    if (route.endsWith('/repos')) return [{id:repo,name:'repo'}];
    if (route.startsWith('/api/task-attempts/')) return (await db('SELECT * FROM workspaces WHERE id=?',[id(route.split('/')[3])]))[0];
    throw new Error('Unexpected route '+route);
  };
  const serviceOptions = { config, api, git: { ...git,
    createPr: async (_api,workspace,input) => { assert.equal(input.head_sha,heads.get(workspace)); return {url:'https://github.com/acme/repo/pull/'+(workspaces.findIndex(w=>w.id===workspace)+1),head_sha:input.head_sha,base_branch:input.target_branch}; },
    integratePrs: async (_api,_workspace,input) => { assert.equal(input.children.length,2); return {head_sha:integrationHead,path:path.join(directory,'integration'),branch:input.integrationBranch,base_branch:'main'}; },
    createIntegrationPr: async (snapshot,input) => { assert.equal(snapshot.head_sha,integrationHead); assert.equal(input.head_sha,integrationHead); return {url:'https://github.com/acme/repo/pull/99',head_sha:integrationHead,base_branch:'main'}; },
    mergePr: async (_url,snapshot,{approvedHeadSha}) => { assert.equal(approvedHeadSha,snapshot.head_sha); return {merged:true}; },
    runCommand: async (_command,args) => { if (args[0]==='merge-base' && rejectAncestor) throw new Error('not ancestor'); return args[0]==='rev-parse' ? integrationHead : args[0]==='status' && dirty ? ' M changed' : ''; },
  } };
  const service = createWorkflowService(serviceOptions);
  const dispatch = payload => service.dispatch({project_id:project,task_id:task,...payload});
  const read = async () => (await service.read(project)).workflows[0];
  return { service, recreate: () => createWorkflowService(serviceOptions), dispatch, read, calls, db, project, task, id, config, setHead: value => { head=value; heads.set(workspaces[0].id,value); }, failSecurity: (value=true) => { failSecurity=value; }, failImplementation: value => { failImplementation=value; }, setDirty: value => { dirty=value; }, rejectAncestor: value => { rejectAncestor=value; } };
}

test('real SQLite + mock native runtime completes plan, same implementation, two independent reviews, human merge', async t => {
  const f = await fixture(t);
  await f.dispatch({action:'start',role:'plan'});
  let flow = await f.read();
  assert.equal(flow.stage,'plan'); assert.equal(flow.revision,1);
  await assert.rejects(f.dispatch({action:'start',role:'implementation'}), /不能启动/);
  await f.dispatch({action:'approve_plan',expected_revision:flow.revision});
  await f.dispatch({action:'start',role:'implementation'});
  flow = await f.read(); assert.equal(flow.stage,'functional');
  await f.dispatch({action:'start',role:'functional'});
  flow = await f.read(); assert.equal(flow.stage,'security');
  await f.dispatch({action:'start',role:'security'});
  flow = await f.read(); assert.equal(flow.stage,'pr');
  const runs = flow.runs;
  assert.equal(runs[0].session_id,runs[1].session_id);
  assert.equal(new Set([runs[1].session_id,runs[2].session_id,runs[3].session_id]).size,3);
  await f.dispatch({action:'create_pr'}); flow=await f.read(); assert.equal(flow.stage,'human');
  await assert.rejects(f.dispatch({action:'merge'}), /人类批准/);
  await f.dispatch({action:'human_approve',head_sha:flow.head_sha});
  await f.dispatch({action:'merge'}); flow=await f.read(); assert.equal(flow.stage,'done');
  assert.equal((await f.db('SELECT status FROM tasks WHERE id=?',[f.id(f.task)]))[0].status,'done');
  const reconstructed = createWorkflowService({config:f.config,command:workflowCommand});
  assert.equal((await reconstructed.dispatch({project_id:f.project,task_id:f.task,action:'configure_task',prompts:{}})).workflows[0].stage,'done');
});

test('changed requirements revoke approval and changed reviewed code returns to implementation', async t => {
  const f=await fixture(t);
  await f.dispatch({action:'start',role:'plan'}); let flow=await f.read();
  await f.dispatch({action:'approve_plan',expected_revision:flow.revision});
  await f.db('UPDATE tasks SET description=? WHERE id=?',['新增敏感数据导出',f.id(f.task)]);
  flow=await f.read(); assert.equal(flow.stage,'plan'); assert.equal(flow.approved_revision,null);
  await f.service.tick(); flow=await f.read();
  assert.equal(flow.plan_revision,flow.revision); assert.equal(flow.stage,'plan');
  await f.dispatch({action:'approve_plan',expected_revision:flow.revision});
  await f.dispatch({action:'start',role:'implementation'}); flow=await f.read(); assert.equal(flow.stage,'functional');
  f.setHead('c'.repeat(40));
  await assert.rejects(f.dispatch({action:'start',role:'functional'}),/代码已改变/);
  assert.equal((await f.read()).stage,'implementation');
});

test('P2 stacked child agents publish separate PRs, integrate, rereview exact aggregate, then human merge', async t => {
  const f=await fixture(t,[{id:'a',title:'第一项',depends_on:[],base_branch:'main',publish_pr:true},
    {id:'b',title:'第二项',depends_on:['a'],base_branch:'main',publish_pr:true}]);
  await f.dispatch({action:'start',role:'plan'}); let flow=await f.read();
  await f.dispatch({action:'approve_plan',expected_revision:flow.revision});
  await assert.rejects(f.dispatch({action:'start_child',child_id:'b'}),/依赖/);
  await f.dispatch({action:'start_child',child_id:'a'}); flow=await f.read(); assert.equal(flow.children[0].completed,true);
  await f.dispatch({action:'start_child',child_id:'b'}); flow=await f.read(); assert.equal(flow.children[1].completed,true);
  assert.equal(flow.children[1].resolved_base_branch,'feature-2');
  await f.dispatch({action:'start',role:'implementation'}); flow=await f.read(); assert.equal(flow.head_sha.length,64);
  for (const role of ['functional','security']) { await f.dispatch({action:'start',role}); flow=await f.read(); }
  await f.dispatch({action:'create_pr',child_id:'a'});
  await f.dispatch({action:'create_pr',child_id:'b'}); flow=await f.read(); assert.equal(flow.stage,'integration');
  await f.dispatch({action:'integrate'}); flow=await f.read(); assert.equal(flow.stage,'functional'); assert.equal(flow.functional,null);
  await assert.rejects(f.dispatch({action:'human_approve',head_sha:flow.head_sha}),/审查/);
  f.setDirty(true);
  await assert.rejects(f.dispatch({action:'start',role:'functional'}),/代码已改变/);
  flow=await f.read(); assert.equal(flow.stage,'implementation'); assert.ok(flow.integration.path);
  f.setDirty(false);
  await f.dispatch({action:'resume'});
  await f.dispatch({action:'start',role:'implementation'}); flow=await f.read(); assert.equal(flow.stage,'functional');
  f.failSecurity();
  for (const role of ['functional','security']) { await f.dispatch({action:'start',role}); flow=await f.read(); }
  assert.equal(flow.stage,'implementation'); assert.ok(flow.integration.path);
  f.failSecurity(false);
  await f.dispatch({action:'start',role:'implementation'}); flow=await f.read(); assert.equal(flow.stage,'functional');
  for (const role of ['functional','security']) { await f.dispatch({action:'start',role}); flow=await f.read(); }
  await f.dispatch({action:'create_pr'}); flow=await f.read(); assert.equal(flow.stage,'human'); assert.ok(flow.integration.pr_url.endsWith('/99'));
  await f.dispatch({action:'human_approve',head_sha:flow.head_sha}); await f.dispatch({action:'merge'});
  assert.equal((await f.read()).stage,'done');
});


test('single publishing child must include primary commits before review', async t => {
  const f=await fixture(t,[{id:'a',title:'Delivery',publish_pr:true}]);
  await f.dispatch({action:'start',role:'plan'}); let flow=await f.read();
  await f.dispatch({action:'approve_plan',expected_revision:flow.revision});
  await f.dispatch({action:'start_child',child_id:'a'}); await f.read();
  f.rejectAncestor(true);
  await f.dispatch({action:'start',role:'implementation'}); flow=await f.read();
  assert.equal(flow.stage,'implementation'); assert.match(flow.error,/交付分支未包含/);
  f.rejectAncestor(false);
  await f.dispatch({action:'resume'}); flow=await f.read();
  assert.equal(flow.stage,'functional'); assert.equal(flow.head_sha,flow.children[0].head_sha);
  f.rejectAncestor(true);
  await assert.rejects(f.dispatch({action:'start',role:'functional'}),/代码已改变/);
  assert.equal((await f.read()).stage,'implementation');
});

test('independent child can complete before collaborators are merged into primary', async t => {
  const f=await fixture(t,[{id:'a',title:'First helper',publish_pr:false},{id:'b',title:'Second helper',publish_pr:false}]);
  await f.dispatch({action:'start',role:'plan'}); let flow=await f.read();
  await f.dispatch({action:'approve_plan',expected_revision:flow.revision});
  await f.dispatch({action:'start_child',child_id:'a'}); await f.read();
  f.rejectAncestor(true);
  await f.dispatch({action:'start_child',child_id:'b'}); flow=await f.read();
  assert.ok(flow.children.every(child => child.completed));
  await f.dispatch({action:'start',role:'implementation'}); flow=await f.read();
  assert.equal(flow.stage,'implementation'); assert.match(flow.error,/交付分支未包含/);
});

test('backend scheduler needs only start and plan approval, then stops at final human review', async t => {
  const f=await fixture(t);
  const peek=async () => (await workflowCommand(f.config,{action:'read',project_id:f.project})).workflows[0];
  await f.dispatch({action:'start',role:'plan'});
  await f.service.tick();
  let flow=await peek();
  assert.equal(flow.stage,'plan'); assert.equal(flow.risk,'P1');
  assert.ok(flow.plan); assert.equal(flow.runs.length,1);
  await f.service.tick(); assert.equal((await peek()).runs.length,1);
  await f.dispatch({action:'approve_plan',expected_revision:flow.revision});
  await f.dispatch({action:'pause'});
  await f.service.tick(); assert.equal((await peek()).runs.length,1);
  await f.dispatch({action:'resume'});
  for(let i=0;i<5;i++) await f.service.tick();
  flow=await peek(); assert.equal(flow.stage,'human'); assert.equal(flow.runs.length,4);
  assert.equal(new Set(flow.runs.slice(1).map(r=>r.session_id)).size,3);
  assert.equal(flow.human_approval,null); assert.equal(flow.merged,false);
  await f.service.tick(); assert.equal((await peek()).stage,'human');
});

test('unattended review failure returns to implementation and automatically reviews the repair', async t => {
  const f=await fixture(t);
  await f.dispatch({action:'start',role:'plan'}); let flow=await f.read();
  await f.dispatch({action:'approve_plan',expected_revision:flow.revision});
  f.failSecurity();
  for(let i=0;i<4;i++) await f.service.tick();
  flow=(await workflowCommand(f.config,{action:'read',project_id:f.project})).workflows[0];
  assert.equal(flow.stage,'implementation'); assert.equal(flow.runs.at(-1).role,'implementation');
  f.failSecurity(false);
  for(let i=0;i<4;i++) await f.service.tick();
  flow=(await workflowCommand(f.config,{action:'read',project_id:f.project})).workflows[0];
  assert.equal(flow.stage,'human'); assert.equal(flow.merged,false);
});

test('scheduler pauses a child after three failed attempts instead of spending indefinitely', async t => {
  const f=await fixture(t,[{id:'a',title:'Helper',publish_pr:false}]);
  await f.dispatch({action:'start',role:'plan'}); let flow=await f.read();
  await f.dispatch({action:'approve_plan',expected_revision:flow.revision});
  f.failImplementation(true);
  for(let i=0;i<5;i++) await f.service.tick();
  flow=(await workflowCommand(f.config,{action:'read',project_id:f.project})).workflows[0];
  assert.equal(flow.automation.paused,true);
  assert.equal(flow.runs.filter(r=>r.role==='implementation_child').length,3);
  assert.match(flow.error,/三轮/);
  f.failImplementation(false);
  await f.dispatch({action:'resume'});
  await f.service.tick();
  flow=await f.read(); assert.equal(flow.children[0].completed,true);
});

test('restart reconciles a durable launch intent without repeating the paid plan execution', async t => {
  const f=await fixture(t);
  await f.dispatch({action:'start',role:'plan'});
  let flow=(await workflowCommand(f.config,{action:'read',project_id:f.project})).workflows[0];
  const run=flow.runs[0];
  flow.launch_intent={...run,known_process_ids:[]}; flow.runs=[];
  await f.db('UPDATE pr_cycle_workflows SET data=? WHERE task_id=?',[JSON.stringify(flow),f.id(f.task)]);
  const restarted=f.recreate();
  await restarted.tick();
  flow=(await workflowCommand(f.config,{action:'read',project_id:f.project})).workflows[0];
  assert.equal(flow.stage,'plan'); assert.equal(flow.risk,'P1'); assert.ok(flow.plan);
  assert.equal(flow.runs.length,1); assert.equal(flow.runs[0].process_id,run.process_id);
  assert.equal(flow.launch_intent,undefined);
  assert.equal(f.calls.filter(c=>c.route.endsWith('/follow-up')).length,1);
});

test('P2 child PRs and integration rereviews advance unattended to the separate final review gate', async t => {
  const f=await fixture(t,[{id:'a',title:'First',publish_pr:true},{id:'b',title:'Second',publish_pr:true,depends_on:['a']}]);
  await f.dispatch({action:'start',role:'plan'}); let flow=await f.read();
  await f.dispatch({action:'approve_plan',expected_revision:flow.revision});
  for(let i=0;i<13;i++) await f.service.tick();
  flow=(await workflowCommand(f.config,{action:'read',project_id:f.project})).workflows[0];
  assert.equal(flow.error,null); assert.equal(flow.stage,'human');
  assert.ok(flow.integration.pr_url.endsWith('/99'));
  assert.equal(flow.runs.filter(r=>r.role==='functional').length,2);
  assert.equal(flow.runs.filter(r=>r.role==='security').length,2);
  assert.equal(flow.human_approval,null); assert.equal(flow.merged,false);
});
