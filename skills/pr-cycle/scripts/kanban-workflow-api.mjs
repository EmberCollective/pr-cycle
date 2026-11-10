import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gitSnapshot, createPr, createIntegrationPr, integratePrs, mergePr, runCommand } from './workflow-git.mjs';

import { extractResult } from './workflow-result.mjs';
export { extractResult };

const script = fileURLToPath(new URL('./kanban_workflow.py', import.meta.url));
const roles = ['plan', 'implementation', 'implementation_child', 'functional', 'security'];
const phase = role => role === 'implementation_child' ? 'implementation' : role;
const variant = role => `PR_CYCLE_${phase(role).toUpperCase()}`;
const publicActions = new Set(['begin_plan', 'approve_plan', 'configure', 'configure_task', 'pause', 'resume',
  'start', 'start_child', 'collect', 'create_pr', 'integrate', 'human_approve', 'merge']);
let profileUpdate = Promise.resolve();

export function workflowCommand(config, payload, install = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.python ?? 'python', [script, ...(config.database ? ['--db', config.database] : []), ...(install ? ['--install'] : [])],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('流程数据库响应超时')); }, 20000);
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { error += chunk; });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', () => {
      clearTimeout(timer);
      try { const result = JSON.parse(output); if (!result.success) throw new Error(result.message); resolve(result.data); }
      catch (err) { reject(new Error(error || err.message)); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload ?? {}));
  });
}

export function stageProfile(baseline, executor, role) {
  const config = structuredClone(baseline);
  delete config.append_prompt;
  delete config.additional_params;
  if (executor === 'CLAUDE_CODE') {
    // Implementation is authorized by the approved plan; readonly roles never inherit this permission.
    Object.assign(config, { dangerously_skip_permissions: role === 'implementation', plan: role === 'plan', approvals: false });
    if (role !== 'implementation') config.additional_params = ['--tools=Read,Glob,Grep', '--strict-mcp-config', '--disable-slash-commands',
      '--disallowedTools=ExitPlanMode,Edit,Write,NotebookEdit,Bash,PowerShell,Task,Agent,AskUserQuestion'];
  } else if (executor === 'CODEX') {
    Object.assign(config, { sandbox: role === 'implementation' ? 'workspace-write' : 'read-only', ask_for_approval: role === 'implementation' ? 'on-request' : 'never' });
  } else throw new Error('流程目前支持本机 Claude Code 或 Codex');
  return config;
}

export function buildPrompt(role, runtime, settings, snapshots, child) {
  const flow = runtime.workflow;
  const template = (role !== 'plan' ? flow.approved_prompts?.[phase(role)] : undefined) ?? flow.prompts?.[phase(role)] ?? settings.prompts?.[phase(role)] ?? '';
  const contract = role === 'plan'
    ? '只分析和规划，禁止实施、改文件或自行批准。最后输出 PR_CYCLE_RESULT:{"plan":"完整计划和验收条件","risk":"P0/P1/P2/P3","summary":"阶段摘要","children":[]}。P2 拆分时 children 每项包含 id,title,depends_on 数组,base_branch。其他等级不要组合多个子 PR。'
    : `${role.includes('implementation') ? '按已批准计划实施并自测，将本阶段变更提交到当前工作分支。可以通过看板启动已规划的实施子 Agent，禁止自我审查或自行合并。' : '你是独立审查者，只读核查提供的各工作区及精确版本。不要修改代码、不要启动实施 Agent，不要自行批准计划或合并。功能审查核对需求和测试证据；安全审查核对权限、输入及数据风险。'}\n最后输出 PR_CYCLE_RESULT:{"passed":true或false,"summary":"真实阶段摘要","details":"验收/测试或问题清单及证据"}。未完成、证据不足或有阻断问题必须 passed:false。`;
  return [template, contract, `任务：${runtime.task.title}\n${runtime.task.description ?? ''}`,
    `计划版本：${flow.revision}；等级：${flow.risk ?? '待规划'}\n${flow.plan}`,
    child ? `本次子任务：${JSON.stringify(child)}` : '',
    role === 'implementation' && flow.integration ? `本轮是集成返工，只修改并提交集成工作区 ${flow.integration.path}，保留原工作区。完成后将重新对集成版本进行两项独立审查。` : '',
    role === 'implementation' && flow.children.length ? '已规划子任务由看板独立启动。等待它们完成再提交主阶段结果；非发布子任务须将实际提交 merge 到主工作分支，保留提交祖先关系。' : '',
    `待检查版本和工作区：${JSON.stringify(snapshots)}`,
    `此前阶段证据：${JSON.stringify(flow.events.filter(e => e.action === 'record_result').slice(-5))}`].filter(Boolean).join('\n\n');
}

