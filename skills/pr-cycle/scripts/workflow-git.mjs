import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const shaPattern = /^[a-f0-9]{40,64}$/i;
function requireSha(value) {
  if (!shaPattern.test(value ?? '')) throw new Error('缺少有效的 Git 提交 SHA');
  return value;
}

export function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', size = 0, failure;
    const stop = (message) => {
      failure ??= new Error(message);
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const timer = setTimeout(() => stop(`${command} 执行超时；请核对外部操作结果后重试`), 120000);
    for (const [stream, capture] of [[child.stdout, (s) => { stdout += s; }], [child.stderr, (s) => { stderr += s; }]]) {
      stream.setEncoding('utf8').on('data', (chunk) => {
        size += Buffer.byteLength(chunk);
        if (size > 4 * 1024 * 1024) stop(`${command} 输出超过限制`);
        else capture(chunk);
      });
    }
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure || code !== 0) {
        const error = failure ?? new Error(`${command} 失败：${stderr.trim() || stdout.trim() || code}`);
        error.exitCode = code;
        error.stderr = stderr;
        reject(error);
      } else resolve(stdout.trim());
    });
  });
}

export async function gitSnapshot(api, workspaceId) {
  const [workspace, states, repos] = await Promise.all([
    api(`/api/task-attempts/${workspaceId}`),
    api(`/api/task-attempts/${workspaceId}/branch-status`),
    api(`/api/task-attempts/${workspaceId}/repos`),
  ]);
  // shortcut: PR orchestration supports one repository, add per-repository approvals before multi-repo merging.
  if (states.length !== 1 || repos.length !== 1) throw new Error('PR 工作流暂仅支持单仓库工作区；请按仓库拆分任务');
  const state = states[0], repo = repos[0];
  if (state.repo_id !== repo.id || !workspace.container_ref) throw new Error('工作区仓库信息不完整');
  const root = path.resolve(workspace.container_ref), location = path.resolve(root, repo.name);
  if (!location.startsWith(root + path.sep)) throw new Error('工作区仓库路径不合法');
  if (state.has_uncommitted_changes == null || state.untracked_count == null) throw new Error('无法确认工作区是否干净');
  return {
    head_sha: requireSha(state.head_oid), repo_id: repo.id, path: location,
    branch: workspace.branch, target_branch: state.target_branch_name,
    dirty: Boolean(state.has_uncommitted_changes || state.untracked_count || state.is_rebase_in_progress || state.conflicted_files?.length),
  };
}

