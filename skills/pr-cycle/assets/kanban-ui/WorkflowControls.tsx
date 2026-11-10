import { useState, type ReactNode } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import type { TaskWithAttemptStatus } from 'shared/types';

import { stageLabels, promptLabels, type Role, type Prompts, type Workflow } from './workflow-model';

export async function workflowRequest(projectId: string, body?: Record<string, unknown>, signal?: AbortSignal) {
  const response = await fetch(`/api/pr-cycle/workflow?project_id=${encodeURIComponent(projectId)}`, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PR-Cycle-Human': '1' },
    body: JSON.stringify({ ...body, project_id: projectId }), signal,
  } : { signal });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.message || '流程操作失败，请重试');
  if (!body && (!Array.isArray(result.data?.workflows) || !result.data?.settings)) throw new Error('流程服务尚未就绪，请重启新版看板启动器');
  return result.data;
}
function PromptFields({ value, onChange }: { value: Prompts; onChange: (value: Prompts) => void }) {
  return <>{(Object.keys(promptLabels) as Role[]).map(role => <label key={role}>
    {promptLabels[role]}提示词<textarea aria-label={`${promptLabels[role]}提示词`} value={value[role] ?? ''}
      placeholder="留空使用项目默认提示词" maxLength={20000}
      onChange={event => onChange({ ...value, [role]: event.target.value })} />
  </label>)}</>;
}
export function WorkflowSettings({ open, onOpenChange, projectId, prompts, refresh, children }: {
  open: boolean; onOpenChange: (open: boolean) => void; projectId: string;
  prompts: Prompts; refresh: () => Promise<unknown>; children: ReactNode;
}) {
  const [draft, setDraft] = useState(prompts);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <Dialog role="dialog" aria-modal="true" aria-label="设置" open={open} onOpenChange={value => { if (!busy) onOpenChange(value); }}>
    <DialogContent className="workflow-dialog workflow-settings">
      <DialogHeader><DialogTitle>设置</DialogTitle><DialogDescription>调整流程显示和本项目各阶段的默认提示词。</DialogDescription></DialogHeader>
      <fieldset><legend>流程显示与关联</legend>{children}</fieldset>
      <details><summary>各阶段提示词</summary><PromptFields value={draft} onChange={setDraft} />
        <p className="workflow-help">阶段输入自动包含任务详情及所需计划、代码版本和审查证据。模板修改在下一次计划批准时生效，当前执行使用批准时的提示词快照。</p>
        <button disabled={busy} onClick={async () => { setBusy(true); setError(''); try {
          await workflowRequest(projectId, { action: 'configure', prompts: draft }); await refresh();
        } catch (err) { setError(String(err instanceof Error ? err.message : err)); } finally { setBusy(false); } }}>
          {busy ? '保存中…' : '保存项目提示词'}
        </button>
      </details>
      {error && <p role="alert">{error}</p>}
    </DialogContent>
  </Dialog>;
}

type PanelProps = { workflow?: Workflow; busy: boolean; act: (action: string, values?: Record<string, unknown>) => Promise<void> };

function AutomationStatus({ workflow, busy, act }: PanelProps) {
  if (!workflow || ['todo', 'human', 'done', 'cancelled'].includes(workflow.stage)) return null;
  return <section aria-label="自动执行状态">
    <p>{workflow.automation?.paused ? '自动执行已暂停' : workflow.stage === 'plan' && workflow.plan ? '等待人类批准计划' : `自动推进中：${stageLabels[workflow.stage]}`}</p>
    {workflow.automation?.reason && <p>{workflow.automation.reason}</p>}
    {workflow.automation?.paused || workflow.error || !workflow.automation?.enabled
      ? <button disabled={busy} onClick={() => void act('resume')}>恢复自动执行</button>
      : <button disabled={busy} onClick={() => void act('pause')}>暂停自动执行</button>}
  </section>;
}

export function PlanReviewPanel({ task, workflow, busy, act, onOpenTask }: PanelProps & { task: TaskWithAttemptStatus; onOpenTask: () => void }) {
  return <section aria-label="规划审查面板">
    <section aria-label="任务详情"><strong>任务详情</strong><pre>{task.description || '暂无任务说明'}</pre>
      <button onClick={onOpenTask}>打开任务与会话</button></section>
    {!workflow && <p>规划 Agent 将分析任务、判定等级并给出计划。请审核范围、定级依据和验收条件，批准后自动执行。</p>}
    {(!workflow || workflow.stage === 'todo' || (!workflow.automation?.enabled && !workflow.plan)) &&
      <button disabled={busy} onClick={() => void act('start', { role: 'plan' })}>{busy ? '处理中…' : '开始任务并授权规划'}</button>}
    {workflow?.plan ? <section aria-label="规划结果">
      <strong>规划 Agent 判定等级：{workflow.risk || '尚未定级'}</strong>
      <h3>实施计划与定级依据</h3><pre>{workflow.plan}</pre>
      {workflow.children.length > 0 && <fieldset><legend>实施子任务与 PR 依赖</legend>
        {workflow.children.map(child => <div key={child.id} className="workflow-child-plan">
          <strong>{child.title}</strong><p>目标分支：{child.resolved_base_branch || child.base_branch}</p>
          <p>{child.publish_pr !== false ? '发布独立子 PR' : '主实施汇总'}{child.depends_on.length > 0 && ` · 依赖：${child.depends_on.map(id => workflow.children.find(c => c.id === id)?.title ?? id).join('、')}`}</p>
        </div>)}
      </fieldset>}
      <p>批准此计划后自动实施、独立双审及发布 PR，最后进入最终审查。</p>
      <button disabled={busy || workflow.approved_revision === workflow.revision}
        onClick={() => void act('approve_plan', { expected_revision: workflow.revision })}>批准第 {workflow.revision} 版计划并自动执行</button>
    </section> : workflow && <p>{workflow.summary || '规划 Agent 正在分析任务并生成计划。'}</p>}
    <AutomationStatus workflow={workflow} busy={busy} act={act} />
  </section>;
}

