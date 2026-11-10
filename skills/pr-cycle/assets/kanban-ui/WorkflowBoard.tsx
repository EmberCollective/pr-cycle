import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  KanbanBoard,
  KanbanProvider,
  type DragEndEvent,
} from '@/components/ui/shadcn-io/kanban';
import { TaskCard } from './TaskCard';
import type { TaskStatus, TaskWithAttemptStatus } from 'shared/types';
import { WorkflowSettings, WorkflowTaskDialog, workflowRequest } from './WorkflowControls';
import { stageLabels, statuses, nativeStage, workflowGraph, type WorkflowData, type TraceNode, type TraceEdge, type TraceGraph } from './workflow-model';
export type { TraceNode, TraceEdge, TraceGraph } from './workflow-model';
import './workflow-board.css';

export type KanbanColumns = Record<TaskStatus, TaskWithAttemptStatus[]>;
interface Props {
  columns: KanbanColumns;
  onDragEnd: (event: DragEndEvent) => void;
  onViewTaskDetails: (task: TaskWithAttemptStatus) => void;
  selectedTaskId?: string;
  onCreateTask?: () => void;
  projectId: string;
  searchQuery?: string;
}
const labels = { ...stageLabels, inprogress: '实施', inreview: '人类审查' };
const EMPTY_WORKFLOWS: WorkflowData = { workflows: [], settings: { prompts: {} } };
const kinds = {
  sequence: '顺序执行',
  return: '打回返工',
  integrate: '小改动整合',
};
const colors = {
  sequence: 'var(--workflow-sequence)',
  return: 'var(--workflow-return)',
  integrate: 'var(--workflow-integrate)',
};
const EMPTY: TraceGraph = { nodes: [], edges: [] };
const time = (value: string) => new Date(value).toLocaleString();

async function request(
  projectId: string,
  body?: Record<string, unknown>,
  signal?: AbortSignal
): Promise<TraceGraph> {
  const response = await fetch(
    `/api/pr-cycle/tracking?project_id=${encodeURIComponent(projectId)}`,
    body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, project_id: projectId }),
          signal,
        }
      : { signal }
  );
  const result = await response.json();
  if (!response.ok || !result.success)
    throw new Error(result.message || '无法读取流程记录，请检查看板服务');
  return result.data;
}

// Each task owns a horizontal lane. A return/revisit starts another row so
// repeated visits to one stage never overlap or overwrite earlier cards.
export function layoutNodes(nodes: TraceNode[]) {
  const groups = new Map<string, TraceNode[]>();
  nodes.forEach((node) =>
    groups.set(node.task_id, [...(groups.get(node.task_id) ?? []), node])
  );
  const positions = new Map<number, { x: number; y: number }>();
  let base = 80;
  for (const group of groups.values()) {
    let row = 0;
    let previous = -1;
    for (const node of group) {
      const column = statuses.indexOf(nativeStage(node.status));
      if (column <= previous) row++;
      positions.set(node.id, { x: 24 + column * 340, y: base + row * 220 });
      previous = column;
    }
    base += (row + 1) * 220;
  }
  return { positions, height: Math.max(360, base + 30) };
}

