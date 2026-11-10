import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  runCommand, gitSnapshot, verifyPr, createPr, orderChildren, integratePrs, mergePr, createIntegrationPr,
} from '../skills/pr-cycle/scripts/workflow-git.mjs';

const head = 'a'.repeat(40), second = 'b'.repeat(40), combined = 'c'.repeat(40);
const snapshot = { head_sha: head, path: path.resolve('workspace'), branch: 'feature', target_branch: 'main', dirty: false };
const url = 'https://github.com/acme/repo/pull/1';
const pr = { url, headRefOid: head, headRefName: 'feature', baseRefName: 'main', state: 'OPEN', mergeCommit: null };
function mockRun(overrides = {}) {
  const calls = [];
  const run = async (command, args, cwd) => {
    calls.push({ command, args, cwd });
    if (overrides.handle) {
      const result = await overrides.handle(command, args, cwd);
      if (result !== undefined) return result;
    }
    if (command === 'git' && args[0] === 'remote') return 'git@github.com:acme/repo.git';
    if (command === 'gh' && args[0] === 'repo') return JSON.stringify({ nameWithOwner: 'acme/repo', url: 'https://github.com/acme/repo' });
    if (command === 'gh' && args[1] === 'view') return JSON.stringify(overrides.pr ?? pr);
    if (command === 'git' && args[0] === 'rev-parse') return args[1] === 'FETCH_HEAD' ? second : combined;
    return '';
  };
  return { run, calls };
}
function mockApi(overrides = {}) {
  const calls = [];
  const api = async (route, body) => {
    calls.push({ route, body });
    if (route.endsWith('/branch-status')) return overrides.states ?? [{ repo_id: 'repo', head_oid: head, has_uncommitted_changes: false, untracked_count: 0, target_branch_name: 'main', conflicted_files: [] }];
    if (route.endsWith('/repos')) return overrides.repos ?? [{ id: 'repo', name: 'repo' }];
    if (route.endsWith('/pr')) return url;
    return { container_ref: path.resolve('native'), branch: 'feature' };
  };
  return { api, calls };
}

test('commands preserve shell syntax as a literal argument and report nonzero exit', async () => {
  const literal = '$(whoami); echo unsafe & exit 0';
  assert.equal(await runCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', literal], process.cwd()), literal);
  await assert.rejects(runCommand(process.execPath, ['-e', 'process.stderr.write("broken"); process.exit(7)'], process.cwd()), (error) => error.exitCode === 7 && /broken/.test(error.message));
});

test('snapshot refuses ambiguous repositories, unknown cleanliness and escaped paths', async () => {
  assert.equal((await gitSnapshot(mockApi().api, 'ws')).head_sha, head);
  await assert.rejects(gitSnapshot(mockApi({ repos: [{ id: 'repo', name: 'repo' }, { id: 'other' }] }).api, 'ws'), /单仓库/);
  await assert.rejects(gitSnapshot(mockApi({ repos: [{ id: 'repo', name: '..' }] }).api, 'ws'), /路径/);
  await assert.rejects(gitSnapshot(mockApi({ states: [{ repo_id: 'repo', head_oid: head }] }).api, 'ws'), /干净/);
});

test('PR verification checks origin, actual head, source branch and target branch', async () => {
  assert.equal((await verifyPr(url, snapshot, mockRun())).head_sha, head);
  await assert.rejects(verifyPr('https://github.com/other/repo/pull/1', snapshot, mockRun()), /origin/);
  await assert.rejects(verifyPr(url + '?x=1', snapshot, mockRun()), /origin/);
  await assert.rejects(verifyPr(url, snapshot, mockRun({ pr: { ...pr, headRefOid: second } })), /HEAD/);
  await assert.rejects(verifyPr(url, snapshot, mockRun({ pr: { ...pr, baseRefName: 'production' } })), /目标/);
  await assert.rejects(verifyPr(url, snapshot, mockRun({ pr: { ...pr, headRefName: 'other' } })), /来源/);
});

test('PR creation pushes the exact reviewed SHA without native follow-up or mutable branch publication', async () => {
  const { api, calls } = mockApi();
  const mock = mockRun({ handle(command,args) {
    if (command==='git' && args[0]==='rev-parse') return head;
    if (command==='gh' && args[1]==='list') return JSON.stringify([{url}]);
  } });
  await createPr(api, 'ws', { title: 'change', head_sha: head }, mock);
  assert.equal(calls.some(call => call.route.endsWith('/pr')), false);
  assert.ok(mock.calls.some(call => call.args.includes(`${head}:refs/heads/feature`)));
  const other = mockApi();
  await assert.rejects(createPr(other.api, 'ws', { title: 'change', head_sha: second }, mockRun()), /HEAD/);
  assert.equal(other.calls.some((call) => call.body), false);
});

test('child dependency sort detects missing dependencies, duplicates and cycles', () => {
  const children = [{ id: 'b', depends_on: ['a'] }, { id: 'a' }];
  assert.deepEqual(orderChildren(children).map((child) => child.id), ['a', 'b']);
  assert.throws(() => orderChildren([{ id: 'a' }, { id: 'a' }]), /重复/);
  assert.throws(() => orderChildren([{ id: 'a', depends_on: ['b'] }, { id: 'b', depends_on: ['a'] }]), /循环/);
  assert.throws(() => orderChildren([{ id: 'a', depends_on: ['missing'] }, { id: 'b' }]), /缺少/);
});

test('integration uses exact reviewed SHAs in an isolated branch and requires fresh review', async () => {
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'workflow-integration-'));
  try {
    const { run, calls } = mockRun({ handle(command, args) {
      if (command === 'gh' && args[1] === 'view' && args[2].endsWith('/2')) return JSON.stringify({ ...pr, url: url.replace('/1', '/2'), headRefOid: second, headRefName: 'feature-b', baseRefName: 'feature' });
    } });
    const result = await integratePrs(mockApi().api, 'ws', {
      integrationBranch: 'pr-cycle/integration/batch', runtimeRoot: runtime,
      children: [{ id: 'b', url: url.replace('/1', '/2'), head_sha: second, depends_on: ['a'] }, { id: 'a', url, head_sha: head }],
    }, { run });
    assert.equal(result.head_sha, combined);
    assert.equal(result.requires_review, true);
    assert.deepEqual(calls.filter((call) => call.args[0] === 'merge').map((call) => call.args.at(-1)), [head, head, second]);
    assert.ok(calls.filter((call) => call.args[0] === 'merge').every((call) => call.cwd.startsWith(path.join(runtime, 'integrations'))));
    assert.equal(calls.some((call) => call.args.includes('--force')), false);
  } finally { await rm(runtime, { recursive: true, force: true }); }
});