export function createWorkflowService({ config, backendHost, backendPort, command = workflowCommand, api: injectedApi,
  git = { gitSnapshot, createPr, createIntegrationPr, integratePrs, mergePr, runCommand } }) {
  const { gitSnapshot, createPr, createIntegrationPr, integratePrs, mergePr, runCommand } = git;
  const api = injectedApi ?? (async (route, body, method) => {
    const response = await fetch(`http://${backendHost}:${backendPort}${route}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.message || JSON.stringify(result.error_data) || `后端请求失败 ${response.status}`);
    return result.data;
  });
  let initialized;
  const pending = new Map();
  const state = payload => command(config, payload);
  async function initialize() {
    if (!initialized) initialized = command(config, {}, true).catch(error => { initialized = null; throw error; });
    return initialized;
  }
  async function exclusive(key, fn) {
    if (pending.has(key)) throw new Error('此任务的操作正在进行，请等待完成后刷新');
    const promise = fn(); pending.set(key, promise);
    try { return await promise; } finally { pending.delete(key); }
  }
  async function snapshot(runtime) {
    const bindings = runtime.workflow.sessions ?? [];
    const ids = [...new Set(bindings.filter(s => ['plan', 'implementation', 'implementation_child'].includes(s.role)).map(s => s.workspace_id))];
    if (!ids.length && runtime.workflow.workspace_id) ids.push(runtime.workflow.workspace_id);
    const items = await Promise.all(ids.map(async id => ({ workspace_id: id, ...await gitSnapshot(api, id) })));
    if (runtime.workflow.integration?.path) {
      const integration = runtime.workflow.integration;
      const head = (await runCommand('git', ['rev-parse', 'HEAD'], integration.path)).trim();
      const dirty = (await runCommand('git', ['status', '--porcelain'], integration.path)).trim();
      items.push({ ...integration, head_sha: head, dirty: Boolean(dirty) });
    }
    const published = runtime.workflow.children.filter(c => c.publish_pr !== false);
    const delivery = published.length === 1 ? items.find(i => i.workspace_id === published[0].workspace_id) : items.find(i => i.workspace_id === runtime.workflow.workspace_id);
    const head = runtime.workflow.integration?.path ? items.at(-1).head_sha : published.length < 2 ? delivery?.head_sha : createHash('sha256').update(JSON.stringify(items.map(i => [i.workspace_id ?? i.path, i.head_sha]).sort())).digest('hex');
    let invalid = null;
    const primary = items.find(i => i.workspace_id === runtime.workflow.workspace_id);
    const ancestry = runtime.workflow.integration?.path
      ? items.slice(0, -1).map(item => [item, items.at(-1)])
      : runtime.workflow.children.filter(c => c.publish_pr === false && c.completed).map(c => [items.find(i => i.workspace_id === c.workspace_id), primary]);
    if (!runtime.workflow.integration?.path && published.length === 1 && published[0].completed) ancestry.push([primary, delivery]);
    for (const [source, target] of ancestry) {
      try { await runCommand('git', ['merge-base', '--is-ancestor', source.head_sha, target.head_sha], target.path); }
      catch { invalid = '交付分支未包含所有 Agent 的当前提交，请返回实施合入后重新审查'; break; }
    }
    return { items, head_sha: head, dirty: items.some(item => item.dirty) || Boolean(invalid), invalid };
  }
  async function runtimeFor(payload) {
    const runtime = await state({ ...payload, action: 'runtime' });
    const view = await state({ action: 'read', project_id: payload.project_id });
    runtime.workflow = view.workflows.find(w => w.task_id === payload.task_id);
    runtime.settings = view.settings;
    return runtime;
  }
  async function updateProfiles(executor) {
    const original = JSON.parse((await api('/api/profiles')).content);
    const baseline = original.executors?.[executor]?.APPROVALS?.[executor] ?? original.executors?.[executor]?.DEFAULT?.[executor];
    if (!baseline?.base_command_override) throw new Error('请先运行启动器接入本机 CLI，再启动流程 Agent');
    const updated = structuredClone(original);
    for (const role of roles.filter(r => r !== 'implementation_child')) updated.executors[executor][variant(role)] = { [executor]: stageProfile(baseline, executor, role) };
    if (JSON.stringify(original) !== JSON.stringify(updated)) await api('/api/profiles', updated, 'PUT');
  }
  async function ensureProfiles(executor) {
    const result = profileUpdate.then(() => updateProfiles(executor));
    profileUpdate = result.catch(() => {});
    return result;
  }
  async function start(payload) {
    const role = payload.action === 'start_child' ? 'implementation_child' : payload.role;
    if (!roles.includes(role)) throw new Error('请选择规划、实施或独立审查阶段');
    if (role === 'plan') {
      await state({ ...payload, action: 'begin_plan' });
      await state({ ...payload, action: 'authorize_start' });
    }
    let runtime = await runtimeFor(payload);
    if (runtime.workflow.launch_intent) throw new Error('上次启动尚未完成对账，请恢复后继续');
    const flow = runtime.workflow;
    if (flow.stage !== phase(role)) throw new Error(`当前阶段是 ${flow.stage}，不能启动 ${role}`);
    const child = role === 'implementation_child' ? flow.children.find(c => c.id === payload.child_id) : null;
    if (role === 'implementation_child' && !child) throw new Error('只能启动已批准计划中的子任务');
    if (child && !child.depends_on.every(id => flow.children.find(c => c.id === id)?.completed)) throw new Error('依赖子任务尚未完成');
    const binding = flow.sessions.find(s => role === 'implementation' ? ['plan','implementation'].includes(s.role) : s.role === role && (!child || s.session_id === child.session_id));
    const priorSession = binding && runtime.sessions.find(s => s.id === binding.session_id);
    const executor = priorSession?.executor ?? payload.executor_profile_id?.executor ?? 'CLAUDE_CODE';
    if (executor !== 'CLAUDE_CODE') throw new Error('当前受控流程使用本机 Claude Code：规划和审查已限制为只读工具。Codex 的外部 MCP 工具隔离尚未验证，暂不用于此流程。');
    await ensureProfiles(executor);
    let workspaceId = binding?.workspace_id ?? (child ? child.workspace_id : flow.workspace_id);
    let sessionId = binding?.session_id;
    if (!workspaceId) {
      const repos = await api(`/api/projects/${payload.project_id}/repositories`);
      if (repos.length !== 1) throw new Error('当前流程需要项目绑定一个仓库；请先在项目设置中确认仓库');
      const repo = repos[0];
      const dependencies = child ? flow.children.filter(c => child.depends_on.includes(c.id)) : [];
      const dependencySnapshots = await Promise.all(dependencies.map(async c => {
        const info = await gitSnapshot(api, c.workspace_id);
        if (info.dirty || info.head_sha !== c.head_sha) throw new Error(`依赖 ${c.title} 已变化，需要先重新完成该子任务`);
        return info;
      }));
      const target = dependencySnapshots[0]?.branch || child?.base_branch || repo.default_target_branch || (await runCommand('git', ['branch', '--show-current'], repo.path)).trim();
      if (!target) throw new Error('仓库没有可用的目标分支');
      // The native initial launch is deliberately denied by the DB guard; its workspace is still created.
      const workspace = await api('/api/task-attempts', { task_id: payload.task_id, executor_profile_id: { executor, variant: variant(role) }, repos: [{ repo_id: repo.id, target_branch: target }] });
      workspaceId = workspace.id;
      if (dependencySnapshots.length) {
        const fresh = await gitSnapshot(api, workspaceId);
        if (fresh.head_sha !== dependencySnapshots[0].head_sha) throw new Error('创建子工作区期间依赖版本发生变化，请核对后重试');
        for (const dependency of dependencySnapshots.slice(1)) {
          try { await runCommand('git', ['merge', '--no-ff', '--no-edit', dependency.head_sha], fresh.path); }
          catch (error) {
            try { await runCommand('git', ['merge', '--abort'], fresh.path); } catch {}
            throw new Error(`子任务依赖合并冲突，保留工作区 ${fresh.path}：${error.message}`);
          }
        }
      }
      if (child) child.resolved_base_branch = target;
    }
    if (!sessionId) {
      const session = await api('/api/sessions', { workspace_id: workspaceId, executor });
      sessionId = session.id;
      await state({ ...payload, action: 'bind_session', role, workspace_id: workspaceId, session_id: sessionId, resolved_base_branch: child?.resolved_base_branch });
    }
    runtime = await runtimeFor(payload);
    const version = await snapshot(runtime);
    if (['functional', 'security'].includes(role) && (flow.head_sha !== version.head_sha || version.dirty)) {
      await state({ ...payload, action: 'invalidate', head_sha: version.head_sha, message: '代码已改变，旧审查失效，请按当前阶段重新验证' });
      throw new Error('代码已改变，已撤销旧审查，请刷新查看当前阶段');
    }
    const prompt = buildPrompt(role, runtime, runtime.settings, version.items, child);
    await state({ ...payload, action: 'prepare_launch', role, executor, workspace_id: workspaceId, session_id: sessionId,
      head_sha: version.head_sha, prompt, known_process_ids: runtime.processes.map(p => p.id) });
    try {
      const process = await api(`/api/sessions/${sessionId}/follow-up`, { prompt, executor_profile_id: { executor, variant: variant(role) }, perform_git_reset: false });
      await state({ ...payload, action: 'mark_run', role, session_id: sessionId, process_id: process.id, head_sha: version.head_sha, prompt });
    } catch (error) {
      await state({ ...payload, action: 'cancel_launch' });
      const recovery = await state({ ...payload, action: 'runtime' });
      const known = new Set(runtime.processes.map(p => p.id));
      const created = recovery.processes.filter(p => p.session_id === sessionId && !known.has(p.id));
      if (created.length === 1) {
        await state({ ...payload, action: 'mark_run', role, session_id: sessionId, process_id: created[0].id, head_sha: version.head_sha, prompt });
      } else {
        if (!created.length) await state({ ...payload, action: 'cancel_intent' });
        throw error;
      }
    }
  }
  async function reconcile(payload, retry = false) {
    let runtime = await runtimeFor(payload);
    const intent = runtime.workflow.launch_intent;
    if (!intent) return;
    // Revocation serializes with the SQLite insert guard, so a late native request cannot launch after this read.
    await state({ ...payload, action: 'cancel_launch' });
    runtime = await runtimeFor(payload);
    const created = runtime.processes.filter(p => p.run_reason === 'codingagent' && p.session_id === intent.session_id && !intent.known_process_ids.includes(p.id));
    if (created.length === 1 && intent.revision === runtime.workflow.revision) {
      await state({ ...payload, ...intent, action: 'mark_run', process_id: created[0].id });
    } else if (!created.length && retry) await state({ ...payload, action: 'cancel_intent' });
    else throw new Error('启动中断后尚不能确认唯一执行，已暂停；请恢复以核对并重试，禁止重复派发');
  }
  async function collect(payload) {
    let runtime = await runtimeFor(payload);
    for (const run of runtime.workflow.runs ?? []) {
      if (runtime.workflow.events.some(e => ['save_plan', 'record_result', 'record_child_result', ...(payload.retry_result ? [] : ['error'])].includes(e.action) && e.process_id === run.process_id)) continue;
      const process = runtime.processes.find(p => p.id === run.process_id);
      if (!process || process.status === 'running') continue;
      try {
        if (process.status !== 'completed' || process.exit_code !== 0) throw new Error(`Agent 执行未成功（${process.status}，退出码 ${process.exit_code}），请查看会话后重试`);
        const logs = await state({ ...payload, action: 'runtime', process_id: run.process_id });
        const result = extractResult(logs.logs ?? '');
        const evidence = { session_id: run.session_id, process_id: run.process_id, role: run.role };
        if (run.role === 'plan') {
          await state({ ...payload, action: 'save_plan', ...evidence, expected_revision: run.revision, plan: result.plan, risk: result.risk,
            children: result.children ?? [], summary: result.summary });
        } else {
          const version = await snapshot(runtime);
          const child = run.role === 'implementation_child' && runtime.workflow.children.find(c => c.id === run.child_id);
          const childVersion = child && version.items.find(item => item.workspace_id === child.workspace_id);
          if (run.role === 'implementation' && result.passed && runtime.workflow.children.some(c => !c.completed)) continue;
          if (version.dirty && ['functional', 'security'].includes(run.role)) {
            await state({ ...payload, action: 'invalidate', head_sha: version.head_sha, message: '审查期间出现未提交变更，请返回实施并提交' });
            throw new Error('审查期间出现未提交变更，请返回实施并提交');
          }
          if ((child ? childVersion?.dirty : version.dirty) && result.passed) throw new Error((!child && version.invalid) || 'Agent 声称完成，但工作区仍有未提交变更；请继续实施并提交后再审查');
          if (['functional', 'security'].includes(run.role) && version.head_sha !== run.head_sha) {
            await state({ ...payload, action: 'invalidate', head_sha: version.head_sha, message: '审查期间代码变化，旧审查已撤销' });
            throw new Error('审查期间代码发生变化，需要重新实施确认并审查当前版本');
          }
          const childHead = childVersion?.head_sha;
          await state({ ...payload, action: child ? 'record_child_result' : 'record_result', ...evidence, child_id: run.child_id, head_sha: childHead || version.head_sha,
            passed: result.passed, summary: result.summary, details: result.details ?? '' });
        }
      } catch (error) { await state({ ...payload, action: 'error', process_id: run.process_id, message: error.message }); }
      runtime = await runtimeFor(payload);
    }
  }
  async function publication(payload) {
    const runtime = await runtimeFor(payload);
    const flow = runtime.workflow;
    const version = await snapshot(runtime);
    if (version.dirty || flow.head_sha !== version.head_sha) {
      await state({ ...payload, action: 'invalidate', head_sha: version.head_sha, message: '代码或工作区变化，需重新验证和审查' });
      throw new Error('代码版本或工作区发生变化，已撤销旧审查，请刷新后按当前阶段继续');
    }
    for (const role of ['functional', 'security']) if (!flow[role]?.passed || flow[role].head_sha !== flow.head_sha) throw new Error('当前版本尚未通过两项独立审查');
    if (payload.action === 'create_pr') {
      if (flow.stage !== 'pr') throw new Error('当前阶段不允许创建 PR');
      if (flow.integration) {
        const pr = await createIntegrationPr(version.items.at(-1), { title: runtime.task.title, body: flow.plan, head_sha: flow.head_sha });
        await state({ ...payload, action: 'record_pr', url: pr.url, head_sha: pr.head_sha, base_branch: pr.base_branch });
        return;
      }
      const publicationChildren = flow.children.filter(c => c.publish_pr !== false);
      const child = payload.child_id && publicationChildren.find(c => c.id === payload.child_id);
      if (publicationChildren.length && !child) throw new Error('请选择已规划的子 PR');
      const workspace = child?.workspace_id ?? flow.workspace_id;
      const actual = version.items.find(i => i.workspace_id === workspace);
      const base = child?.resolved_base_branch ?? child?.base_branch ?? actual.target_branch;
      if (payload.base_branch && payload.base_branch !== base) throw new Error('PR 目标分支与已批准计划或工作区不一致');
      const pr = await createPr(api, workspace, { title: child?.title ?? runtime.task.title, body: flow.plan, head_sha: actual.head_sha, target_branch: base, draft: false });
      await state({ ...payload, action: 'record_pr', url: pr.url, head_sha: pr.head_sha, base_branch: pr.base_branch });
    } else if (payload.action === 'integrate') {
      if (flow.stage !== 'integration' || flow.risk !== 'P2') throw new Error('只有已完成子 PR 的 P2 任务可以集成');
      const children = flow.prs.filter(p => p.child_id).map(p => ({ ...p, id: p.child_id, depends_on: flow.children.find(c => c.id === p.child_id)?.depends_on ?? [] }));
      const result = await integratePrs(api, flow.workspace_id, { children,
        integrationBranch: `pr-cycle/integration/${payload.task_id}-${flow.revision}`, baseBranch: version.items[0].target_branch.replace(/^origin\//, ''),
        runtimeRoot: fileURLToPath(new URL('../../../.pr-cycle-runtime', import.meta.url)) });
      await state({ ...payload, action: 'record_integration', ...result });
    } else if (payload.action === 'human_approve') {
      if (payload.head_sha !== flow.head_sha) throw new Error('请刷新后批准当前候选版本');
      await state(payload);
    } else if (payload.action === 'merge') {
      if (flow.stage !== 'human' || flow.human_approval?.head_sha !== flow.head_sha) throw new Error('合并前需要人类批准当前版本');
      const url = flow.integration?.pr_url ?? flow.prs[0]?.url;
      const singleChild = flow.children.filter(c => c.publish_pr !== false);
      const target = flow.integration ? version.items.at(-1) : version.items.find(i => i.workspace_id === (singleChild.length === 1 ? singleChild[0].workspace_id : flow.workspace_id));
      const merged = await mergePr(url, { ...target, target_branch: target.base_branch ?? target.target_branch }, { approvedHeadSha: target.head_sha });
      if (!merged) throw new Error('尚未确认远程合并完成');
      await state({ ...payload, action: 'complete', head_sha: flow.head_sha, merged: true });
    }
  }
  async function dispatch(payload) {
    await initialize();
    if (!publicActions.has(payload.action)) throw new Error('不允许直接写入执行或审查结果');
    return exclusive(payload.task_id ?? payload.project_id, async () => {
      if (payload.action === 'start' || payload.action === 'start_child') await start(payload);
      else if (payload.action === 'collect') await collect(payload);
      else if (['create_pr', 'integrate', 'human_approve', 'merge'].includes(payload.action)) await publication(payload);
      else {
        await state(payload);
        if (payload.action === 'approve_plan') await state({ ...payload, action: 'authorize_start' });
        if (payload.action === 'resume') {
          await reconcile(payload, true);
          await collect({ ...payload, retry_result: true });
          let runtime = await runtimeFor(payload);
          if (runtime.workflow.error && !runtime.processes.some(p => p.status === 'running')) {
            await state(payload);
            runtime = await runtimeFor(payload);
          }
          if (runtime.workflow.stage === 'plan' && runtime.workflow.plan_revision !== runtime.workflow.revision && !runtime.processes.some(p => p.status === 'running')) await start({ ...payload, action: 'start', role: 'plan' });
        }
      }
      return state({ action: 'read', project_id: payload.project_id });
    });
  }
  async function read(projectId) {
    await initialize();
    const view = await state({ action: 'read', project_id: projectId });
    for (const flow of view.workflows) {
      if (!pending.has(flow.task_id) && (flow.runs?.length || flow.launch_intent)) await exclusive(flow.task_id, async () => {
        const payload = { project_id: projectId, task_id: flow.task_id };
        try { await reconcile(payload); await collect(payload); }
        catch (error) { await state({ ...payload, action: 'error', message: error.message }); }
      });
    }
    return state({ action: 'read', project_id: projectId });
  }
  let ticking = false, timer;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      await initialize();
      const tasks = await state({ action: 'list_automated' });
      let slots = 3 - await state({ action: 'running_count' });
      for (const task of tasks) {
        if (pending.has(task.task_id)) continue;
        await exclusive(task.task_id, async () => {
          try {
            await reconcile(task);
            await collect(task);
            const runtime = await runtimeFor(task), flow = runtime.workflow;
            if (!flow.automation?.enabled || flow.automation.paused || flow.error) return;
            const active = runtime.processes.filter(p => p.status === 'running' && p.run_reason === 'codingagent');
            if (['human', 'done', 'cancelled'].includes(flow.stage)) return;
            if (flow.stage === 'plan') {
              if (flow.plan_revision !== flow.revision && !active.length && slots > 0) {
                await start({ ...task, action: 'start', role: 'plan' }); slots--;
              }
              return;
            }
            if (flow.stage === 'implementation' && !active.length) {
              const sinceResume = flow.events.slice(flow.events.findLastIndex(e => e.action === 'resume') + 1);
              const failed = sinceResume.filter(e => e.revision === flow.revision && e.action === 'record_result' && e.passed === false).length;
              if (failed >= 3) throw new Error('连续三轮返工尚未通过，已暂停自动执行，请检查问题后恢复');
            }
            if (['implementation', 'functional', 'security'].includes(flow.stage)) {
              if (slots <= 0) return;
              if (flow.stage === 'implementation' && flow.children.some(c => !c.completed)) {
                for (const child of flow.children) {
                  if (slots <= 0) break;
                  if (child.completed || active.some(p => p.session_id === child.session_id) || !child.depends_on.every(id => flow.children.find(c => c.id === id)?.completed)) continue;
                  const sinceResume = flow.events.slice(flow.events.findLastIndex(e => e.action === 'resume') + 1);
                  if (sinceResume.filter(e => e.revision === flow.revision && e.action === 'record_child_result' && e.child_id === child.id && e.passed === false).length >= 3)
                    throw new Error(`子任务 ${child.title} 连续三轮未通过，已暂停自动执行，请检查后恢复`);
                  await start({ ...task, action: 'start_child', child_id: child.id });
                  slots--;
                }
              } else if (!active.length) {
                await start({ ...task, action: 'start', role: flow.stage });
                slots--;
              }
            } else if (!active.length && flow.stage === 'pr') {
              const published = flow.children.filter(c => c.publish_pr !== false);
              const child = !flow.integration && published.find(c => !flow.prs.some(p => p.child_id === c.id && !p.stale && p.head_sha === c.head_sha) &&
                c.depends_on.every(id => flow.prs.some(p => p.child_id === id && !p.stale)));
              if (published.length && !flow.integration && !child) throw new Error('找不到可发布的子 PR，请核对依赖和当前版本');
              await publication({ ...task, action: 'create_pr', ...(child ? { child_id: child.id } : {}) });
            } else if (!active.length && flow.stage === 'integration') await publication({ ...task, action: 'integrate' });
          } catch (error) {
            await state({ ...task, action: 'error', message: error.message });
          }
        });
      }
    } finally { ticking = false; }
  }
  function startScheduler() {
    if (timer) return;
    timer = setInterval(() => { void tick().catch(error => console.error('Workflow scheduler:', error.message)); }, 5000);
    timer.unref();
  }
  function stopScheduler() { clearInterval(timer); timer = undefined; }
  return { dispatch, read, initialize, tick, startScheduler, stopScheduler };
}

export async function handleWorkflowRequest(req, res, service) {
  const send = (status, result) => res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(result));
  try {
    let data;
    if (req.method === 'GET') data = await service.read(new URL(req.url, 'http://localhost').searchParams.get('project_id'));
    else if (req.method === 'POST') {
      if (req.headers.origin !== `http://${req.headers.host}`) return send(403, { success: false, message: '请从本机看板操作工作流' });
      if (!req.headers['content-type']?.startsWith('application/json')) return send(415, { success: false, message: 'Expected application/json' });
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 262144) return send(413, { success: false, message: '请求内容过大' }); chunks.push(chunk); }
      data = await service.dispatch(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } else return send(405, { success: false, message: 'Method not allowed' });
    send(200, { success: true, data });
  } catch (error) { send(400, { success: false, message: error.message }); }
}
