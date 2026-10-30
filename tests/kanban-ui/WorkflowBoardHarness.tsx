import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProjectProvider } from '@/contexts/ProjectContext';
import WorkflowBoard, { type KanbanColumns } from './TaskKanbanBoard';
import type { TaskStatus, TaskWithAttemptStatus } from 'shared/types';
import '@/i18n';
import '@/styles/legacy/index.css';

const projectId = '11111111-1111-4111-8111-111111111111';
const query = new QueryClient();
function Harness() {
  const [tasks, setTasks] = useState<TaskWithAttemptStatus[]>([]);
  const [opened, setOpened] = useState('');
  const refresh = async () => setTasks((await (await fetch('/api/tasks')).json()).data);
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 1500); return () => clearInterval(timer); }, []);
  const columns: KanbanColumns = { todo: [], inprogress: [], inreview: [], done: [], cancelled: [] };
  tasks.forEach(task => columns[task.status].push(task));
  return <><output aria-label="打开的任务">{opened}</output><div style={{ height: 'calc(100vh - 25px)' }}><WorkflowBoard columns={columns} projectId={projectId} onViewTaskDetails={task => setOpened(task.title)} onCreateTask={() => setOpened('create')}
    onDragEnd={async event => {
      if (!event.over) return;
      await fetch(`/api/tasks/${event.active.id}`, { method: 'PUT', body: JSON.stringify({ id: event.active.id, status: event.over.id as TaskStatus }) });
      await refresh();
    }} /></div></>;
}
document.body.classList.add('legacy-design');
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={query}><HotkeysProvider><MemoryRouter initialEntries={[`/projects/${projectId}/tasks`]}><ProjectProvider><Harness /></ProjectProvider></MemoryRouter></HotkeysProvider></QueryClientProvider>);
