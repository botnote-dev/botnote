import { Button } from "@cloudflare/kumo/components/button";
import { PlusIcon } from "@phosphor-icons/react";
import { format, isToday } from "date-fns";
import { useMemo } from "react";
import { useProjects, useTasksRange } from "../../api/hooks";
import type { Entity } from "../../api/types";
import { useModals } from "../../state/modals";
import { TaskRow } from "./TaskRow";
import { sortTasks, type TaskSort } from "./sorting";
import { isTaskOverdue, projectLookup, viewRange } from "./utils";

export function DayView({
  anchor,
  projectIds,
  sort
}: {
  anchor: Date;
  projectIds: string[] | null;
  sort: TaskSort;
}) {
  const range = viewRange("day", anchor);
  const { data: tasksData } = useTasksRange({
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    projectIds: projectIds ?? null,
    includeBacklog: false,
    // includeDone=true so the day's completed work shows up on its
    // completion day, which is the primary daily review surface.
    includeDone: true
  });
  const { data: projects } = useProjects();
  const projectMap = useMemo(() => projectLookup(projects), [projects]);
  const { open } = useModals();

  const overdue = sortTasks(
    (tasksData?.overdue ?? []).filter((t) => isTaskOverdue(t, anchor)),
    sort,
    projectMap
  );
  const today = sortTasks(tasksData?.scheduled ?? [], sort, projectMap);
  const isCurrentDay = isToday(anchor);

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="max-w-4xl mx-auto py-4">
        {isCurrentDay && overdue.length > 0 && (
          <Section
            title={`Overdue`}
            count={overdue.length}
            accent="text-kumo-danger"
            tasks={overdue}
            projectMap={projectMap}
          />
        )}

        <Section
          title={isCurrentDay ? "Today" : format(anchor, "EEEE")}
          count={today.length}
          accent="text-kumo-default"
          tasks={today}
          projectMap={projectMap}
          emptyAction={
            <Button
              variant="ghost"
              size="sm"
              icon={<PlusIcon size={14} />}
              className="text-kumo-link"
              onClick={() => open({ kind: "quick-create" })}
            >
              Add a task for this day
            </Button>
          }
        />
      </div>
    </div>
  );
}

function Section({
  title,
  count,
  accent,
  tasks,
  projectMap,
  emptyAction
}: {
  title: string;
  count: number;
  accent: string;
  tasks: Entity[];
  projectMap: Map<string, ReturnType<typeof projectLookup> extends Map<string, infer P> ? P : never>;
  emptyAction?: React.ReactNode;
}) {
  return (
    <section className="mb-6">
      <div className="px-4 py-1.5 flex items-baseline gap-2 sticky top-0 bg-kumo-canvas z-10">
        <h2 className={`text-xs font-semibold ${accent}`}>{title}</h2>
        <span className="text-xxs text-kumo-subtle tabular-nums">{count}</span>
      </div>
      {tasks.length === 0 ? (
        <div className="mx-4 flex min-h-12 items-center justify-center rounded-lg border border-dashed border-kumo-line px-3 py-2 text-xs text-kumo-subtle">
          {emptyAction ?? "Nothing here."}
        </div>
      ) : (
        <div className="mx-4 overflow-hidden rounded-lg border border-kumo-line bg-kumo-base [&>*:last-child]:border-b-0">
          {tasks.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              project={t.projectId ? projectMap.get(t.projectId) : undefined}
            />
          ))}
        </div>
      )}
    </section>
  );
}
