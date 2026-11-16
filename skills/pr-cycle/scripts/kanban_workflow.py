"""Persist approved workflows and guard native coding-agent launches in SQLite."""
import argparse
from contextlib import closing
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sqlite3
import sys
from urllib.parse import urlparse
import uuid

from kanban_tracking import connect, default_database

ROLES = ('plan', 'implementation', 'implementation_child', 'functional', 'security')
PROMPTS = {
    'plan': '分析任务与代码，输出实施计划、风险等级 P0/P1/P2/P3、验收条件及子 PR 依赖。只规划，不修改项目代码。',
    'implementation': '严格按人工批准的计划实施并运行验证。可以分配独立子任务；不得自行审查批准或合并。',
    'functional': '独立核对批准计划、功能验收、边界及回归测试。只审查，不修改代码；给出证据和通过或打回结论。',
    'security': '独立检查权限、输入边界、敏感数据和依赖风险。只审查，不修改代码；给出证据和通过或打回结论。',
}
SCHEMA = """
CREATE TABLE IF NOT EXISTS pr_cycle_workflows (
 task_id BLOB PRIMARY KEY, project_id BLOB NOT NULL, stage TEXT NOT NULL,
 revision INTEGER NOT NULL, approved_revision INTEGER, data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pr_cycle_workflow_settings (project_id BLOB PRIMARY KEY, prompts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pr_cycle_workflow_sessions (
 session_id BLOB PRIMARY KEY, task_id BLOB NOT NULL, role TEXT NOT NULL,
 workspace_id BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS pr_cycle_launch_permits (
 task_id BLOB PRIMARY KEY, role TEXT NOT NULL, revision INTEGER NOT NULL,
 session_id BLOB, workspace_id BLOB, executor TEXT NOT NULL, profile TEXT NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS pr_cycle_workflow_execution_guard
BEFORE INSERT ON execution_processes WHEN NEW.run_reason='codingagent' BEGIN
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM sessions s JOIN workspaces w ON w.id=s.workspace_id
  JOIN pr_cycle_workflows f ON f.task_id=w.task_id
  JOIN pr_cycle_launch_permits p ON p.task_id=f.task_id
  WHERE s.id=NEW.session_id AND p.revision=f.revision AND p.expires_at>=unixepoch()
   AND (p.session_id IS NULL OR p.session_id=s.id)
   AND (p.workspace_id IS NULL OR p.workspace_id=w.id)
   AND json_extract(NEW.executor_action,'$.typ.executor_profile_id.executor')=p.executor
   AND json_extract(NEW.executor_action,'$.typ.executor_profile_id.variant')=p.profile
   AND ((p.role='plan' AND f.stage='plan') OR
    (p.role IN ('implementation','implementation_child') AND f.stage='implementation' AND f.approved_revision=f.revision) OR
    (p.role=f.stage AND p.role IN ('functional','security') AND f.approved_revision=f.revision))
   AND NOT EXISTS (SELECT 1 FROM pr_cycle_workflow_sessions b WHERE b.session_id=s.id
     AND (b.task_id!=f.task_id OR NOT (b.role=p.role OR (b.role='plan' AND p.role='implementation'))))
   AND (p.role!='plan' OR NOT EXISTS (SELECT 1 FROM pr_cycle_workflow_sessions b
     WHERE b.task_id=f.task_id AND b.role IN ('plan','implementation') AND b.session_id!=s.id))
 ) THEN RAISE(ABORT,'Workflow launch denied: use approved stage launch') END;
 INSERT OR IGNORE INTO pr_cycle_workflow_sessions(session_id,task_id,role,workspace_id)
 SELECT NEW.session_id,w.task_id,p.role,w.id FROM sessions s JOIN workspaces w ON w.id=s.workspace_id
 JOIN pr_cycle_launch_permits p ON p.task_id=w.task_id WHERE s.id=NEW.session_id;
 DELETE FROM pr_cycle_launch_permits WHERE task_id=(
  SELECT w.task_id FROM sessions s JOIN workspaces w ON w.id=s.workspace_id WHERE s.id=NEW.session_id);
END;
CREATE TRIGGER IF NOT EXISTS pr_cycle_workflow_done_guard BEFORE UPDATE OF status ON tasks
WHEN NEW.status='done' AND EXISTS (SELECT 1 FROM pr_cycle_workflows f WHERE f.task_id=NEW.id
 AND (f.stage!='done' OR json_extract(f.data,'$.merged')!=1))
BEGIN SELECT RAISE(ABORT,'Workflow completion requires human approval and verified merge'); END;
CREATE TRIGGER IF NOT EXISTS pr_cycle_workflow_task_edit_guard BEFORE UPDATE OF title,description ON tasks
WHEN (OLD.title IS NOT NEW.title OR OLD.description IS NOT NEW.description)
 AND EXISTS (SELECT 1 FROM pr_cycle_workflows WHERE task_id=OLD.id)
 AND EXISTS (SELECT 1 FROM execution_processes e JOIN sessions s ON s.id=e.session_id
 JOIN workspaces w ON w.id=s.workspace_id WHERE w.task_id=OLD.id AND e.status='running' AND e.run_reason='codingagent')
BEGIN SELECT RAISE(ABORT,'Stop active agents before changing approved task requirements'); END;
CREATE TRIGGER IF NOT EXISTS pr_cycle_workflow_task_changed AFTER UPDATE OF title,description ON tasks
WHEN OLD.title IS NOT NEW.title OR OLD.description IS NOT NEW.description BEGIN
 UPDATE pr_cycle_workflows SET stage='plan',revision=revision+1,approved_revision=NULL,
 data=json_set(data,'$.stage','plan','$.revision',revision+1,'$.approved_revision',NULL,
 '$.functional',NULL,'$.security',NULL,'$.human_approval',NULL,'$.summary','任务内容已改变，请重新保存并批准计划')
 WHERE task_id=NEW.id;
 DELETE FROM pr_cycle_launch_permits WHERE task_id=NEW.id;
END;
"""


