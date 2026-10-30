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
const port = process.env.WORKFLOW_TEST_PORT || '13690';
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
  // Real pointer drag uses the same DnD provider and TaskCard as production.
  const card = page.locator('.workflow-current').filter({ hasText: '登录修复' }).locator('[role="button"]');
  const box = await card.boundingBox();
  await page.mouse.move(box.x + 70, box.y + 45); await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + 45, { steps: 3 });
  await page.mouse.move(box.x + 410, box.y + 45, { steps: 20 }); await page.mouse.up();
  await page.waitForFunction(() => document.querySelectorAll('[data-trace-node]').length === 5);
  assert.equal(await page.locator('.workflow-current').count(), 4);
  assert.equal(await page.locator('.workflow-history').count(), 1);
  assert.equal(await page.locator('[data-trace-edge="sequence"]').count(), 1);
  // A backend-only writer changes status with no browser mutation request.
  await fixture.native('update', { id: ids[0], status: 'inreview' });
  await fixture.native('update', { id: ids[0], status: 'inprogress' });
  await page.waitForFunction(() => document.querySelectorAll('[data-trace-edge="return"]').length === 1);
  await page.getByRole('button', { name: /^打回返工：/ }).click();
  await page.getByLabel('连线说明').fill('修复边界情况并补充测试');
  await page.getByRole('button', { name: '保存说明', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '关联任务', exact: true }).click();
  await page.getByRole('dialog').getByLabel('登录修复', { exact: true }).check();
  await page.getByRole('dialog').getByLabel('按钮文案', { exact: true }).check();
  await page.getByLabel('目标任务').selectOption({ label: '小改动整合' });
  await page.getByLabel('关联说明').fill('合并两个小改动一起交付');
  await page.getByRole('button', { name: '保存关联', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.querySelectorAll('[data-trace-edge="integrate"]').length === 2);
  // Independent cards fade; connected sources, histories and target stay visible.
  await page.getByRole('button', { name: '追踪 登录修复 第 2 轮', exact: true }).click();
  assert.equal(await page.locator('.workflow-node').filter({ hasText: '独立任务' }).evaluate(el => el.style.opacity), '0.28');
  await page.getByRole('button', { name: '显示全部路径' }).click();
  await page.getByRole('button', { name: '关联任务', exact: true }).click();
  await page.getByLabel('关系类型').selectOption('sequence');
  await page.getByRole('dialog').getByLabel('小改动整合', { exact: true }).check();
  await page.getByLabel('目标任务').selectOption({ label: '独立任务' });
  await page.getByRole('button', { name: '保存关联', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.querySelectorAll('[data-trace-edge="sequence"]').length === 3);
  // Hand-authored relations can be removed; automatic stage records cannot.
  await page.getByRole('button', { name: '顺序执行：小改动整合 → 独立任务', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '移除关联', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.querySelectorAll('[data-trace-edge="sequence"]').length === 2);
  await page.locator('.workflow-history').first().getByRole('button', { name: /登录修复/ }).last().click();
  await page.getByRole('dialog').waitFor();
  assert.match(await page.getByRole('dialog').innerText(), /追踪起点/);
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByLabel('折叠历史', { exact: true }).check();
  assert.equal(await page.locator('.workflow-history').count(), 0);
  await page.getByLabel('折叠历史', { exact: true }).uncheck();
  await page.getByLabel('小改动整合', { exact: true }).uncheck();
  assert.equal(await page.locator('[data-trace-edge="integrate"]').count(), 0);
  await page.getByLabel('小改动整合', { exact: true }).check();
  await page.getByLabel('筛选任务').selectOption(ids[0]);
  assert.equal(await page.locator('[data-trace-node]').count(), 4);
  await page.getByLabel('筛选任务').selectOption('');
  restarting = true;
  await page.goto('about:blank');
  await fixture.restart();
  restarting = false;
  await page.goto(`${base}/workflow-board-test.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('[data-trace-edge="integrate"]').length === 2);
  assert.equal(await page.locator('.workflow-current').count(), 4);
  await page.getByRole('button', { name: /^打回返工：/ }).click();
  assert.equal(await page.getByLabel('连线说明').inputValue(), '修复边界情况并补充测试');
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.screenshot({ path: '.pr-cycle-runtime/workflow-board.png', fullPage: true });
  assert.equal(await page.locator('.workflow-current').first().evaluate(el => getComputedStyle(el).borderTopColor), 'rgb(37, 99, 235)');
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({ path: '.pr-cycle-runtime/workflow-board-dark.png', fullPage: true });
  assert.equal(await page.locator('.workflow-current').first().evaluate(el => getComputedStyle(el).borderTopColor), 'rgb(96, 165, 250)');
  await page.setViewportSize({ width: 800, height: 700 });
  assert.equal(await page.locator('[data-trace-node]').count(), 7);
  assert.deepEqual(errors, []);
  console.log('PASS: real drag retains history; background changes; return reason; integration; path highlighting; snapshot; collapse/filter; persistence after proxy/browser restart; narrow viewport.');
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
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(vite.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else vite.kill();
  }
  if (fixture) await fixture.close();
  for (const file of [harness, html]) {
    if (!file.startsWith(frontend + path.sep)) throw new Error('Unexpected fixture path');
    await rm(file, { force: true });
  }
}
