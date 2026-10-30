// Exercise the real built ProjectTasks page, including its empty-state branch.
// Requires a running rebuilt local board with at least one project. All task
// streams/history are browser mocks; all HTTP writes are blocked.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(path.resolve('.pr-cycle-runtime/ui-tests/package.json'));
const { chromium } = require('playwright');
const base = process.env.PR_CYCLE_UI_URL || 'http://127.0.0.1:13680';
const projects = (await (await fetch(`${base}/api/projects`)).json()).data;
assert.ok(projects?.length, 'Start the rebuilt board with at least one project before running this page test.');
const projectId = projects[0].id;
const taskId = '22222222-2222-4222-8222-000000000001';
const timestamp = '2026-10-30T00:00:00Z';
const task = {
  id: taskId, project_id: projectId, title: 'History regression task',
  description: 'Retained stage evidence', status: 'inprogress',
  has_in_progress_attempt: false, last_attempt_failed: false,
  executor: 'CLAUDE_CODE', parent_workspace_id: null,
  created_at: timestamp, updated_at: timestamp,
};
let tasks = { [taskId]: task };
let graph = {
  nodes: ['todo', 'inprogress'].map((status, index) => ({
    id: index + 1, task_id: taskId, project_id: projectId,
    status, title: index === 0 ? 'Original design' : task.title,
    description: index === 0 ? 'Legacy acceptance evidence' : task.description,
    round: 1, entered_at: timestamp, exited_at: index === 0 ? timestamp : null,
    baseline: 0, task_exists: 1,
  })),
  edges: [{ id: 1, source: 1, target: 2, kind: 'sequence', note: '', automatic: 1, created_at: timestamp }],
};
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://**', route => route.abort());
  await page.route('**/api/**', async route => {
    const request = route.request();
    if (!['GET', 'HEAD'].includes(request.method())) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true,"data":{}}' });
    }
    const pathname = new URL(request.url()).pathname;
    const data = pathname === '/api/pr-cycle/tracking' ? graph
      : pathname === '/api/tasks' ? Object.values(tasks) : undefined;
    if (data !== undefined) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
    }
    return route.continue();
  });
  let taskSocket;
  const sendTasks = () => taskSocket.send(JSON.stringify({ JsonPatch: [{ op: 'replace', path: '/tasks', value: tasks }] }));
  await page.routeWebSocket('**/api/tasks/stream/ws?**', socket => {
    taskSocket = socket;
    sendTasks();
    socket.send(JSON.stringify({ Ready: true }));
  });
  const openPage = async () => {
    await page.goto(`${base}/projects/${projectId}/tasks`, { waitUntil: 'domcontentloaded' });
    await page.locator('.workflow').waitFor();
    for (const label of ['稍后再说', 'Maybe later', 'Not now']) {
      const button = page.getByRole('button', { name: label, exact: true });
      if (await button.isVisible()) await button.click();
    }
  };
  await openPage();
  await page.locator('.workflow-current').waitFor();
  assert.equal(await page.locator('[data-trace-node]').count(), 2);

  const search = page.getByPlaceholder(/^Search/);
  await search.fill('original DESIGN');
  await page.locator('.workflow-current').waitFor();
  assert.equal(await page.locator('[data-trace-node]').count(), 2, 'historical titles retain the current card and whole path');
  await search.fill('  LEGACY acceptance  ');
  await page.locator('.workflow-current').waitFor();
  assert.equal(await page.locator('[data-trace-edge]').count(), 1);
  await search.fill(task.title);
  await page.locator('.workflow-current').waitFor();

  // Simulate the native last-task deletion plus its persisted trigger results.
  tasks = {};
  graph = { ...graph, nodes: graph.nodes.map(n => ({ ...n, exited_at: timestamp, task_exists: 0 })) };
  sendTasks();
  await page.waitForFunction(() => document.querySelectorAll('.workflow-history').length === 2);
  assert.equal(await page.locator('.workflow-current').count(), 0);
  assert.equal(await page.locator('[data-trace-edge]').count(), 1);
  assert.equal(await search.inputValue(), task.title, 'deletion must not clear the active search');

  // Unrelated deleted history must not bypass the search filter.
  graph.nodes.push({ ...graph.nodes[0], id: 3, task_id: '22222222-2222-4222-8222-000000000002', title: 'Unrelated work', description: null });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-trace-node]').length === 2);
  await search.fill('no-such-task-or-snapshot');
  await page.locator('.workflow-empty').waitFor();
  assert.equal(await page.locator('.workflow').count(), 1);
  assert.equal(await page.locator('[data-trace-node]').count(), 0);
  assert.match(await page.locator('.workflow-empty').innerText(), /没有匹配/);
  await search.fill('');
  await page.waitForFunction(() => document.querySelectorAll('[data-trace-node]').length === 3);
  await search.fill('legacy acceptance');
  await page.waitForFunction(() => document.querySelectorAll('[data-trace-node]').length === 2);

  // A fresh navigation must still mount the board with no native tasks at all.
  await openPage();
  await page.locator('.workflow-history').first().waitFor();
  assert.equal(await page.locator('.workflow-history').count(), 3);
  await page.locator('.workflow-snapshot').first().click();
  const history = page.getByRole('dialog', { name: '阶段历史' });
  await history.waitFor();
  assert.match(await history.innerText(), /Legacy acceptance evidence/);
  assert.equal(await history.getByRole('button', { name: '打开当前任务' }).count(), 0);
  await history.getByRole('button', { name: 'Close', exact: true }).click();

  // A genuinely empty project still has an actionable create-task entry.
  graph = { nodes: [], edges: [] };
  await openPage();
  await page.locator('.workflow-empty').waitFor();
  assert.equal(await page.locator('[data-trace-node]').count(), 0);
  assert.equal(await page.getByRole('button', { name: '新建任务', exact: true }).isEnabled(), true);
  assert.deepEqual(errors, []);
  console.log('PASS real ProjectTasks page: current/historical title and description search, deletion with active search, unrelated deleted history excluded, no-match and clear, reload, snapshot inspection and empty-project creation entry. No backend writes.');
} finally { await browser.close(); }
