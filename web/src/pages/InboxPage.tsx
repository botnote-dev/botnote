import { TrayIcon } from "@phosphor-icons/react";
import { useMemo } from "react";
import type { Entity, Project } from "../api/types";
import { useProjects, useTasksRange } from "../api/hooks";
import { ProjectIcon } from "../components/ProjectIcon";
import { AssigneeFilter } from "../components/tasks/AssigneeFilter";
import { TaskRow } from "../components/tasks/TaskRow";
import { projectLookup } from "../components/tasks/utils";
import { useModals } from "../state/modals";

const PRIORITY_ORDER: Record<string, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4
};

export function InboxPage() {
  const { data: tasksData, isLoading } = useTasksRange({
    includeBacklog: true,
    includeDone: false
  });
  const { data: projects } = useProjects();
  const projectMap = useMemo(() => projectLookup(projects), [projects]);
  const { open: openModal } = useModals();

  const groups = useMemo(() => groupInboxTasks(tasksData?.backlog ?? [], projectMap), [
    tasksData,
    projectMap
  ]);
  const totalCount = groups.reduce((sum, group) => sum + group.tasks.length, 0);

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="max-w-3xl mx-auto px-6 py-6 space-y-4">
        <header className="flex items-baseline gap-3">
          <TrayIcon size={18} className="text-kumo-brand" />
          <h1 className="text-lg font-semibold">Inbox</h1>
          <span className="text-xs text-kumo-subtle">Tasks without due date</span>
          <AssigneeFilter className="ml-auto" />
        </header>

        <p className="text-xs text-kumo-subtle">
          Tasks land here until they get a due date.
        </p>

        {isLoading ? (
          <div className="text-sm text-kumo-subtle">Loading…</div>
        ) : totalCount === 0 ? (
          <div className="border border-dashed border-kumo-line rounded-md p-8 text-center">
            <div className="text-sm text-kumo-subtle">Inbox empty.</div>
            {projects && projects.length > 0 && (
              <button
                className="mt-2 text-xs text-kumo-brand hover:underline"
                onClick={() => openModal({ kind: "quick-create" })}
              >
                + capture something
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {groups.map(({ projectId, project, tasks }) => (
              <section
                key={projectId ?? "_none"}
                className="border border-kumo-line rounded-md bg-kumo-base overflow-hidden"
              >
                <div className="px-3 py-1.5 border-b border-kumo-hairline bg-kumo-tint/40 flex items-center gap-1.5 text-xxs">
                  {project ? (
                    <>
                      <ProjectIcon color={project.color} icon={project.icon} size={10} />
                      <span className="font-mono tabular-nums" style={{ color: project.color }}>
                        {project.key}
                      </span>
                      <span className="text-kumo-subtle truncate">{project.name}</span>
                    </>
                  ) : (
                    <span className="text-kumo-placeholder">no project</span>
                  )}
                  <span className="text-kumo-placeholder ml-auto tabular-nums">{tasks.length}</span>
                </div>
                {tasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    project={task.projectId ? projectMap.get(task.projectId) : undefined}
                  />
                ))}
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function groupInboxTasks(tasks: Entity[], projectMap: Map<string, Project>) {
  const grouped = new Map<string | null, Entity[]>();
  for (const task of tasks) {
    const projectId = task.projectId ?? null;
    if (!grouped.has(projectId)) grouped.set(projectId, []);
    grouped.get(projectId)!.push(task);
  }

  return Array.from(grouped.entries())
    .map(([projectId, rows]) => ({
      projectId,
      project: projectId ? projectMap.get(projectId) : undefined,
      tasks: rows.slice().sort(compareInboxTasks)
    }))
    .sort((a, b) => {
      if (!a.project && !b.project) return 0;
      if (!a.project) return 1;
      if (!b.project) return -1;
      return a.project.key.localeCompare(b.project.key);
    });
}

function compareInboxTasks(a: Entity, b: Entity): number {
  const priorityDiff = (PRIORITY_ORDER[a.priority] ?? 5) - (PRIORITY_ORDER[b.priority] ?? 5);
  if (priorityDiff !== 0) return priorityDiff;
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}
