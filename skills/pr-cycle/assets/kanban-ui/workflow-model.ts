export const stageLabels = {
  todo: '待办', plan: '规划审查', implementation: '实施', functional: '功能性审查',
  security: '安全性审查', pr: '创建 PR', integration: '集成合并', human: '最终审查',
  done: '完成', cancelled: '取消',
};
export type Stage = keyof typeof stageLabels;
export const promptLabels = { plan: '规划', implementation: '实施', functional: '功能性审查', security: '安全性审查' };
export type Role = keyof typeof promptLabels;
export type Prompts = Partial<Record<Role, string>>;
export interface ChildPlan {
  id: string; title: string; depends_on: string[]; base_branch: string;
  completed?: boolean; summary?: string; session_id?: string; head_sha?: string;
  publish_pr?: boolean;
  resolved_base_branch?: string;
}
export interface WorkflowEvent {
  id: number; action: string; stage: Stage; summary: string; details?: string;
  created_at: string; head_sha?: string; revision: number;
  role?: string; passed?: boolean;
  risk?: string | null;
}
export interface ReviewResult { passed: boolean; summary: string; details?: string; head_sha: string; }
export interface Workflow {
  task_id: string; project_id: string; stage: Stage; risk: string | null;
  plan: string; revision: number; approved_revision: number | null;
  summary: string; head_sha: string | null; children: ChildPlan[];
  prompts?: Prompts; events: WorkflowEvent[];
  prs: { url: string; head_sha: string; base_branch: string; child_id?: string }[];
  sessions?: Record<string, unknown>; functional?: ReviewResult | null; security?: ReviewResult | null;
  human_approval?: { head_sha: string; revision: number } | null; error?: string | null;
  integration?: unknown;
  automation?: { enabled: boolean; paused: boolean; reason?: string | null };
}
export interface WorkflowData { workflows: Workflow[]; settings: { prompts: Prompts } }

export interface TraceNode {
  id: number;
  task_id: string;
  project_id: string;
  status: Stage | 'inprogress' | 'inreview';
  summary?: string;
  risk?: string | null;
  managed?: boolean;
  title: string;
  description: string | null;
  round: number;
  entered_at: string;
  exited_at: string | null;
  baseline: number;
  task_exists: number;
}
export interface TraceEdge {
  id: number;
  source: number;
  target: number;
  kind: 'sequence' | 'return' | 'integrate';
  note: string;
  automatic: number;
  created_at: string;
}
export interface TraceGraph {
  nodes: TraceNode[];
  edges: TraceEdge[];
}

export const statuses = Object.keys(stageLabels) as Stage[];
export const nativeStage = (status: Stage | 'inprogress' | 'inreview'): Stage => status === 'inprogress' ? 'implementation' : status === 'inreview' ? 'human' : status;

export function workflowGraph(native: TraceGraph, workflows: Workflow[]): TraceGraph {
  const managed = new Set(workflows.map(w => w.task_id));
  const nodes: TraceNode[] = native.nodes.filter(n => !managed.has(n.task_id)).map(n => ({ ...n, status: nativeStage(n.status) }));
  const kept = new Set(nodes.map(n => n.id));
  const edges = native.edges.filter(e => kept.has(e.source) && kept.has(e.target));
  let nextId = -1;
  for (const workflow of workflows) {
    const original = native.nodes.filter(n => n.task_id === workflow.task_id);
    const title = original.at(-1)?.title ?? '任务';
    const phaseEvents = workflow.events.map(event => event.action === 'record_result' && event.role && event.role in promptLabels
      ? { ...event, stage: event.role as Stage } : event);
    const last = phaseEvents.at(-1);
    if (last && workflow.stage && last.stage !== workflow.stage) phaseEvents.push({ ...last, id: last.id + 1,
      action: 'await_stage', stage: workflow.stage, summary: `等待${stageLabels[workflow.stage]}`, details: '' });
    const snapshots = phaseEvents.filter(event => event.stage in stageLabels).reduce<typeof workflow.events>((list, event) => {
      if (list.at(-1)?.stage === event.stage) list[list.length - 1] = event;
      else list.push(event);
      return list;
    }, []);
    if (!snapshots.length) continue;
    const initialTime = workflow.events[0]?.created_at ?? snapshots[0].created_at;
    const earlier = original.filter(n => new Date(n.entered_at) < new Date(initialTime) || (n.status === 'todo' && new Date(n.entered_at) <= new Date(initialTime))).map(n => ({
      ...n, status: nativeStage(n.status), exited_at: n.exited_at ?? initialTime,
    }));
    nodes.push(...earlier);
    const earlierIds = new Set(earlier.map(n => n.id));
    edges.push(...native.edges.filter(e => earlierIds.has(e.source) && earlierIds.has(e.target)));
    let previous: TraceNode | undefined = earlier.filter(n => n.status === 'todo').at(-1);
    let round = 1;
    snapshots.forEach((event, index) => {
      const backwards = previous && statuses.indexOf(event.stage) <= statuses.indexOf(nativeStage(previous.status));
      if (backwards) round++;
      const node: TraceNode = { id: nextId--, task_id: workflow.task_id, project_id: workflow.project_id,
        status: event.stage, title, description: event.details ?? '', summary: event.summary, risk: event.risk ?? workflow.risk,
        managed: true, round, entered_at: event.created_at, exited_at: snapshots[index + 1]?.created_at ?? null,
        baseline: 0, task_exists: 1 };
      nodes.push(node);
      if (previous) edges.push({ id: nextId--, source: previous.id, target: node.id, kind: backwards ? 'return' : 'sequence',
        note: event.summary, automatic: 1, created_at: event.created_at });
      previous = node;
    });
  }
  const retained = new Set(nodes.map(n => n.id));
  const existingEdges = new Set(edges.map(e => e.id));
  edges.push(...native.edges.filter(e => !existingEdges.has(e.id) && retained.has(e.source) && retained.has(e.target)));
  return { nodes, edges };
}
