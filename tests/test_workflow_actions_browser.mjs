import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { copyFile, writeFile, readFile, access, rm } from 'node:fs/promises';
import path from 'node:path';
import { startFixture, ids } from './kanban-ui/tracking-fixture.mjs';

const root = process.cwd();
const require = createRequire(path.join(root, '.pr-cycle-runtime/ui-tests/package.json'));
const { chromium } = require('playwright');
const { commit } = JSON.parse(await readFile('skills/pr-cycle/assets/runtime.lock.json', 'utf8'));
const frontend = path.join(root, `.pr-cycle-runtime/vibe-kanban-${commit}/frontend`);
const harness = path.join(frontend, 'src/components/tasks/WorkflowBoardHarness.tsx');
const html = path.join(frontend, 'workflow-board-test.html');
for (const file of [harness, html]) {
  if (await access(file).then(() => true, () => false)) throw new Error(`Test fixture already exists: ${file}`);
}
let fixture, vite, browser, page;
let restarting = false;
let flow;
const actions = [];
const prompts = { plan: 'Plan default', implementation: 'Implement default', functional: 'Functional default', security: 'Security default' };
const stage = (value, summary = value) => { flow.stage = value; flow.summary = summary; flow.events.push({ id: flow.events.length + 1, action: 'test', stage: value, summary, created_at: new Date().toISOString(), revision: flow.revision }); };
const port = process.env.WORKFLOW_TEST_PORT || '13694';
const base = `http://127.0.0.1:${port}`;
try {
  fixture = await startFixture();
  await copyFile('tests/kanban-ui/WorkflowBoardHarness.tsx', harness);
  await writeFile(html, '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/components/tasks/WorkflowBoardHarness.tsx"></script></body></html>');
  vite = spawn(process.execPath, [path.join(frontend, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', port, '--strictPort'], { cwd: frontend, windowsHide: true, stdio: 'pipe' });
  let logs = '';
  vite.stdout.on('data', chunk => { logs += chunk; }); vite.stderr.on('data', chunk => { logs += chunk; });
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (vite.exitCode !== null) throw new Error(logs);
    ready = await fetch(base).then(r => r.ok, () => false);
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready, logs);
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', err => errors.push(err.message));
  page.setDefaultTimeout(15000);
  await page.route('https://**', route => route.abort());
  await page.routeWebSocket('**/api/projects/stream/ws', () => {});
  await page.route('**/api/**', async route => {
    const requestBase = fixture.base;
    try {
      const req = route.request();
      if (new URL(req.url()).pathname === '/api/pr-cycle/workflow') {
        if (req.method() === 'POST') {
          const body = req.postDataJSON(); actions.push(body);
          if (!flow && body.action === 'start') {
            flow = { task_id: ids[0], project_id: '11111111-1111-4111-8111-111111111111', automation: { enabled: true, paused: false }, stage: 'plan', risk: null, plan: '', revision: 0, approved_revision: null, summary: '', children: [], prs: [], events: [], head_sha: 'a'.repeat(40) };
            stage('plan', 'Waiting for plan');
          }
          if (body.action === 'configure') Object.assign(prompts, body.prompts);
          if (body.action === 'pause') flow.automation.paused = true;
          if (body.action === 'resume') flow.automation.paused = false;
          if (body.action === 'approve_plan') { flow.approved_revision = flow.revision; stage('implementation', 'Approved plan'); }
          if (body.action === 'human_approve') flow.human_approval = { head_sha: flow.head_sha, revision: flow.revision };
        }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { workflows: flow ? [flow] : [], settings: { prompts } } }) });
      }
      const response = await page.request.fetch(requestBase + new URL(req.url()).pathname + new URL(req.url()).search, {
        method: req.method(), data: req.postDataBuffer() ?? undefined,
        headers: req.method() === 'POST' ? { 'Content-Type': 'application/json' } : {},
      });
      await route.fulfill({ response });
    } catch (error) {
      if (!restarting && requestBase === fixture.base) errors.push(error.message);
      await route.abort().catch(() => {});
    }
  });
  await page.goto(`${base}/workflow-board-test.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('.workflow-current').length === 4, undefined, { timeout: 60000 });
  assert.equal(await page.locator('.workflow-toolbar').getByText('顺序执行', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByText('各阶段提示词', { exact: true }).click();
  await page.getByLabel('安全性审查提示词', { exact: true }).fill('Security checks independently');
  await page.getByRole('button', { name: '保存项目提示词' }).click();
  await page.waitForFunction(() => !document.querySelector('.workflow-dialog button:disabled'));
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  assert.equal(actions.at(-1).prompts.security, 'Security checks independently');
  await page.locator('.workflow-current').filter({ hasText: '登录修复' }).getByRole('button', { name: '规划任务' }).click();
  await page.getByRole('button', { name: '开始任务并授权规划', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '启动请求已处理' }).waitFor();
  assert.equal(actions.at(-1).role, 'plan');
  assert.equal(await page.getByLabel('变更等级').count(), 0);
  assert.equal(await page.getByLabel('实施计划', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '保存计划', exact: true }).count(), 0);
  Object.assign(flow, { plan: 'P2: fix one boundary; test failure and success.', risk: 'P2', revision: 1,
    children: [{ id: 'boundary', title: 'Boundary fix', base_branch: 'integration/boundary', depends_on: [], publish_pr: true }] });
  stage('plan', 'Agent completed the plan and risk assessment');
  await page.getByRole('region', { name: '规划结果', exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: '规划审查面板', exact: true }).count(), 1);
  assert.equal(await page.getByRole('region', { name: '最终审查面板', exact: true }).count(), 0);
  assert.equal(await page.getByRole('region', { name: '最终 PR 记录', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '批准当前版本', exact: true }).count(), 0);
  await page.getByRole('button', { name: '批准第 1 版计划并自动执行', exact: true }).click();
  await page.getByRole('region', { name: '自动执行状态' }).getByText('自动推进中：实施', { exact: true }).waitFor();
  assert.equal(actions.at(-1).action, 'approve_plan');
  assert.equal(actions.at(-1).expected_revision, 1);
  assert.equal(await page.getByRole('button', { name: '启动／继续实施 Agent', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '启动子任务 Agent', exact: true }).count(), 0);
  await page.getByRole('button', { name: '暂停自动执行', exact: true }).click();
  await page.getByText('自动执行已暂停', { exact: true }).waitFor();
  assert.equal(actions.at(-1).action, 'pause');
  await page.getByRole('button', { name: '恢复自动执行', exact: true }).click();
  await page.getByText('自动推进中：实施', { exact: true }).waitFor();
  assert.equal(actions.at(-1).action, 'resume');
  for (const [next, label] of [['functional', '功能性审查'], ['security', '安全性审查'], ['pr', '创建 PR'], ['integration', '集成合并']]) {
    stage(next, `Automatically progressing ${next}`);
    await page.getByText(`自动推进中：${label}`, { exact: true }).waitFor();
  }
  assert.deepEqual(actions.filter(a => ['start', 'start_child', 'create_pr', 'integrate'].includes(a.action)).map(a => [a.action, a.role]), [['start', 'plan']]);
  flow.functional = { passed: true, summary: 'Functional evidence', details: 'Boundary tested', head_sha: flow.head_sha };
  flow.security = { passed: true, summary: 'Security evidence', details: 'Permission checked', head_sha: flow.head_sha };
  flow.prs = [{ url: 'https://github.com/example/project/pull/1', head_sha: flow.head_sha, base_branch: 'main' }];
  stage('human', 'Both reviews passed');
  await page.getByRole('button', { name: '批准当前版本', exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: '最终审查面板', exact: true }).count(), 1);
  assert.equal(await page.getByRole('region', { name: '规划审查面板', exact: true }).count(), 0);
  assert.equal(await page.getByRole('region', { name: '规划结果', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '批准第 1 版计划并自动执行', exact: true }).count(), 0);
  await page.getByText('Functional evidence', { exact: true }).waitFor();
  await page.getByText('Security evidence', { exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: '最终 PR 记录', exact: true }).getByRole('link').count(), 1);
  assert.equal(await page.getByRole('button', { name: '合入目标分支', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '批准当前版本', exact: true }).click();
  await page.getByRole('button', { name: '合入目标分支', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '已保存' }).waitFor();
  assert.equal(actions.at(-1).action, 'merge');
  assert.equal(actions.at(-1).head_sha, flow.head_sha);
  assert.deepEqual(errors, []);
  console.log('PASS workflow UI: settings prompts, Agent-owned read-only plan/risk, approval, automatic stage progression, pause/resume, human merge gate. All writes mocked.');
} catch (error) {
  if (page) {
    console.error(await page.locator('body').innerText().catch(() => 'Unable to read page'));
    await page.screenshot({ path: '.pr-cycle-runtime/workflow-board-failed.png', fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  restarting = true;
  if (browser) await browser.close();
  if (vite && vite.exitCode === null) {
    if (process.platform === 'win32') { try { execFileSync('taskkill', ['/PID', String(vite.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (error) { console.warn('Test server cleanup:', error.message); } }
    else vite.kill();
  }
  if (fixture) await fixture.close();
  for (const file of [harness, html]) {
    if (!file.startsWith(frontend + path.sep)) throw new Error('Unexpected fixture path');
    await rm(file, { force: true });
  }
}
