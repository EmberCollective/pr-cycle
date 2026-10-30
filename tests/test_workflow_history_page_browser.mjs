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
    status, title: task.title, description: task.description,
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

  // Simulate the native last-task deletion plus its persisted trigger results.
  tasks = {};
  graph = { ...graph, nodes: graph.nodes.map(n => ({ ...n, exited_at: timestamp, task_exists: 0 })) };
  sendTasks();
  await page.waitForFunction(() => document.querySelectorAll('.workflow-history').length === 2);
  assert.equal(await page.locator('.workflow-current').count(), 0);
  assert.equal(await page.locator('[data-trace-edge]').count(), 1);

  // A fresh navigation must still mount the board with no native tasks at all.
  await openPage();
  await page.locator('.workflow-history').first().waitFor();
  assert.equal(await page.locator('.workflow-history').count(), 2);
  await page.locator('.workflow-snapshot').first().click();
  const history = page.getByRole('dialog', { name: '阶段历史' });
  await history.waitFor();
  assert.match(await history.innerText(), /Retained stage evidence/);
  assert.equal(await history.getByRole('button', { name: '打开当前任务' }).count(), 0);
  await history.getByRole('button', { name: 'Close', exact: true }).click();

  // A genuinely empty project still has an actionable create-task entry.
  graph = { nodes: [], edges: [] };
  await openPage();
  await page.locator('.workflow-empty').waitFor();
  assert.equal(await page.locator('[data-trace-node]').count(), 0);
  assert.equal(await page.getByRole('button', { name: '新建任务', exact: true }).isEnabled(), true);
  assert.deepEqual(errors, []);
  console.log('PASS real ProjectTasks page: last-task deletion retains history/edges; reload and snapshot inspection work; empty project can create a task. No backend writes.');
} finally { await browser.close(); }