export function FinalReviewPanel({ workflow, busy, act }: PanelProps) {
  if (!workflow) return <section aria-label="最终审查面板"><p>这是旧版任务的待审查记录，尚无新流程的两项独立审查证据，不能据此批准合并。</p></section>;
  return <section aria-label="最终审查面板">
    <section aria-label="最终候选"><strong>最终候选版本</strong><p>请核对当前版本、两项审查证据和 PR。批准仅适用于此版本。</p>
      <code>{workflow.head_sha || '尚无待审批版本'}</code></section>
    {(['functional', 'security'] as const).map(role => {
      const result = workflow[role];
      return <section key={role} aria-label={`${stageLabels[role]}证据`}><strong>{stageLabels[role]}</strong>
        {result ? <><p>{result.passed ? '通过' : '未通过'}{result.head_sha !== workflow.head_sha && ' · 非当前候选版本'}</p>
          <pre>{result.summary}</pre>{result.details && <pre>{result.details}</pre>}<code>{result.head_sha}</code></>
          : <p>暂无当前候选的审查证据。</p>}
      </section>;
    })}
    <section aria-label="最终 PR 记录"><strong>PR 记录</strong>{workflow.prs.length ? workflow.prs.map(pr => <p key={pr.url}>
      <a href={/^https:\/\//.test(pr.url) ? pr.url : undefined} target="_blank" rel="noreferrer">{pr.child_id || 'PR'}：{pr.url}</a> → {pr.base_branch}
    </p>) : <p>尚无 PR。</p>}</section>
    {workflow.stage === 'human' && <>
      <button disabled={busy || !workflow.head_sha || workflow.human_approval?.head_sha === workflow.head_sha}
        onClick={() => void act('human_approve', { head_sha: workflow.head_sha })}>批准当前版本</button>
      <button disabled={busy || !workflow.head_sha || workflow.human_approval?.head_sha !== workflow.head_sha}
        onClick={() => void act('merge', { head_sha: workflow.head_sha })}>合入目标分支</button>
    </>}
    {workflow.stage === 'done' && <p>已完成合并。</p>}
  </section>;
}

export function WorkflowTaskDialog({ task, workflow, projectId, onClose, refresh, onOpenTask }: {
  task: TaskWithAttemptStatus; workflow?: Workflow; projectId: string;
  onClose: () => void; refresh: () => Promise<unknown>; onOpenTask: () => void;
}) {
  const [prompts, setPrompts] = useState<Prompts>(workflow?.prompts ?? {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const stage = workflow?.stage ?? (task.status === 'inreview' || task.status === 'done' ? 'human' : 'todo');
  async function act(action: string, values: Record<string, unknown> = {}) {
    setBusy(true); setError(''); setNotice('');
    try {
      await workflowRequest(projectId, { action, task_id: task.id, ...values });
      await refresh(); setNotice(action === 'start' ? '启动请求已处理，请查看会话与执行结果。' : '已保存');
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  return <Dialog role="dialog" aria-modal="true" aria-label="任务流程详情" open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent className="workflow-dialog workflow-task-dialog">
      <DialogHeader><DialogTitle>{task.title}</DialogTitle><DialogDescription>
        {stageLabels[stage]} {workflow?.risk && `· ${workflow.risk}`}
      </DialogDescription></DialogHeader>
      {workflow?.error && <p role="alert">{workflow.error}</p>}
      {stage === 'todo' || stage === 'plan'
        ? <PlanReviewPanel task={task} workflow={workflow} busy={busy} act={act} onOpenTask={onOpenTask} />
        : stage === 'human' || stage === 'done'
          ? <FinalReviewPanel workflow={workflow} busy={busy} act={act} />
          : <section aria-label="执行进度面板">
            {workflow?.summary && <section aria-label="阶段摘要"><strong>{stageLabels[stage]}摘要</strong><pre>{workflow.summary}</pre></section>}
            <AutomationStatus workflow={workflow} busy={busy} act={act} />
            <button onClick={onOpenTask}>打开任务与会话</button>
            <details><summary>本任务提示词覆盖</summary><PromptFields value={prompts} onChange={setPrompts} />
              <button disabled={busy || !workflow} onClick={() => void act('configure_task', { prompts })}>保存任务提示词</button></details>
            <details><summary>执行记录</summary>{workflow?.events?.length ? workflow.events.map(event => <article key={event.id}>
              <strong>{stageLabels[event.stage]} · {new Date(event.created_at).toLocaleString()}</strong>
              <pre>{event.summary}</pre>{event.details && <pre>{event.details}</pre>}{event.head_sha && <code>{event.head_sha}</code>}
            </article>) : <p>尚无受控流程记录。</p>}</details>
          </section>}
      {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
    </DialogContent>
  </Dialog>;
}
