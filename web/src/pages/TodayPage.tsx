import { format, isToday } from "date-fns";
import { PlusIcon, SunHorizonIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { useProjects, useTasksRange, useWriteEntity } from "../api/hooks";
import type { Entity, Project } from "../api/types";
import { ProjectIcon } from "../components/ProjectIcon";
import { TaskRow } from "../components/tasks/TaskRow";
import { groupTasks, sortTasks, type TaskGroup, type TaskSort } from "../components/tasks/sorting";
import { isTaskOverdue, projectLookup } from "../components/tasks/utils";
import { ViewOptionsMenu } from "../components/tasks/ViewOptionsMenu";
import { usePersistedState } from "../hooks/usePersistedState";
import { useModals } from "../state/modals";

export function TodayPage() {
  const today = new Date();
  const { data: projects } = useProjects();
  const projectMap = useMemo(() => projectLookup(projects), [projects]);
  const [sort, setSort] = usePersistedState<TaskSort>("botnote.today.sort", "status");
  const [group, setGroup] = usePersistedState<TaskGroup>("botnote.today.group", "project");

  const todayRange = useMemo(() => {
    const from = new Date(today);
    from.setHours(0, 0, 0, 0);
    const to = new Date(today);
    to.setHours(23, 59, 59, 999);
    return { from: from.toISOString(), to: to.toISOString() };
  }, []);

  const { data, isLoading } = useTasksRange({
    from: todayRange.from,
    to: todayRange.to,
    includeBacklog: false,
    includeDone: true
  });

  const { open } = useModals();
  const overdue = sortTasks(
    (data?.overdue ?? []).filter((t) => isTaskOverdue(t, today)),
    sort,
    projectMap
  );
  const scheduled = sortTasks(data?.scheduled ?? [], sort, projectMap);
  const total = overdue.length + scheduled.length;
  const done = scheduled.filter((t) => t.status === "done").length;

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="max-w-3xl mx-auto px-6 py-6 space-y-6">
        <header className="space-y-3">
          <div className="flex items-center gap-3">
            <SunHorizonIcon size={18} className="text-kumo-brand" />
            <h1 className="text-lg font-semibold">Today</h1>
            <span className="text-xs text-kumo-subtle">{format(today, "EEEE, MMM d")}</span>
            <div className="ml-auto">
              <ViewOptionsMenu sort={sort} setSort={setSort} group={group} setGroup={setGroup} />
            </div>
          </div>
          {!isLoading && total > 0 && <Progress done={done} total={total} />}
        </header>

        {isLoading && <div className="text-sm text-kumo-subtle">Loading…</div>}

        {!isLoading && (
          <>
            <Section
              title="Overdue"
              count={overdue.length}
              accent="text-kumo-danger"
              tasks={overdue}
              group={group}
              projectMap={projectMap}
            />
            <Section
              title={isToday(today) ? "Today" : format(today, "EEEE")}
              count={scheduled.length}
              accent="text-kumo-default"
              tasks={scheduled}
              group={group}
              projectMap={projectMap}
              emptyAction={
                <button
                  className="text-kumo-brand text-xs hover:underline"
                  onClick={() => open({ kind: "quick-create" })}
                >
                  + add a task
                </button>
              }
            />
            <QuickAdd />
          </>
        )}
      </div>
    </div>
  );
}

function Progress({ done, total }: { done: number; total: number }) {
  const pct = Math.round((done / total) * 100);
  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="tabular-nums text-kumo-default">
        <span className="font-semibold">{done}</span>
        <span className="text-kumo-subtle"> / {total} done</span>
      </span>
      <div
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-kumo-fill"
        role="progressbar"
        aria-valuenow={done}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label="Tasks done today"
      >
        <div className="h-full rounded-full bg-kumo-brand transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="tabular-nums text-kumo-subtle">{pct}%</span>
    </div>
  );
}

/**
 * Inline quick-add: type a title, hit Enter, and the task lands on today's
 * list (due at local noon, matching calendar drag-drop). Stays on the page —
 * no modal round-trip for the common "one more thing today" capture.
 */
function QuickAdd() {
  const [title, setTitle] = useState("");
  const write = useWriteEntity();

  function submit() {
    const trimmed = title.trim();
    if (!trimmed || write.isPending) return;
    const due = new Date();
    due.setHours(12, 0, 0, 0);
    write.mutate(
      { kind: "task", title: trimmed, dueAt: due.toISOString() },
      { onSuccess: () => setTitle("") }
    );
  }

  return (
    <div className="flex items-center gap-2 border border-dashed border-kumo-line rounded-md px-3 py-1.5 focus-within:border-kumo-brand transition-colors">
      <PlusIcon size={12} className="text-kumo-placeholder shrink-0" />
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        placeholder="Add a task for today…"
        aria-label="Add a task for today"
        className="flex-1 bg-transparent text-xs outline-hidden placeholder:text-kumo-placeholder"
        disabled={write.isPending}
      />
      {write.isPending && <span className="text-xxs text-kumo-placeholder">Adding…</span>}
    </div>
  );
}

function Section({
  title,
  count,
  accent,
  tasks,
  group,
  projectMap,
  emptyAction
}: {
  title: string;
  count: number;
  accent: string;
  tasks: Entity[];
  group: TaskGroup;
  projectMap: Map<string, Project>;
  emptyAction?: React.ReactNode;
}) {
  if (tasks.length === 0 && !emptyAction) return null;
  const buckets = groupTasks(tasks, group, projectMap);

  return (
    <section className="space-y-1.5">
      <div className="flex items-baseline gap-2">
        <h2 className={`text-xs font-semibold ${accent}`}>{title}</h2>
        <span className="text-xxs text-kumo-placeholder tabular-nums">{count}</span>
      </div>
      {tasks.length === 0 ? (
        <div className="text-xs text-kumo-subtle py-1">{emptyAction ?? "Nothing here."}</div>
      ) : (
        <div className="border border-kumo-line rounded-md overflow-hidden bg-kumo-base">
          {buckets.map((bucket) => (
            <div key={bucket.key}>
              {group !== "none" && (
                <div className="px-3 py-1 border-b border-kumo-hairline bg-kumo-tint/40 flex items-center gap-1.5 text-xxs">
                  {group === "project" && bucket.project ? (
                    <>
                      <ProjectIcon color={bucket.project.color} icon={bucket.project.icon} size={10} />
                      <span className="font-mono tabular-nums" style={{ color: bucket.project.color }}>
                        {bucket.project.key}
                      </span>
                      <span className="text-kumo-subtle truncate">{bucket.project.name}</span>
                    </>
                  ) : (
                    <span className={group === "project" ? "text-kumo-placeholder" : "text-kumo-subtle"}>
                      {bucket.label}
                    </span>
                  )}
                  <span className="text-kumo-placeholder ml-auto tabular-nums">{bucket.tasks.length}</span>
                </div>
              )}
              {bucket.tasks.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  project={t.projectId ? projectMap.get(t.projectId) : undefined}
                  showProject={group !== "project"}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