async function originRepository(snapshot, run) {
  const remote = (await run('git', ['remote', 'get-url', 'origin'], snapshot.path)).trim();
  const ssh = remote.match(/^git@([^:]+):(.+)$/);
  const parsed = new URL(ssh ? `https://${ssh[1]}/${ssh[2]}` : remote);
  if (!['https:', 'ssh:'].includes(parsed.protocol) || (parsed.protocol === 'https:' && (parsed.username || parsed.password))) throw new Error('仅支持 GitHub HTTPS/SSH origin 仓库');
  const slug = parsed.pathname.replace(/^\//, '').replace(/\.git$/, '').replace(/\/$/, '');
  if (!/^[^/]+\/[^/]+$/.test(slug)) throw new Error('无法识别 origin 仓库');
  const repository = JSON.parse(await run('gh', ['repo', 'view', `${parsed.hostname}/${slug}`, '--json', 'nameWithOwner,url'], snapshot.path));
  const canonical = new URL(repository.url);
  if (canonical.hostname.toLowerCase() !== parsed.hostname.toLowerCase() || repository.nameWithOwner.toLowerCase() !== slug.toLowerCase()) throw new Error('GitHub 仓库与 origin 不一致');
  return { url: canonical.origin + '/' + repository.nameWithOwner, name: `${canonical.hostname}/${repository.nameWithOwner}` };
}

const prFields = 'headRefOid,baseRefName,headRefName,state,url,mergeCommit';
export async function verifyPr(url, snapshot, { run = runCommand } = {}) {
  requireSha(snapshot.head_sha);
  const repository = await originRepository(snapshot, run);
  const expected = new URL(repository.url), candidate = new URL(url);
  if (candidate.protocol !== 'https:' || candidate.username || candidate.password || candidate.search || candidate.hash ||
      candidate.origin.toLowerCase() !== expected.origin.toLowerCase() ||
      !candidate.pathname.toLowerCase().startsWith(expected.pathname.toLowerCase() + '/pull/') ||
      !/^\d+$/.test(candidate.pathname.slice(expected.pathname.length + 6))) throw new Error('PR 不属于当前 origin 仓库');
  const pr = JSON.parse(await run('gh', ['pr', 'view', candidate.href, '--repo', repository.name, '--json', prFields], snapshot.path));
  if (pr.url.toLowerCase() !== candidate.href.toLowerCase()) throw new Error('GitHub 返回了其他 PR');
  if (pr.headRefOid !== snapshot.head_sha) throw new Error('PR HEAD 已改变，必须重新审查');
  if (snapshot.branch && pr.headRefName !== snapshot.branch) throw new Error('PR 来源分支与工作区不一致');
  if (snapshot.target_branch && pr.baseRefName !== snapshot.target_branch.replace(/^origin\//, '')) throw new Error('PR 目标分支已改变，必须重新确认计划');
  return { ...pr, repository: repository.name, head_sha: pr.headRefOid, base_branch: pr.baseRefName };
}

export async function createPr(api, workspaceId, input, { run = runCommand } = {}) {
  const snapshot = await gitSnapshot(api, workspaceId);
  if (snapshot.dirty) throw new Error('工作区存在未提交修改，不能创建已审查 PR');
  if (input.head_sha !== snapshot.head_sha) throw new Error('工作区 HEAD 与审查版本不同');
  const target = input.target_branch ?? snapshot.target_branch;
  if (target !== snapshot.target_branch) throw new Error('PR 目标必须与已规划的工作区目标一致');
  return publishPr({ ...snapshot, base_branch: target }, input, { run });
}

export function orderChildren(children) {
  if (!Array.isArray(children) || children.length < 2) throw new Error('集成至少需要两个已审查子 PR');
  const byId = new Map();
  for (const child of children) {
    const id = child.id ?? child.url;
    if (!id || byId.has(id) || !Array.isArray(child.depends_on ?? [])) throw new Error('子 PR 标识重复或依赖格式错误');
    byId.set(id, child);
  }
  const result = [], visiting = new Set(), done = new Set();
  function visit(id) {
    if (done.has(id)) return;
    if (visiting.has(id)) throw new Error('子 PR 依赖存在循环');
    const child = byId.get(id);
    if (!child) throw new Error(`缺少依赖子 PR：${id}`);
    visiting.add(id);
    for (const dependency of child.depends_on ?? []) visit(dependency);
    visiting.delete(id); done.add(id); result.push(child);
  }
  for (const id of byId.keys()) visit(id);
  return result;
}

export async function integratePrs(api, workspaceId, input, { run = runCommand } = {}) {
  const snapshot = await gitSnapshot(api, workspaceId), ordered = orderChildren(input.children);
  if (snapshot.dirty) throw new Error('主工作区有未提交修改，先完成实施再集成');
  const base = input.baseBranch ?? snapshot.target_branch.replace(/^origin\//, '');
  const branch = `${input.integrationBranch}/${randomUUID()}`;
  if (typeof branch !== 'string' || !branch.startsWith('pr-cycle/integration/') || branch === base) throw new Error('集成分支必须位于 pr-cycle/integration/，不能是目标分支');
  if (typeof base !== 'string' || base.startsWith('-')) throw new Error('无效目标分支');
  await run('git', ['check-ref-format', '--branch', branch], snapshot.path);
  await run('git', ['check-ref-format', '--branch', base], snapshot.path);
  const verified = [];
  for (const child of ordered) {
    const pr = await verifyPr(child.url, { ...snapshot, head_sha: requireSha(child.head_sha), branch: child.branch, target_branch: child.base_branch }, { run });
    if (pr.state !== 'OPEN') throw new Error('集成子 PR 必须处于打开状态');
    const allowedBases = new Set([base, branch, ...verified.filter((p) => (child.depends_on ?? []).includes(p.id)).map((p) => p.headRefName)]);
    if (!allowedBases.has(pr.baseRefName)) throw new Error('子 PR 目标分支与依赖计划不符');
    verified.push({ ...pr, id: child.id ?? child.url });
  }
  await run('git', ['fetch', '--no-tags', 'origin', base], snapshot.path);
  const baseSha = requireSha(await run('git', ['rev-parse', 'FETCH_HEAD'], snapshot.path));
  for (const pr of verified) await run('git', ['fetch', '--no-tags', 'origin', pr.head_sha], snapshot.path);
  const root = path.resolve(input.runtimeRoot ?? '.pr-cycle-runtime', 'integrations');
  await mkdir(root, { recursive: true });
  const location = path.join(root, randomUUID());
  await run('git', ['worktree', 'add', '-b', branch, location, baseSha], snapshot.path);
  try {
    // The primary agent may own shared changes absent from the child PRs.
    await run('git', ['merge', '--no-ff', '--no-edit', snapshot.head_sha], location);
    for (const pr of verified) {
      await run('git', ['merge', '--no-ff', '--no-edit', pr.head_sha], location);
      await run('git', ['merge-base', '--is-ancestor', pr.head_sha, 'HEAD'], location);
    }
  } catch (error) {
    // Abort only a merge in the worktree created by this operation; preserve it for diagnosis.
    try {
      await run('git', ['rev-parse', '--verify', 'MERGE_HEAD'], location);
      await run('git', ['merge', '--abort'], location);
    } catch {}
    throw new Error(`集成失败，保留工作区 ${location}：${error.message}`);
  }
  const head = requireSha(await run('git', ['rev-parse', 'HEAD'], location));
  return { head_sha: head, path: location, branch, base_branch: base, base_sha: baseSha,
    children: verified.map((pr) => ({ id: pr.id, url: pr.url, head_sha: pr.head_sha })), requires_review: true };
}

export async function mergePr(url, snapshot, { approvedHeadSha, run = runCommand } = {}) {
  if (snapshot.dirty || approvedHeadSha !== requireSha(snapshot.head_sha)) throw new Error('必须由人类批准当前干净的 HEAD 才能合并');
  const before = await verifyPr(url, snapshot, { run });
  if (before.state === 'MERGED' && before.mergeCommit?.oid) return { ...before, merged: true, merge_sha: requireSha(before.mergeCommit.oid) };
  if (before.state !== 'OPEN') throw new Error('PR 不处于打开状态，先核对远程结果');
  await run('gh', ['pr', 'merge', url, '--repo', before.repository, '--merge', '--match-head-commit', approvedHeadSha], snapshot.path);
  const after = await verifyPr(url, snapshot, { run });
  if (after.state !== 'MERGED' || !after.mergeCommit?.oid) throw new Error('PR 尚未实际合并（可能在等待检查或合并队列），不能标记完成');
  return { ...after, merged: true, merge_sha: requireSha(after.mergeCommit.oid) };
}

export async function createIntegrationPr(snapshot, input, { run = runCommand } = {}) {
  if (!snapshot.branch?.startsWith('pr-cycle/integration/')) throw new Error('需要已复审的集成分支及精确 HEAD');
  return publishPr(snapshot, input, { run });
}

async function publishPr(snapshot, input, { run }) {
  const head = requireSha(snapshot.head_sha), base = snapshot.base_branch ?? snapshot.target_branch;
  if (input.head_sha !== head) throw new Error('需要已审查的精确 HEAD');
  if (await run('git', ['rev-parse', 'HEAD'], snapshot.path) !== head ||
      await run('git', ['status', '--porcelain'], snapshot.path)) throw new Error('集成工作区发生变化，必须重新复审');
  await run('git', ['check-ref-format', '--branch', snapshot.branch], snapshot.path);
  await run('git', ['check-ref-format', '--branch', base], snapshot.path);
  const repository = await originRepository(snapshot, run);
  await run('git', ['push', 'origin', `${head}:refs/heads/${snapshot.branch}`], snapshot.path);
  const existing = JSON.parse(await run('gh', ['pr', 'list', '--repo', repository.name, '--state', 'open', '--head', snapshot.branch, '--base', base, '--json', 'url'], snapshot.path));
  if (existing.length > 1) throw new Error('集成分支对应多个 PR，请先核对远程状态');
  let url = existing[0]?.url;
  if (!url) {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'pr-cycle-pr-'));
    try {
      const filename = path.join(temporary, 'body.md');
      await writeFile(filename, input.body ?? '', 'utf8');
      url = await run('gh', ['pr', 'create', '--repo', repository.name, '--head', snapshot.branch, '--base', base,
        '--title', input.title, '--body-file', filename], snapshot.path);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  const pr = await verifyPr(url, { ...snapshot, target_branch: base }, { run });
  if (pr.state !== 'OPEN') throw new Error('集成 PR 未处于打开状态');
  return pr;
}
