import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { ArrowLineRightIcon, TrayIcon } from "@phosphor-icons/react";
import { useMemo } from "react";
import { useProjects, useTasksRange } from "../../api/hooks";
import type { Entity, Project } from "../../api/types";
import { TaskRow } from "./TaskRow";
import { sortTasks, type TaskSort } from "./sorting";
import { projectLookup } from "./utils";

export function InboxRail({
  projectIds,
  sort,
  collapsed,
  onToggle
}: {
  projectIds: string[] | null;
  sort: TaskSort;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { data: tasksData } = useTasksRange({
    projectIds: projectIds ?? null,
    includeBacklog: true,
    includeDone: false
  });
  const { data: projects } = useProjects();
  const projectMap = useMemo(() => projectLookup(projects), [projects]);
  const inboxTasks = (tasksData?.backlog ?? []).filter((t) => t.status !== "rejected");

  // Group by project so rows don't need per-row project keys.
  const groups = useMemo(() => {
    const byProject = new Map<string | null, Entity[]>();
    for (const t of inboxTasks) {
      const key = t.projectId ?? null;
      const list = byProject.get(key);
      if (list) list.push(t);
      else byProject.set(key, [t]);
    }
    const entries: { project: Project | undefined; tasks: Entity[] }[] = [];
    for (const [pid, tasks] of byProject) {
      entries.push({ project: pid ? projectMap.get(pid) : undefined, tasks: sortTasks(tasks, sort, projectMap) });
    }
    entries.sort((a, b) => {
      if (!a.project) return 1;
      if (!b.project) return -1;
      return a.project.key.localeCompare(b.project.key);
    });
    return entries;
  }, [inboxTasks, projectMap, sort]);

  if (collapsed) {
    return (
      <button
        type="button"
        className="group flex w-9 shrink-0 flex-col items-center gap-2 border-l border-kumo-line bg-kumo-tint pt-2.5 transition-colors hover:bg-kumo-fill"
        onClick={onToggle}
        title="Expand Inbox"
        aria-label={`Expand Inbox (${inboxTasks.length})`}
      >
        <TrayIcon size={16} className="text-kumo-subtle group-hover:text-kumo-default" />
        {inboxTasks.length > 0 && (
          <Badge variant="outline" className="px-1.5 py-0 text-[10px] tabular-nums">
            {inboxTasks.length}
          </Badge>
        )}
      </button>
    );
  }

  return (
    <aside className="shrink-0 w-72 border-l border-kumo-line bg-kumo-base flex flex-col">
      <div className="px-3 h-9 flex items-center justify-between border-b border-kumo-hairline">
        <div className="flex items-center gap-2 text-kumo-subtle">
          <TrayIcon size={14} />
          <h2 className="text-xs font-semibold text-kumo-default">Inbox</h2>
          <span className="text-xxs text-kumo-subtle tabular-nums">{inboxTasks.length}</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          icon={<ArrowLineRightIcon size={14} />}
          aria-label="Collapse Inbox"
          className="text-kumo-subtle"
          onClick={onToggle}
        />
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {inboxTasks.length === 0 ? (
          <div className="text-xs text-kumo-subtle text-center py-8 px-4">
            No tasks without due date.
            <div className="text-kumo-placeholder mt-1">Tasks without due date appear here.</div>
          </div>
        ) : (
          groups.map(({ project, tasks }) => (
            <div key={project?.id ?? "none"}>
              <div className="sticky top-0 z-10 flex items-center gap-1.5 px-3 py-1 bg-kumo-tint border-b border-kumo-hairline">
                <span
                  className="font-mono text-xxs font-medium tabular-nums"
                  style={project ? { color: project.color } : undefined}
                >
                  {project?.key ?? "—"}
                </span>
                <span className="text-xxs text-kumo-subtle truncate">
                  {project?.name ?? "No project"}
                </span>
                <span className="ml-auto text-xxs text-kumo-placeholder tabular-nums">{tasks.length}</span>
              </div>
              {tasks.map((t) => (
                <TaskRow key={t.id} task={t} project={project} showProject={false} compact />
              ))}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