test('integration conflict aborts only its own merge and never reports success', async () => {
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'workflow-conflict-'));
  try {
    const { run, calls } = mockRun({ handle(command, args) {
      if (command === 'git' && args[0] === 'merge' && args[1] === '--no-ff') throw new Error('conflict');
      if (command === 'gh' && args[1] === 'view' && args[2].endsWith('/2')) return JSON.stringify({ ...pr, url: url.replace('/1', '/2') });
    } });
    await assert.rejects(integratePrs(mockApi().api, 'ws', { integrationBranch: 'pr-cycle/integration/conflict', runtimeRoot: runtime,
      children: [{ id: 'a', url, head_sha: head }, { id: 'b', url: url.replace('/1', '/2'), head_sha: head }],
    }, { run }), /集成失败/);
    assert.equal(calls.filter((call) => call.args[0] === 'merge' && call.args[1] === '--abort').length, 1);
    await assert.rejects(integratePrs(mockApi().api, 'ws', { integrationBranch: 'pr-cycle/integration/conflict', runtimeRoot: runtime,
      children: [{ id: 'a', url, head_sha: head }, { id: 'b', url: url.replace('/1', '/2'), head_sha: head }],
    }, { run }), /集成失败/);
    const branches = calls.filter(call => call.args[0] === 'worktree').map(call => call.args[3]);
    assert.equal(new Set(branches).size, 2);
  } finally { await rm(runtime, { recursive: true, force: true }); }
});

test('merge requires exact approval and confirms actual merged state after command', async () => {
  const reject = mockRun();
  await assert.rejects(mergePr(url, snapshot, { ...reject, approvedHeadSha: second }), /人类批准/);
  assert.equal(reject.calls.length, 0);
  await assert.rejects(mergePr(url, snapshot, { ...mockRun(), approvedHeadSha: head }), /尚未实际合并/);
  let merged = false;
  const { run, calls } = mockRun({ handle(command, args) {
    if (command === 'gh' && args[1] === 'merge') merged = true;
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'view' && merged) return JSON.stringify({ ...pr, state: 'MERGED', mergeCommit: { oid: combined } });
  } });
  assert.equal((await mergePr(url, snapshot, { run, approvedHeadSha: head })).merge_sha, combined);
  const args = calls.find((call) => call.command === 'gh' && call.args[1] === 'merge').args;
  assert.deepEqual(args.slice(-2), ['--match-head-commit', head]);
  assert.equal(args.some((arg) => ['--admin', '--auto', '--delete-branch'].includes(arg)), false);
  const recovered = mockRun({ pr: { ...pr, state: 'MERGED', mergeCommit: { oid: combined } } });
  assert.equal((await mergePr(url, snapshot, { ...recovered, approvedHeadSha: head })).merged, true);
  assert.equal(recovered.calls.some((call) => call.args[1] === 'merge'), false);
});

test('aggregate PR publication checks clean reviewed HEAD and reuses existing remote PR', async () => {
  const integration = { ...snapshot, head_sha: combined, branch: 'pr-cycle/integration/batch', base_branch: 'main' };
  const { run, calls } = mockRun({ handle(command, args) {
    if (command === 'gh' && args[1] === 'list') return JSON.stringify([{ url }]);
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ ...pr, headRefOid: combined, headRefName: integration.branch });
  } });
  assert.equal((await createIntegrationPr(integration, { title: 'batch', head_sha: combined }, { run })).head_sha, combined);
  assert.equal(calls.filter((call) => call.args[0] === 'push').length, 1);
  assert.equal(calls.some((call) => call.args[1] === 'create'), false);
  const dirty = mockRun({ handle(command, args) { if (command === 'git' && args[0] === 'status') return ' M changed'; } });
  await assert.rejects(createIntegrationPr(integration, { title: 'batch', head_sha: combined }, dirty), /发生变化/);
  assert.equal(dirty.calls.some((call) => call.args[0] === 'push'), false);
});
