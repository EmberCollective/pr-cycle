import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startFixture, project, ids } from './kanban-ui/tracking-fixture.mjs';

test('real tracking API persists native writes, relations and reasons across proxy restarts', async t => {
  const fixture = await startFixture(); t.after(() => fixture.close());
  const get = async () => (await (await fetch(`${fixture.base}/api/pr-cycle/tracking?project_id=${project}`)).json()).data;
  const post = async body => fetch(`${fixture.base}/api/pr-cycle/tracking`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project_id: project, ...body }),
  });
  const initial = await get();
  assert.equal(initial.nodes.length, 4);
  for (const status of ['inprogress', 'inreview', 'inprogress']) {
    const result = await fetch(`${fixture.base}/api/tasks/${ids[0]}`, { method: 'PUT', body: JSON.stringify({ id: ids[0], status }) });
    assert.equal(result.status, 200);
  }
  const updated = await get();
  assert.equal(updated.nodes.length, 7);
  assert.equal(updated.edges.at(-1).kind, 'return');
  assert.equal((await post({ action: 'annotate', edge_id: updated.edges.at(-1).id, note: '补充边界测试' })).status, 200);
  const sources = updated.nodes.filter(n => [ids[0], ids[1]].includes(n.task_id) && !n.exited_at).map(n => n.id);
  const target = updated.nodes.find(n => n.task_id === ids[2]).id;
  assert.equal((await post({ action: 'relate', sources, target, kind: 'integrate' })).status, 200);
  const before = await get();
  await fixture.restart();
  assert.deepEqual(await get(), before);
  assert.equal((await fixture.native('list')).data.length, 4, 'history does not duplicate native tasks');
  assert.equal((await fixture.native('list')).data[1].status, 'todo', 'integration does not claim source completion');
});

test('tracking endpoints validate body, method, origin and project scope', async t => {
  const fixture = await startFixture(); t.after(() => fixture.close());
  const url = `${fixture.base}/api/pr-cycle/tracking`;
  assert.equal((await fetch(url)).status, 400);
  assert.equal((await fetch(url, { method: 'DELETE' })).status, 405);
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await fetch(url, { headers: { Origin: 'https://example.org' } })).status, 403);
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(66000) })).status, 413);
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project_id: project, action: 'relate', sources: [1], target: 1, kind: 'integrate' }) });
  assert.equal(response.status, 400);
});