def ident(value):
    return uuid.UUID(str(value)).bytes


def uid(value):
    return str(uuid.UUID(bytes=value))


def text(value, label, limit=40000, optional=False):
    if not isinstance(value, str) or len(value) > limit or (not optional and not value.strip()):
        raise ValueError(f'{label}: expected nonempty text up to {limit} characters')
    return value.strip()


def sha(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', value):
        raise ValueError('Expected full lowercase commit SHA')
    return value


def pr_url(value):
    parsed = urlparse(text(value, 'PR URL', 2000))
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or not re.search(r'/(pull|merge_requests)/[1-9][0-9]*$', parsed.path):
        raise ValueError('Expected HTTPS pull request URL')
    return value


def prompts(value):
    if not isinstance(value, dict) or set(value) - set(PROMPTS):
        raise ValueError('Unknown stage prompt')
    return {k: text(v, k, 20000, optional=True) for k, v in value.items()}


def children(value):
    if not isinstance(value, list) or len(value) > 30:
        raise ValueError('Expected up to 30 child PR definitions')
    result = []
    for item in value:
        if not isinstance(item, dict) or set(item) - {'id', 'title', 'depends_on', 'base_branch', 'summary', 'task_id','publish_pr'}:
            raise ValueError('Invalid child PR definition')
        key = text(item.get('id'), 'Child ID', 80)
        if not re.fullmatch(r'[A-Za-z0-9_-]+', key):
            raise ValueError('Child ID must use letters, digits, underscore or hyphen')
        depends = item.get('depends_on', [])
        if not isinstance(depends, list) or any(not isinstance(x, str) for x in depends) or len(depends) != len(set(depends)):
            raise ValueError('Invalid child dependencies')
        child = {'id': key, 'title': text(item.get('title'), 'Child title', 300), 'depends_on': depends,
                 'base_branch': text(item.get('base_branch', 'main'), 'Base branch', 300), 'publish_pr': item.get('publish_pr', True)}
        if type(child['publish_pr']) is not bool:
            raise ValueError('publish_pr must be boolean')
        if item.get('task_id'):
            child['task_id'] = uid(ident(item['task_id']))
        result.append(child)
    by_id = {item['id']: item for item in result}
    if len(by_id) != len(result):
        raise ValueError('Duplicate child ID')
    def visit(key, path):
        if key not in by_id or key in path:
            raise ValueError('Missing or cyclic child dependency')
        for parent in by_id[key]['depends_on']:
            visit(parent, path | {key})
    for key in by_id:
        visit(key, set())
    for item in result:
        if item['publish_pr'] and any(not by_id[parent]['publish_pr'] for parent in item['depends_on']):
            raise ValueError('Publishing children must depend on publishing children; merge nonpublishing collaborators into the primary workspace')
    return result


def install(filename):
    with closing(connect(filename)) as db:
        for table, fields in {'tasks': {'id','project_id','status'}, 'sessions': {'id','workspace_id'},
                              'workspaces': {'id','task_id'}, 'execution_processes': {'id','session_id','run_reason','executor_action','status'}}.items():
            actual = {row['name'] for row in db.execute(f'PRAGMA table_info({table})')}
            if not fields <= actual:
                raise ValueError(f'Unsupported native {table} schema')
        if not db.execute("SELECT 1 FROM sqlite_master WHERE name='pr_cycle_workflows'").fetchone():
            stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
            with closing(sqlite3.connect(Path(filename).with_name('db.before-pr-cycle-workflow-' + stamp + '.sqlite'))) as backup:
                db.backup(backup)
        db.executescript('BEGIN IMMEDIATE;\n' + SCHEMA + '\nCOMMIT;')
    return {'installed': True, 'version': 1}


def row_json(row):
    return {key: uid(row[key]) if isinstance(row[key], bytes) else row[key] for key in row.keys()}


def view(db, project):
    settings = db.execute('SELECT prompts FROM pr_cycle_workflow_settings WHERE project_id=?', (project,)).fetchone()
    workflows = []
    for row in db.execute('SELECT data FROM pr_cycle_workflows WHERE project_id=? ORDER BY rowid', (project,)):
        flow = json.loads(row['data'])
        flow.setdefault('automation', {'enabled': False, 'paused': False, 'reason': None})
        flow['sessions'] = [row_json(r) for r in db.execute('SELECT * FROM pr_cycle_workflow_sessions WHERE task_id=?', (ident(flow['task_id']),))]
        primary = next((r for r in flow['sessions'] if r['role'] in ('plan','implementation')), None)
        flow['plan_session_id'] = primary['session_id'] if primary else None
        flow['workspace_id'] = primary['workspace_id'] if primary else None
        workflows.append(flow)
    return {'workflows': workflows, 'settings': {'prompts': {**PROMPTS, **(json.loads(settings[0]) if settings else {})}}}


def binding(db, flow, payload):
    session = ident(payload.get('session_id'))
    row = db.execute('''SELECT b.*,s.executor FROM pr_cycle_workflow_sessions b JOIN sessions s ON s.id=b.session_id
                        WHERE b.session_id=? AND b.task_id=?''', (session, ident(flow['task_id']))).fetchone()
    role = payload.get('role')
    if not row or not (row['role'] == role or (row['role'] == 'plan' and role == 'implementation')):
        raise ValueError('Session does not belong to this workflow role')
    return row


def evidence(db, flow, payload):
    binding(db, flow, payload)
    process = db.execute('SELECT * FROM execution_processes WHERE id=? AND session_id=?',
                         (ident(payload.get('process_id')), ident(payload['session_id']))).fetchone()
    if not process or process['run_reason'] != 'codingagent' or process['status'] != 'completed' or process['exit_code'] != 0:
        raise ValueError('Stage result requires a successfully completed bound agent execution')
    if any(e.get('process_id') == payload['process_id'] for e in flow['events']):
        if any(e.get('process_id') == payload['process_id'] and e['action'] in ('save_plan','record_result','record_child_result') for e in flow['events']):
            raise ValueError('Execution result was already collected')
    run = next((r for r in flow.get('runs', []) if r['process_id']==payload['process_id']), None)
    if not run or run['revision'] != flow['revision'] or run['role'] != payload['role']:
        raise ValueError('Execution has no matching current stage snapshot')
    if payload['role'] in ('functional','security') and run['head_sha'] != payload.get('head_sha'):
        raise ValueError('Code changed since the review started')
    return process


def clear_results(flow, reset_publications=False):
    flow.update(functional=None, security=None, human_approval=None, merged=False)
    if reset_publications:
        flow.update(integration=None, prs=[])
    else:
        for item in flow['prs']:
            item['stale'] = True


def require_stage(flow, *stages):
    if flow['stage'] not in stages:
        raise ValueError('Action is not allowed in stage ' + flow['stage'])


def approved(flow):
    if flow['approved_revision'] != flow['revision'] or not flow['revision']:
        raise ValueError('Current plan requires human approval')


def reviewed(flow, head):
    for role in ('functional','security'):
        result = flow.get(role)
        if not result or not result['passed'] or result['head_sha'] != head:
            raise ValueError('Both independent reviews must pass for the exact commit')


def runtime(db, flow, payload):
    flow = next(f for f in view(db, ident(flow['project_id']))['workflows'] if f['task_id']==flow['task_id'])
    task = db.execute('SELECT * FROM tasks WHERE id=?', (ident(flow['task_id']),)).fetchone()
    workspaces = [row_json(r) for r in db.execute('SELECT * FROM workspaces WHERE task_id=?', (ident(flow['task_id']),))]
    sessions = [row_json(r) for r in db.execute('''SELECT s.* FROM sessions s JOIN workspaces w ON w.id=s.workspace_id WHERE w.task_id=?''', (ident(flow['task_id']),))]
    processes = [row_json(r) for r in db.execute('''SELECT e.*,b.role FROM execution_processes e JOIN sessions s ON s.id=e.session_id
                 JOIN workspaces w ON w.id=s.workspace_id LEFT JOIN pr_cycle_workflow_sessions b ON b.session_id=s.id
                 WHERE w.task_id=? ORDER BY e.created_at DESC LIMIT 100''', (ident(flow['task_id']),))]
    repos = []
    if db.execute("SELECT 1 FROM sqlite_master WHERE name='workspace_repos'").fetchone():
        repos = [row_json(r) for r in db.execute('''SELECT r.*,wr.workspace_id,wr.target_branch FROM workspace_repos wr
                   JOIN repos r ON r.id=wr.repo_id JOIN workspaces w ON w.id=wr.workspace_id WHERE w.task_id=?''', (ident(flow['task_id']),))]
    result = {'workflow': flow, 'task': row_json(task), 'workspaces': workspaces, 'sessions': sessions, 'processes': processes, 'repos': repos}
    if payload.get('process_id'):
        process_id = uid(ident(payload['process_id']))
        if not any(p['id'] == process_id for p in processes):
            raise ValueError('Execution does not belong to this task')
        logs = []
        length = 0
        for row in db.execute('SELECT logs FROM execution_process_logs WHERE execution_id=? ORDER BY inserted_at DESC', (ident(process_id),)):
            length += len(row[0].encode('utf-8'))
            if length > 2 * 1024 * 1024:
                result['logs_truncated'] = True
                break
            logs.append(row[0])
        result['logs'] = '\n'.join(reversed(logs))
    return result


def execute(filename, payload):
    if not isinstance(payload, dict):
        raise ValueError('Expected request object')
    action = payload.get('action', 'read')
    with closing(connect(filename)) as db, db:
        db.execute('BEGIN' if action in ('read','runtime','list_automated','running_count') else 'BEGIN IMMEDIATE')
        if action == 'running_count':
            return db.execute('''SELECT count(*) FROM execution_processes e
                JOIN pr_cycle_workflow_sessions b ON b.session_id=e.session_id
                WHERE e.run_reason='codingagent' AND e.status='running' ''').fetchone()[0]
        if action == 'list_automated':
            return [row_json(row) for row in db.execute('''
                SELECT f.project_id,f.task_id FROM pr_cycle_workflows f JOIN tasks t ON t.id=f.task_id
                WHERE json_extract(f.data,'$.automation.enabled')=1
                  AND json_extract(f.data,'$.automation.paused')=0
                  AND f.stage NOT IN ('human','done','cancelled') AND t.status!='cancelled'
                ORDER BY f.rowid''')]
        project = ident(payload.get('project_id'))
        if action == 'read':
            return view(db, project)
        if action == 'configure':
            values = prompts(payload.get('prompts'))
            previous = db.execute('SELECT prompts FROM pr_cycle_workflow_settings WHERE project_id=?', (project,)).fetchone()
            merged = {**(json.loads(previous[0]) if previous else {}), **values}
            db.execute('INSERT OR REPLACE INTO pr_cycle_workflow_settings VALUES(?,?)', (project, json.dumps({k:v for k,v in merged.items() if v})))
            return view(db, project)
        task_id = ident(payload.get('task_id'))
        task = db.execute('SELECT * FROM tasks WHERE id=? AND project_id=?', (task_id, project)).fetchone()
        if not task:
            raise ValueError('Task not found in this project')
        row = db.execute('SELECT data FROM pr_cycle_workflows WHERE task_id=?', (task_id,)).fetchone()
        flow = json.loads(row[0]) if row else None
        if action == 'begin_plan' and not flow:
            flow = {'task_id': uid(task_id), 'project_id': uid(project), 'stage': 'plan', 'risk': None, 'plan': '',
                    'revision': 0, 'approved_revision': None, 'summary': '等待规划', 'head_sha': None,
                    'children': [], 'prompts': {}, 'events': [], 'functional': None, 'security': None,
                    'prs': [], 'integration': None, 'human_approval': None, 'merged': False, 'runs': [], 'error': None,
                    'plan_revision': None, 'automation': {'enabled': False, 'paused': False, 'reason': None}}
        elif not flow:
            raise ValueError('Start planning before changing workflow')
        flow.setdefault('automation', {'enabled': False, 'paused': False, 'reason': None})
        if action == 'runtime':
            return runtime(db, flow, payload)
        if action == 'begin_plan':
            require_stage(flow, 'plan')
        elif action == 'authorize_start':
            if flow['stage'] in ('done','cancelled') or task['status']=='cancelled':
                raise ValueError('Cannot authorize an ended workflow')
            if flow.get('error'):
                raise ValueError('Resume the paused workflow to acknowledge its error before starting')
            flow['automation'].update(enabled=True, paused=False, reason=None)
        elif action == 'pause':
            flow['automation'].update(paused=True, reason=text(payload.get('reason','人工暂停自动调度'), 'Pause reason', 4000))
            db.execute('DELETE FROM pr_cycle_launch_permits WHERE task_id=?', (task_id,))
        elif action == 'resume':
            if not flow['automation']['enabled'] and not any(run['role']=='plan' for run in flow.get('runs', [])):
                raise ValueError('Workflow has not been authorized for automatic execution')
            if flow['stage'] in ('done','cancelled') or task['status']=='cancelled':
                raise ValueError('Cannot resume an ended workflow')
            flow['automation'].update(enabled=True, paused=False, reason=None)
            flow['error'] = None
        elif action == 'configure_task':
            flow['prompts'].update(prompts(payload.get('prompts')))
            flow['prompts'] = {k:v for k,v in flow['prompts'].items() if v}
        elif action == 'save_plan':
            require_stage(flow, 'plan','implementation')
            if db.execute('''SELECT 1 FROM execution_processes e JOIN sessions s ON s.id=e.session_id JOIN workspaces w ON w.id=s.workspace_id
                              WHERE w.task_id=? AND e.run_reason='codingagent' AND e.status='running' ''', (task_id,)).fetchone():
                raise ValueError('Stop the running agent before changing its plan')
            if payload.get('expected_revision') != flow['revision']:
                raise ValueError('Plan changed; reload before saving')
            if payload.get('role') != 'plan' or not payload.get('process_id'):
                raise ValueError('Plan must be produced by a completed planning agent execution')
            evidence(db, flow, payload)
            if payload.get('risk') not in ('P0','P1','P2','P3'):
                raise ValueError('Risk must be P0, P1, P2 or P3')
            flow.update(plan=text(payload.get('plan'), 'Plan'), risk=payload['risk'], children=children(payload.get('children', [])),
                        revision=flow['revision'] + 1, approved_revision=None, stage='plan', head_sha=None)
            flow['plan_revision'] = flow['revision']
            flow['task_snapshot'] = {'title': task['title'], 'description': task['description']}
            clear_results(flow, reset_publications=True)
            db.execute('DELETE FROM pr_cycle_launch_permits WHERE task_id=?', (task_id,))
        elif action == 'approve_plan':
            require_stage(flow, 'plan')
            if not flow['plan'] or payload.get('expected_revision') != flow['revision'] or flow.get('plan_revision') != flow['revision']:
                raise ValueError('Approval must refer to the saved current plan revision')
            if flow.get('task_snapshot') != {'title':task['title'], 'description':task['description']}:
                raise ValueError('Task requirements changed; wait for a new planning agent result')
            flow.update(approved_revision=flow['revision'], stage='implementation')
            settings = view(db, project)['settings']['prompts']
            flow['approved_prompts'] = {**settings, **flow['prompts']}
        elif action == 'bind_session':
            role = payload.get('role')
            if role not in ROLES:
                raise ValueError('Unknown agent role')
            session = ident(payload.get('session_id'))
            workspace = ident(payload.get('workspace_id'))
            if not db.execute('''SELECT 1 FROM sessions s JOIN workspaces w ON w.id=s.workspace_id
                                 WHERE s.id=? AND w.id=? AND w.task_id=?''', (session, workspace, task_id)).fetchone():
                raise ValueError('Session/workspace does not belong to task')
            existing = db.execute('SELECT * FROM pr_cycle_workflow_sessions WHERE session_id=?', (session,)).fetchone()
            if existing and not (existing['task_id'] == task_id and (existing['role'] == role or (existing['role']=='plan' and role=='implementation'))):
                raise ValueError('Review sessions must be independent from every implementer and reviewer')
            primary = db.execute("SELECT session_id FROM pr_cycle_workflow_sessions WHERE task_id=? AND role IN ('plan','implementation')", (task_id,)).fetchone()
            if role in ('plan','implementation') and primary and primary[0] != session:
                raise ValueError('Planning and implementation must share the primary agent session')
            if role == 'implementation_child' and db.execute("SELECT 1 FROM pr_cycle_workflow_sessions WHERE task_id=? AND workspace_id=? AND role IN ('plan','implementation','implementation_child') AND session_id!=?", (task_id,workspace,session)).fetchone():
                raise ValueError('Each implementation child needs an independent workspace')
            if role in ('functional','security'):
                prior = db.execute('SELECT session_id FROM pr_cycle_workflow_sessions WHERE task_id=? AND role=?', (task_id,role)).fetchone()
                if prior and prior[0] != session:
                    raise ValueError('Reuse the independently bound reviewer session')
            db.execute('INSERT OR IGNORE INTO pr_cycle_workflow_sessions VALUES(?,?,?,?)', (session,task_id,role,workspace))
            if role == 'implementation_child' and payload.get('child_id'):
                child = next((c for c in flow['children'] if c['id']==payload['child_id']), None)
                if not child:
                    raise ValueError('Child must exist in the approved plan')
                child.update(session_id=uid(session), workspace_id=uid(workspace))
                if payload.get('resolved_base_branch'):
                    child['resolved_base_branch'] = text(payload['resolved_base_branch'], 'Resolved dependency branch', 300)
        elif action == 'prepare_launch':
            if flow.get('launch_intent'):
                raise ValueError('A launch intent is unresolved; reconcile it before retrying')
            if flow['automation']['paused']:
                raise ValueError('Automatic workflow is paused; resume before launching another agent')
            role = payload.get('role')
            if role not in ROLES:
                raise ValueError('Unknown agent role')
            require_stage(flow, 'implementation' if role == 'implementation_child' else role)
            if role != 'plan':
                approved(flow)
                if flow.get('task_snapshot') != {'title':task['title'], 'description':task['description']}:
                    raise ValueError('Task requirements changed; save and approve the revised plan')
            if payload.get('executor') not in ('CLAUDE_CODE','CODEX'):
                raise ValueError('Unsupported workflow executor')
            session = ident(payload['session_id']) if payload.get('session_id') else None
            if session:
                binding(db, flow, payload)
            elif role != 'plan':
                raise ValueError('Bind a distinct role session before launching')
            if role == 'implementation_child':
                child = next((c for c in flow['children'] if c['id']==payload.get('child_id')), None)
                if not child:
                    raise ValueError('Select a planned implementation child')
                if not set(child['depends_on']) <= {c['id'] for c in flow['children'] if c.get('completed')}:
                    raise ValueError('Complete child dependencies before starting')
            if db.execute('''SELECT 1 FROM execution_processes e JOIN sessions s ON s.id=e.session_id JOIN workspaces w ON w.id=s.workspace_id
                              WHERE w.task_id=? AND e.run_reason='codingagent' AND e.status='running' ''', (task_id,)).fetchone():
                if role != 'implementation_child':
                    raise ValueError('An agent is already running for this task')
            if db.execute('SELECT 1 FROM pr_cycle_launch_permits WHERE task_id=? AND expires_at>=unixepoch()', (task_id,)).fetchone():
                raise ValueError('A launch is already pending; reconcile it before retrying')
            profile = 'PR_CYCLE_' + ('IMPLEMENTATION' if role == 'implementation_child' else role.upper())
            db.execute('INSERT OR REPLACE INTO pr_cycle_launch_permits VALUES(?,?,?,?,?,?,?,unixepoch()+60)',
                       (task_id,role,flow['revision'],session,ident(payload['workspace_id']) if payload.get('workspace_id') else None,payload['executor'],profile))
            if any(key in payload for key in ('prompt','head_sha','known_process_ids')):
                known = payload.get('known_process_ids', [])
                if not isinstance(known, list) or len(known) > 10000:
                    raise ValueError('Expected known process IDs list')
                flow['launch_intent'] = {'session_id': uid(session) if session else None, 'role': role,
                    'child_id': payload.get('child_id'), 'head_sha': sha(payload['head_sha']) if payload.get('head_sha') else None,
                    'prompt': text(payload.get('prompt'), 'Prompt snapshot', 120000), 'revision': flow['revision'],
                    'known_process_ids': list(dict.fromkeys(uid(ident(value)) for value in known))}
        elif action == 'cancel_launch':
            db.execute('DELETE FROM pr_cycle_launch_permits WHERE task_id=?', (task_id,))
        elif action == 'cancel_intent':
            flow.pop('launch_intent', None)
        elif action == 'mark_run':
            binding(db, flow, payload)
            process_id = uid(ident(payload.get('process_id')))
            process = db.execute('SELECT * FROM execution_processes WHERE id=? AND session_id=? AND run_reason=?',
                                 (ident(process_id),ident(payload['session_id']),'codingagent')).fetchone()
            if not process:
                raise ValueError('Execution does not belong to the bound session')
            intent = flow.get('launch_intent')
            matches_intent = (intent and intent['role'] == payload['role'] and intent['child_id'] == payload.get('child_id')
                              and intent['revision'] == flow['revision'] and process_id not in intent['known_process_ids']
                              and intent['session_id'] in (None, uid(ident(payload['session_id']))))
            if matches_intent:
                flow.pop('launch_intent')
            existing_run = any(r['process_id']==process_id for r in flow.get('runs', []))
            if existing_run and not matches_intent:
                return view(db, project)
            if payload['role'] == 'implementation_child':
                child = next((c for c in flow['children'] if c['id']==payload.get('child_id')), None)
                if not child:
                    raise ValueError('Implementation child must be in the approved plan')
                session = binding(db, flow, payload)
                if any(c.get('session_id')==payload['session_id'] and c['id']!=child['id'] for c in flow['children']):
                    raise ValueError('Each child must use its own session')
                child.update(session_id=payload['session_id'],workspace_id=uid(session['workspace_id']),completed=False)
            if not existing_run:
                flow.setdefault('runs', []).append({'process_id': process_id, 'session_id': payload['session_id'],
                     'role': payload['role'], 'head_sha': sha(payload['head_sha']) if payload.get('head_sha') else None,
                     'revision': flow['revision'], 'child_id': payload.get('child_id'), 'prompt': text(payload.get('prompt'), 'Prompt snapshot', 120000)})
        elif action == 'error':
            flow['error'] = text(payload.get('message'), 'Error', 4000)
            flow['summary'] = flow['error']
            flow['automation'].update(paused=True, reason=flow['error'])
            db.execute('DELETE FROM pr_cycle_launch_permits WHERE task_id=?', (task_id,))
        elif action == 'invalidate':
            if flow['stage']=='done':
                raise ValueError('Completed workflow cannot be silently reopened')
            clear_results(flow)
            flow['head_sha'] = sha(payload.get('head_sha'))
            flow['error'] = text(payload.get('message'), 'Invalidation reason', 4000)
            flow['summary'] = flow['error']
            flow['automation'].update(paused=True, reason=flow['error'])
            flow['stage'] = 'implementation'
            if flow['integration']:
                flow['integration']['head_sha'] = flow['head_sha']
            db.execute('DELETE FROM pr_cycle_launch_permits WHERE task_id=?', (task_id,))
        elif action in ('record_result','record_child_result'):
            if action == 'record_child_result':
                payload = {**payload, 'role': 'implementation_child'}
            role = payload.get('role')
            if role not in ('implementation','implementation_child','functional','security'):
                raise ValueError('Invalid result role')
            require_stage(flow, 'implementation' if role=='implementation_child' else role)
            approved(flow)
            evidence(db, flow, payload)
            head = sha(payload.get('head_sha'))
            if type(payload.get('passed')) is not bool:
                raise ValueError('Result must include passed boolean')
            result = {key: payload.get(key) for key in ('passed','summary','details','session_id','process_id')}
            result.update(head_sha=head, revision=flow['revision'])
            text(result['summary'], 'Result summary', 2000)
            if role in ('implementation','implementation_child'):
                clear_results(flow)
                if flow['integration'] and role == 'implementation':
                    flow['integration']['head_sha'] = head
                if role == 'implementation_child':
                    child = next((c for c in flow['children'] if c['id']==payload.get('child_id')), None)
                    if not child or child.get('session_id') != payload['session_id']:
                        raise ValueError('Child result must match its planned session')
                    child.update(head_sha=head, completed=payload['passed'], summary=payload['summary'],process_id=payload['process_id'])
                else:
                    flow['head_sha'] = head
                if role == 'implementation' and payload['passed']:
                    if any(not c.get('completed') for c in flow['children']):
                        raise ValueError('All planned child implementations must complete before aggregate review')
                    running = db.execute('''SELECT 1 FROM execution_processes e JOIN pr_cycle_workflow_sessions b ON b.session_id=e.session_id
                                           WHERE b.task_id=? AND e.status='running' AND e.run_reason='codingagent' ''', (task_id,)).fetchone()
                    if running:
                        raise ValueError('Wait for every implementation agent before review')
                    flow['stage'] = 'functional'
            else:
                if flow['head_sha'] != head:
                    raise ValueError('Review result does not match implementation commit')
                if role == 'security' and (not flow['functional'] or not flow['functional']['passed'] or flow['functional']['head_sha'] != head):
                    raise ValueError('Functional review must pass first')
                flow[role] = result
                if not payload['passed']:
                    clear_results(flow)
                    flow['stage'] = 'implementation'
                else:
                    flow['stage'] = 'security' if role=='functional' else 'pr'
        elif action == 'record_pr':
            require_stage(flow, 'pr','integration')
            head = sha(payload.get('head_sha'))
            reviewed(flow, flow['head_sha'])
            child_id = payload.get('child_id')
            final_integration = flow['integration'] is not None and not child_id
            publication_children = [c for c in flow['children'] if c.get('publish_pr',True)]
            if publication_children and not final_integration and child_id not in {c['id'] for c in publication_children}:
                raise ValueError('Select a planned child PR')
            if not publication_children and child_id:
                raise ValueError('Child PR was not planned')
            item = {'url': pr_url(payload.get('url')), 'head_sha': head, 'base_branch': text(payload.get('base_branch'), 'PR base', 300), 'child_id': child_id, 'stale': False}
            if child_id:
                child = next(c for c in flow['children'] if c['id']==child_id)
                if not child.get('completed') or child.get('head_sha') != head:
                    raise ValueError('Child PR must match its completed reviewed commit')
                if child.get('resolved_base_branch', child['base_branch']) != item['base_branch']:
                    raise ValueError('PR base differs from the approved child plan')
                publishing_deps = set(child['depends_on']) & {c['id'] for c in publication_children}
                if not publishing_deps <= {p['child_id'] for p in flow['prs'] if not p.get('stale')}:
                    raise ValueError('Publish dependency PRs first')
            elif head != flow['head_sha']:
                raise ValueError('PR must match the reviewed candidate commit')
            if any(p['url']==item['url'] and p.get('child_id')!=child_id for p in flow['prs']):
                raise ValueError('Each child needs its own PR')
            flow['prs'] = [p for p in flow['prs'] if p.get('child_id') != child_id] + [item]
            if final_integration:
                flow['integration']['pr_url'] = item['url']
                flow['stage'] = 'human'
            elif len(publication_children) > 1:
                if flow['risk'] != 'P2':
                    raise ValueError('Only P2 plans may combine multiple child PRs')
                published = {p['child_id'] for p in flow['prs'] if not p.get('stale')}
                flow['stage'] = 'integration' if {c['id'] for c in publication_children} <= published else 'pr'
            else:
                flow['stage'] = 'human'
        elif action == 'record_integration':
            require_stage(flow, 'integration')
            publication_children = [c for c in flow['children'] if c.get('publish_pr',True)]
            published = {p['child_id'] for p in flow['prs'] if not p.get('stale')}
            if flow['risk'] != 'P2' or len(publication_children) < 2 or not {c['id'] for c in publication_children} <= published:
                raise ValueError('Integration requires all planned P2 child PRs')
            flow['head_sha'] = sha(payload.get('head_sha'))
            flow['integration'] = {'head_sha': flow['head_sha'], 'pr_url': pr_url(payload['pr_url']) if payload.get('pr_url') else None, 'base_branch': text(payload.get('base_branch','main'), 'Integration base', 300)}
            for key in ('path','branch','repo_id'):
                if payload.get(key) is not None:
                    flow['integration'][key] = text(payload[key], key, 2000)
            flow['integration']['children'] = json.loads(json.dumps(flow['children']))
            flow.update(functional=None, security=None, human_approval=None, stage='functional')
        elif action == 'human_approve':
            require_stage(flow, 'human')
            head = sha(payload.get('head_sha'))
            reviewed(flow, head)
            if head != flow['head_sha']:
                raise ValueError('Human approval must match current candidate SHA')
            flow['human_approval'] = {'head_sha': head, 'revision': flow['revision'], 'approved_at': datetime.now(timezone.utc).isoformat()}
        elif action == 'complete':
            require_stage(flow, 'human')
            head = sha(payload.get('head_sha'))
            reviewed(flow, head)
            if payload.get('merged') is not True or not flow['human_approval'] or flow['human_approval']['head_sha'] != head:
                raise ValueError('Verified merge and human approval are required')
            flow.update(stage='done', merged=True)
        else:
            raise ValueError('Unknown workflow action')
        if payload.get('summary') is not None:
            flow['summary'] = text(payload['summary'], 'Summary', 2000)
        event = {'id': len(flow['events'])+1, 'action': action, 'stage': flow['stage'], 'summary': flow['summary'],
                               'details': payload.get('details',''), 'head_sha': flow['head_sha'], 'revision': flow['revision'],
                               'process_id': payload.get('process_id'), 'role': payload.get('role'), 'child_id': payload.get('child_id'), 'passed': payload.get('passed'),
                               'risk': flow['risk'], 'created_at': datetime.now(timezone.utc).isoformat()}
        if action=='save_plan':
            event.update(plan=flow['plan'],children=json.loads(json.dumps(flow['children'])))
        if action in ('record_pr','record_integration'):
            event.update(prs=json.loads(json.dumps(flow['prs'])),integration=flow['integration'])
        flow['events'].append(event)
        db.execute('INSERT OR REPLACE INTO pr_cycle_workflows VALUES(?,?,?,?,?,?)',
                   (task_id,project,flow['stage'],flow['revision'],flow['approved_revision'],json.dumps(flow,ensure_ascii=False)))
        if action == 'complete':
            db.execute("UPDATE tasks SET status='done' WHERE id=?", (task_id,))
        return view(db, project)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', type=Path)
    parser.add_argument('--install', action='store_true')
    args = parser.parse_args()
    try:
        data = install(args.db or default_database()) if args.install else execute(args.db or default_database(), json.load(sys.stdin))
        print(json.dumps({'success': True, 'data': data}, ensure_ascii=True))
        return 0
    except (ValueError, TypeError, KeyError, sqlite3.Error, OSError) as error:
        print(json.dumps({'success': False, 'message': str(error)}, ensure_ascii=True))
        return 1


if __name__ == '__main__':
    sys.exit(main())
