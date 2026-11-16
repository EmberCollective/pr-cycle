import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';

const { commit } = JSON.parse(await readFile('skills/pr-cycle/assets/runtime.lock.json', 'utf8'));
const runtime = process.env.PR_CYCLE_RUNTIME_ROOT ?? path.resolve('.pr-cycle-runtime');
const require = createRequire(path.join(runtime, `vibe-kanban-${commit}/frontend/package.json`));
const ts = require('typescript');
const source = await readFile('skills/pr-cycle/assets/kanban-ui/workflow-model.ts', 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { workflowGraph, nativeStage } = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

const native = { nodes: [{ id: 1, task_id: 'task', project_id: 'project', status: 'todo', title: 'Full task title',
  description: 'Full task content', round: 1, entered_at: '2026-10-30T00:00:00Z', exited_at: null, baseline: 1, task_exists: 1 }], edges: [] };
const event = (id, stage, summary) => ({ id, action: 'result', stage, summary, details: 'Evidence', created_at: `2026-10-30T0${id}:00:00Z`, revision: 1 });
const workflow = { task_id: 'task', project_id: 'project', risk: 'P2', events: [event(1, 'plan', 'Initial plan'), event(2, 'plan', 'Approved scope'), event(3, 'implementation', 'Implemented'), event(4, 'functional', 'Boundary failed'), event(5, 'implementation', 'Fix boundary')] };

test('stage history retains original todo, summarizes phases, and marks rework red-edge kind', () => {
  const graph = workflowGraph(native, [workflow]);
  assert.equal(graph.nodes.length, 5);
  assert.equal(graph.nodes[0].description, 'Full task content');
  assert.equal(graph.nodes[1].summary, 'Approved scope');
  assert.notEqual(graph.nodes[1].summary, native.nodes[0].description);
  assert.equal(graph.nodes.at(-1).exited_at, null);
  assert.equal(graph.nodes.at(-1).round, 2);
  assert.equal(graph.nodes.at(-1).risk, 'P2');
  assert.equal(graph.edges.at(-1).kind, 'return');
  assert.equal(native.nodes[0].exited_at, null, 'view derivation must not mutate native evidence');
});
test('independent task event IDs cannot collide; edges only refer to retained nodes', () => {
  const other = { ...workflow, task_id: 'other' };
  const graph = workflowGraph(native, [workflow, other]);
  const ids = new Set(graph.nodes.map(n => n.id));
  assert.equal(ids.size, graph.nodes.length);
  for (const edge of graph.edges) { assert.ok(ids.has(edge.source)); assert.ok(ids.has(edge.target)); }
});
test('legacy inreview is not reported as passed functional/security review', () => {
  assert.equal(nativeStage('inreview'), 'human');
  const graph = workflowGraph({ nodes: [{ ...native.nodes[0], status: 'inreview' }], edges: [] }, []);
  assert.equal(graph.nodes[0].summary, undefined);
  assert.equal(graph.nodes[0].managed, undefined);
});
test('completed implementation summary stays on implementation, not on pending functional review', () => {
  const graph = workflowGraph(native, [{ ...workflow, stage: 'functional', events: [
    event(1, 'plan', 'Approved scope'),
    { ...event(2, 'functional', 'Implementation complete'), action: 'record_result', role: 'implementation' },
  ] }]);
  assert.equal(graph.nodes.at(-2).status, 'implementation');
  assert.equal(graph.nodes.at(-2).summary, 'Implementation complete');
  assert.equal(graph.nodes.at(-1).status, 'functional');
  assert.match(graph.nodes.at(-1).summary, /等待/);
});
test('history retains the risk of its own plan revision', () => {
  const graph = workflowGraph(native, [{ ...workflow, risk: 'P0', events: [
    { ...event(1, 'plan', 'Earlier low risk scope'), risk: 'P2' },
    { ...event(2, 'implementation', 'Earlier implementation'), risk: 'P2' },
    { ...event(3, 'plan', 'Expanded architecture scope'), risk: 'P0' },
  ] }]);
  assert.equal(graph.nodes[1].risk, 'P2');
  assert.equal(graph.nodes.at(-1).risk, 'P0');
});

test('native workspace initialization never creates implementation-to-plan rework', () => {
  const initial = event(1, 'plan', 'Begin planning');
  const legacy = { ...native.nodes[0], id: 2, status: 'inprogress', entered_at: '2026-10-30T00:30:00Z' };
  const initialization = { ...legacy, id: 3, entered_at: initial.created_at };
  const graph = workflowGraph({ nodes: [...native.nodes, legacy, initialization], edges: [] }, [{ ...workflow,
    events: [initial, event(2, 'plan', 'Agent plan complete')],
  }]);
  assert.ok(graph.nodes.some(n => n.id === legacy.id), 'actual older implementation evidence remains');
  assert.ok(!graph.nodes.some(n => n.id === initialization.id), 'initialization is not a workflow stage');
  const plan = graph.nodes.find(n => n.managed);
  assert.deepEqual(graph.edges.filter(e => e.target === plan.id).map(e => [e.source, e.kind]), [[1, 'sequence']]);
  assert.equal(plan.round, 1);
});