export default function WorkflowBoard({
  columns,
  onDragEnd,
  onViewTaskDetails,
  selectedTaskId,
  onCreateTask,
  projectId,
  searchQuery = '',
}: Props) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['workflow', projectId],
    queryFn: ({ signal }) => request(projectId, undefined, signal),
    refetchInterval: 2500,
    retry: false,
  });
  const flowQuery = useQuery<WorkflowData>({
    queryKey: ['workflow-state', projectId],
    queryFn: ({ signal }) => workflowRequest(projectId, undefined, signal),
    refetchInterval: 2500, retry: false,
  });
  const flowData = flowQuery.data ?? EMPTY_WORKFLOWS;
  const workflows = new Map(flowData.workflows.map(w => [w.task_id, w]));
  const graph = workflowGraph(query.data ?? EMPTY, flowData.workflows);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workflowTaskId, setWorkflowTaskId] = useState<string | null>(null);
  const refresh = async () => { await Promise.all([query.refetch(), flowQuery.refetch()]); };
  const [filter, setFilter] = useState('');
  const [focused, setFocused] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [visibleKinds, setVisibleKinds] = useState<string[]>(
    Object.keys(kinds)
  );
  const [history, setHistory] = useState<TraceNode | null>(null);
  const [edge, setEdge] = useState<TraceEdge | null>(null);
  const [relationOpen, setRelationOpen] = useState(false);
  const [sources, setSources] = useState<number[]>([]);
  const [target, setTarget] = useState('');
  const [kind, setKind] = useState('integrate');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const tasks = useMemo(
    () =>
      new Map(
        Object.values(columns)
          .flat()
          .map((task) => [task.id, task])
      ),
    [columns]
  );
  const revision = [...tasks.values()]
    .map((t) => `${t.id}:${t.status}:${t.updated_at}`)
    .sort()
    .join('|');
  useEffect(() => {
    void client.invalidateQueries({ queryKey: ['workflow', projectId] });
  }, [client, projectId, revision]);
  useEffect(() => {
    setFilter('');
    setFocused(null);
    setHistory(null);
    setEdge(null);
    setRelationOpen(false);
    setError('');
    setSettingsOpen(false);
    setWorkflowTaskId(null);
  }, [projectId]);

  const search = searchQuery.trim().toLowerCase();
  const matches = (item: { title: string; description: string | null }) =>
    item.title.toLowerCase().includes(search) ||
    (item.description ?? '').toLowerCase().includes(search);
  // Match current text and retained snapshots, then keep the whole task path.
  const matchingTaskIds = new Set([
    ...[...tasks.values()].filter(matches).map((task) => task.id),
    ...graph.nodes.filter(matches).map((node) => node.task_id),
  ]);
  const visibleTasks = [...tasks.values()].filter(
    (task) => !search || matchingTaskIds.has(task.id)
  );
  const eligible = graph.nodes.filter(
    (n) =>
      (tasks.has(n.task_id) || !n.task_exists) &&
      (!search || matchingTaskIds.has(n.task_id))
  );
  const nodes = eligible.filter(
    (n) =>
      (!filter || n.task_id === filter) && (!collapsed || n.exited_at === null)
  );
  const { positions, height } = layoutNodes(nodes);
  const current = (query.data?.nodes ?? []).filter(
    (n) => n.exited_at === null && n.task_exists && tasks.has(n.task_id)
  );
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const connected = new Set<number>();
  if (focused !== null && byId.has(focused)) {
    connected.add(focused);
    // Traverse both directions, including other tasks feeding an integration.
    let changed = true;
    while (changed) {
      changed = false;
      for (const e of graph.edges) {
        if (
          (connected.has(e.source) || connected.has(e.target)) &&
          (!connected.has(e.source) || !connected.has(e.target))
        ) {
          connected.add(e.source);
          connected.add(e.target);
          changed = true;
        }
      }
    }
  }
  const integrated = new Set(
    graph.edges
      .filter((e) => e.kind === 'integrate')
      .map((e) => byId.get(e.source)?.task_id)
  );
  const integratedNodes = new Set(
    graph.edges.filter((e) => e.kind === 'integrate').map((e) => e.source)
  );
  const hiddenEdges = graph.edges.filter(
    (e) => !positions.has(e.source) || !positions.has(e.target)
  ).length;

  async function save(body: Record<string, unknown>) {
    setSaving(true);
    setError('');
    try {
      await request(projectId, body);
      await client.invalidateQueries({ queryKey: ['workflow', projectId] });
      setEdge(null);
      setRelationOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="workflow" aria-label="流程追踪看板">
      <div className="workflow-toolbar">
        <div>
          <strong>流程追踪</strong>
          <span className="workflow-muted">
            阶段留痕 · 任务 {visibleTasks.length} · 历史节点{' '}
            {eligible.filter((n) => n.exited_at).length}
          </span>
        </div>
        <div className="workflow-controls">
          <button onClick={onCreateTask}>新建任务</button>
          <button onClick={() => void refresh()}>刷新</button>
          <button onClick={() => setSettingsOpen(true)}>设置</button>
        </div>
        {settingsOpen && <WorkflowSettings open onOpenChange={setSettingsOpen} projectId={projectId}
          prompts={flowData.settings.prompts} refresh={refresh}>
        <div className="workflow-controls">
          <label>
            任务{' '}
            <select
              aria-label="筛选任务"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="">全部任务</option>
              {[
                ...new Map(eligible.map((n) => [n.task_id, n.title])).entries(),
              ].map(([id, title]) => (
                <option key={id} value={id}>
                  {title}
                </option>
              ))}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={collapsed}
              onChange={(e) => setCollapsed(e.target.checked)}
            />
            折叠历史
          </label>
          {(Object.keys(kinds) as TraceEdge['kind'][]).map((k) => (
            <label key={k} style={{ color: colors[k] }}>
              <input
                type="checkbox"
                checked={visibleKinds.includes(k)}
                onChange={(e) =>
                  setVisibleKinds(
                    e.target.checked
                      ? [...visibleKinds, k]
                      : visibleKinds.filter((v) => v !== k)
                  )
                }
              />
              {kinds[k]}
            </label>
          ))}
          <button
            onClick={() => {
              setSources([]);
              setTarget('');
              setNote('');
              setError('');
              setSettingsOpen(false);
              setRelationOpen(true);
            }}
            disabled={!query.data || current.length < 2}
          >
            关联任务
          </button>
          <button onClick={() => setFocused(null)}>显示全部路径</button>
        </div>
        </WorkflowSettings>}
        {hiddenEdges > 0 && (
          <small className="workflow-muted">
            当前筛选或折叠隐藏了 {hiddenEdges}{' '}
            条连线，展开全部任务和历史可查看。
          </small>
        )}
        {query.isLoading && <p role="status">正在读取流程记录…</p>}
        {flowQuery.error && <p role="alert">{flowQuery.error.message} <button onClick={() => void flowQuery.refetch()}>重试流程服务</button></p>}
        {query.error && (
          <p role="alert">
            {query.error.message}。
            <button onClick={() => void query.refetch()}>重试</button>
          </p>
        )}
        {error && !edge && !relationOpen && <p role="alert">{error}</p>}
      </div>
      <div className="workflow-scroll">
        <div className="workflow-canvas" style={{ height, width: statuses.length * 340 + 20 }}>
          <KanbanProvider
            className="workflow-provider"
            onDragEnd={(event) => {
              if (event.over?.id === 'todo' && !workflows.has(String(event.active.id))) onDragEnd(event);
              else if (event.over && event.over.id !== event.active.data.current?.status) setError('请打开卡片，通过阶段操作推进流程；不能拖拽跳过审批或审查。');
            }}
          >
            {statuses.map((status, column) => (
              <div
                key={status}
                className="workflow-column-shell"
                style={{ left: column * 340, height }}
              >
                <KanbanBoard id={status} className="workflow-column">
                  <div className="workflow-column-heading">
                    {labels[status]}{' '}
                    <small>
                      {
                        visibleTasks.filter((task) => (workflows.get(task.id)?.stage ?? nativeStage(task.status)) === status)
                          .length
                      }{' '}
                      项当前任务
                    </small>
                  </div>
                  {nodes
                    .filter((n) => n.status === status)
                    .map((node, index) => {
                      const position = positions.get(node.id)!;
                      const task = tasks.get(node.task_id);
                      const active =
                        !node.exited_at && task && (workflows.get(task.id)?.stage ?? nativeStage(task.status)) === node.status;
                      const dimmed =
                        connected.size > 0 && !connected.has(node.id);
                      return (
                        <div
                          key={node.id}
                          data-trace-node={node.id}
                          className={`workflow-node ${active ? 'workflow-current' : 'workflow-history'}`}
                          style={{
                            left: position.x - column * 340,
                            top: position.y,
                            opacity: dimmed ? 0.28 : 1,
                          }}
                        >
                          <div className="workflow-node-meta">
                            <span>
                              {active
                                ? '当前'
                                : node.exited_at
                                  ? '历史'
                                  : '同步中'}{' '}
                              · 第 {node.round} 轮 {node.risk && <span className={`workflow-risk workflow-risk-${node.risk}`}>{node.risk}</span>}
                            </span>
                            <button
                              aria-label={`追踪 ${node.title} 第 ${node.round} 轮`}
                              onClick={() => setFocused(node.id)}
                            >
                              追踪
                            </button>
                          </div>
                          {active && task && status === 'todo' ? (
                            <TaskCard
                              task={task}
                              index={index}
                              status="todo"
                              onViewDetails={(t) => {
                                setFocused(node.id);
                                onViewTaskDetails(t);
                              }}
                              isOpen={selectedTaskId === task.id}
                              projectId={projectId}
                            />
                          ) : (
                            <button
                              className="workflow-snapshot"
                              onClick={() => {
                                setFocused(node.id);
                                if (active && task) setWorkflowTaskId(task.id);
                                else setHistory(node);
                              }}
                            >
                              <strong>{node.status === 'todo' ? node.title : `${labels[node.status]}摘要`}</strong>
                              <span>{node.status === 'todo' ? node.description || '暂无任务说明' : node.summary || '尚无阶段摘要，点击查看完整任务与历史。'}</span>
                            </button>
                          )}
                          {active && task && status === 'todo' && <button className="workflow-plan-entry" onClick={() => setWorkflowTaskId(task.id)}>规划任务</button>}
                          <div className="workflow-node-footer">
                            <span>{time(node.entered_at)}</span>
                            {(integratedNodes.has(node.id) ||
                              (active && integrated.has(node.task_id))) && (
                              <span className="workflow-integrated">
                                已纳入整合
                              </span>
                            )}
                          </div>
                          {node.baseline === 1 && (
                            <small className="workflow-baseline">
                              追踪起点 · 此前历史未记录
                            </small>
                          )}
                        </div>
                      );
                    })}
                </KanbanBoard>
              </div>
            ))}
          </KanbanProvider>
          <svg
            className="workflow-lines"
            width={statuses.length * 340 + 20}
            height={height}
            aria-label="流程连线"
          >
            <defs>
              {(Object.keys(colors) as TraceEdge['kind'][]).map((k) => (
                <marker
                  key={k}
                  id={`workflow-arrow-${k}`}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill={colors[k]} />
                </marker>
              ))}
            </defs>
            {graph.edges
              .filter(
                (e) =>
                  visibleKinds.includes(e.kind) &&
                  positions.has(e.source) &&
                  positions.has(e.target)
              )
              .map((e) => {
                const a = positions.get(e.source)!;
                const b = positions.get(e.target)!;
                const sameColumn = a.x === b.x;
                const backwards = b.x < a.x;
                const x1 = a.x + (backwards ? 0 : 270);
                const x2 = b.x + (backwards || sameColumn ? 270 : 0);
                const y1 = a.y + 82;
                const y2 = b.y + 82;
                const bend = backwards ? -44 : 44;
                const d = sameColumn
                  ? `M ${x1} ${y1} C ${x1 + 44} ${y1}, ${x2 + 44} ${y2}, ${x2} ${y2}`
                  : `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
                const dimmed = connected.size > 0 && !connected.has(e.source);
                return (
                  <g
                    key={e.id}
                    data-trace-edge={e.kind}
                    opacity={dimmed ? 0.15 : 1}
                    role="button" tabIndex={0} className="workflow-edge-label"
                    aria-label={`${kinds[e.kind]}：${byId.get(e.source)?.title} → ${byId.get(e.target)?.title}`}
                    onClick={() => { setEdge(e); setNote(e.note); setError(''); }}
                    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault(); setEdge(e); setNote(e.note); setError('');
                    } }}
                  >
                    <path
                      d={d}
                      className="workflow-edge-hit"
                      fill="none"
                      stroke="transparent"
                      strokeWidth="14"
                      onClick={() => {
                        setEdge(e);
                        setNote(e.note);
                        setError('');
                      }}
                    />
                    <path
                      d={d}
                      fill="none"
                      stroke={colors[e.kind]}
                      strokeWidth="2"
                      strokeDasharray={e.kind === 'return' ? '7 5' : undefined}
                      markerEnd={`url(#workflow-arrow-${e.kind})`}
                    />
                    <title>{`${kinds[e.kind]}${e.note ? `：${e.note}` : ''}`}</title>
                  </g>
                );
              })}
          </svg>
          {!query.isLoading && !query.error && nodes.length === 0 && (
            <p className="workflow-empty">
              {search
                ? '没有匹配的当前任务或历史记录。请调整搜索或筛选条件。'
                : '暂无可显示的阶段记录。新建任务或调整筛选后查看。'}
            </p>
          )}
        </div>
      </div>
      {workflowTaskId && tasks.has(workflowTaskId) && <WorkflowTaskDialog key={workflowTaskId}
        task={tasks.get(workflowTaskId)!} workflow={workflows.get(workflowTaskId)} projectId={projectId}
        refresh={refresh} onClose={() => setWorkflowTaskId(null)} onOpenTask={() => {
          onViewTaskDetails(tasks.get(workflowTaskId)!); setWorkflowTaskId(null);
        }} />}
      <Dialog
        role="dialog"
        aria-modal="true"
        aria-label="阶段历史"
        open={Boolean(history)}
        onOpenChange={(open) => {
          if (!open) setHistory(null);
        }}
      >
        <DialogContent className="workflow-dialog">
          <DialogHeader>
            <DialogTitle>{history?.title}</DialogTitle>
            <DialogDescription>
              阶段历史快照，保留该轮结束时的记录。
            </DialogDescription>
          </DialogHeader>
          {history && (
            <>
              <p>
                {labels[history.status]} · 第 {history.round} 轮 ·{' '}
                {time(history.entered_at)}
              </p>
              {history.exited_at && <p>离开阶段：{time(history.exited_at)}</p>}
              {Boolean(history.baseline) && (
                <p>此节点为追踪起点，此前历史未记录。</p>
              )}
              {history.summary && <section><strong>阶段摘要</strong><pre>{history.summary}</pre></section>}
              <strong>任务详情与阶段记录</strong><pre>{history.description || '暂无阶段说明'}</pre>
              {tasks.has(history.task_id) && <pre>{tasks.get(history.task_id)?.description}</pre>}
              {tasks.has(history.task_id) && (
                <button
                  onClick={() => {
                    onViewTaskDetails(tasks.get(history.task_id)!);
                    setHistory(null);
                  }}
                >
                  打开当前任务
                </button>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        role="dialog"
        aria-modal="true"
        aria-label="关联任务"
        open={relationOpen}
        onOpenChange={(open) => {
          if (!saving) setRelationOpen(open);
        }}
      >
        <DialogContent className="workflow-dialog">
          <DialogHeader>
            <DialogTitle>关联任务</DialogTitle>
            <DialogDescription>
              记录任务的执行顺序或整合来源。关联不会启动任务或将来源标为完成。
            </DialogDescription>
          </DialogHeader>
          <label>
            关系
            <select
              aria-label="关系类型"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              <option value="integrate">小改动整合</option>
              <option value="sequence">顺序执行</option>
            </select>
          </label>
          <fieldset>
            <legend>来源任务（可多选）</legend>
            <div className="workflow-source-list">
              {current.map((n) => (
                <label key={n.id}>
                  <input
                    type="checkbox"
                    checked={sources.includes(n.id)}
                    onChange={(e) =>
                      setSources(
                        e.target.checked
                          ? [...sources, n.id]
                          : sources.filter((id) => id !== n.id)
                      )
                    }
                  />
                  {n.title}
                </label>
              ))}
            </div>
          </fieldset>
          <label>
            目标任务
            <select
              aria-label="目标任务"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="">请选择</option>
              {current
                .filter((n) => !sources.includes(n.id))
                .map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.title}
                  </option>
                ))}
            </select>
          </label>
          <label>
            说明
            <textarea
              aria-label="关联说明"
              value={note}
              maxLength={4000}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <button
            disabled={
              saving ||
              sources.length === 0 ||
              !target ||
              sources.includes(Number(target))
            }
            onClick={() =>
              void save({
                action: 'relate',
                sources,
                target: Number(target),
                kind,
                note,
              })
            }
          >
            {saving ? '保存中…' : '保存关联'}
          </button>
        </DialogContent>
      </Dialog>
      <Dialog
        role="dialog"
        aria-modal="true"
        aria-label="流转详情"
        open={Boolean(edge)}
        onOpenChange={(open) => {
          if (!open && !saving) setEdge(null);
        }}
      >
        <DialogContent className="workflow-dialog">
          <DialogHeader>
            <DialogTitle>{edge ? kinds[edge.kind] : '流转详情'}</DialogTitle>
            <DialogDescription>
              {edge &&
                `${byId.get(edge.source)?.title} → ${byId.get(edge.target)?.title}`}
            </DialogDescription>
          </DialogHeader>
          {edge && (
            <>
              <p>
                {time(edge.created_at)} ·{' '}
                {edge.automatic ? '实际阶段流转' : '任务关联'}
              </p>
              <p>
                {labels[byId.get(edge.source)!.status]}（第{' '}
                {byId.get(edge.source)?.round} 轮）→{' '}
                {labels[byId.get(edge.target)!.status]}（第{' '}
                {byId.get(edge.target)?.round} 轮）
              </p>
              <label>
                原因 / 说明
                <textarea
                  aria-label="连线说明"
                  value={note}
                  readOnly={edge.id < 0}
                  maxLength={4000}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
              {error && <p role="alert">{error}</p>}
              <button
                disabled={saving || edge.id < 0}
                onClick={() =>
                  void save({ action: 'annotate', edge_id: edge.id, note })
                }
              >
                保存说明
              </button>
              {!edge.automatic && (
                <button
                  disabled={saving}
                  onClick={() =>
                    void save({ action: 'unlink', edge_id: edge.id })
                  }
                >
                  移除关联
                </button>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
