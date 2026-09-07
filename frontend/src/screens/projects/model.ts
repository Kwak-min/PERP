import { z } from "zod";

const id = z.union([z.string().min(1), z.number().int()]).transform(String);
const projectSchema = z.object({ id, name: z.string(), status: z.string(), description: z.string().nullable().optional(), start_date: z.string().nullable().optional(), end_date: z.string().nullable().optional() });
const taskSchema = z.object({ id, project_id: id.nullable(), title: z.string(), status: z.string(), description: z.string().nullable().optional(), due_at: z.string().nullable().optional(), assignee_id: id.nullable().optional(), version: z.number().int().optional(), project_name: z.string().nullable().optional(), assignee_name: z.string().nullable().optional() });
export type Project = z.infer<typeof projectSchema>;
export type Task = z.infer<typeof taskSchema>;

export function parseProjects(payload: unknown, pg: boolean): Project[] {
  if (!pg) return z.object({ items: z.array(projectSchema) }).parse(payload).items;
  return z.object({ items: z.array(z.object({ __id: id, 프로젝트: z.string(), status: z.string(), 시작: z.string().nullable().optional(), 종료: z.string().nullable().optional() })) }).parse(payload).items
    .map(row => projectSchema.parse({ id: row.__id, name: row.프로젝트, status: row.status, start_date: row.시작, end_date: row.종료 }));
}

export function parseTasks(payload: unknown, pg: boolean): Task[] {
  if (!pg) return z.object({ items: z.array(taskSchema) }).parse(payload).items;
  return z.object({ items: z.array(z.object({ __id: id, project_id: id, 업무: z.string(), status: z.string(), 프로젝트: z.string().nullable().optional(), 담당: z.string().nullable().optional(), 기한: z.string().nullable().optional(), description: z.string().nullable().optional() })) }).parse(payload).items
    .map(row => taskSchema.parse({ id: row.__id, project_id: row.project_id, title: row.업무, status: row.status, project_name: row.프로젝트, assignee_name: row.담당, due_at: row.기한, description: row.description }));
}

export function tasksForProject(tasks: readonly Task[], projectId: string): Task[] {
  return tasks.filter(task => task.project_id === projectId);
}

export function projectProgress(tasks: readonly Task[]): { completed: number; total: number; percent: number } {
  const completed = tasks.filter(task => task.status === "done").length;
  return { completed, total: tasks.length, percent: tasks.length ? Math.round(completed / tasks.length * 100) : 0 };
}

export const taskStatuses = [
  { value: "todo", label: "할 일" }, { value: "in_progress", label: "진행 중" },
  { value: "done", label: "완료" }, { value: "blocked", label: "보류" }, { value: "cancelled", label: "취소" },
] as const;
export function statusLabel(status: string): string { return taskStatuses.find(item => item.value === status)?.label ?? status; }
