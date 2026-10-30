import { Button } from "@cloudflare/kumo/components/button";
import { PlusIcon } from "@phosphor-icons/react";
import { addDays, format, isSameWeek, isToday } from "date-fns";
import { useMemo, useState } from "react";
import { useProjects, useTasksRange, useUpdateEntity } from "../../api/hooks";
import type { Entity, Project, VirtualOccurrence } from "../../api/types";
import { useElementSize } from "../../hooks/useElementSize";
import { useModals } from "../../state/modals";
import { ClosedTasksToggle, GhostChips, TaskChip } from "./TaskChip";
import { sortTasks, type TaskSort } from "./sorting";
import { dayKey, daysBetween, groupTasksByDay, groupVirtualsByDay, KEEP_ORDER, partitionByStatus, projectLookup, viewRange } from "./utils";

// Below this width a single Mon–Sun row squeezes chips too far, so the week
// wraps into two rows of four.
const SINGLE_ROW_MIN_WIDTH = 7 * 160;

export function WeekView({
  anchor,
  projectIds,
  sort,
  onOpenDay
}: {
  anchor: Date;
  projectIds: string[] | null;
  sort: TaskSort;
  onOpenDay: (day: Date) => void;
}) {
  const range = viewRange("week", anchor);
  // The two-row layout shows Mon-Sun plus next Monday as a "peek" cell so the
  // bottom row also has 4 columns (matches the top row visually).
  const weekDays = daysBetween(range.from, range.to);
  const nextMonday = addDays(weekDays[weekDays.length - 1]!, 1);
  const days = [...weekDays, nextMonday];

  // Extend the query range by one day so next Monday's tasks come through.
  const queryTo = new Date(nextMonday);
  queryTo.setHours(23, 59, 59, 999);

  const { data: tasksData } = useTasksRange({
    from: range.from.toISOString(),
    to: queryTo.toISOString(),
    projectIds: projectIds ?? null,
    includeBacklog: false,
    // includeDone=true so each day cell can show "done/total" counts and the
    // chips list shows completed tasks (struck-through, à la Linear).
    includeDone: true,
    includeVirtualRecurrences: true
  });
  const { data: projects } = useProjects();
  const projectMap = useMemo(() => projectLookup(projects), [projects]);
  const byDay = useMemo(
    () => groupTasksByDay(sortTasks(tasksData?.scheduled ?? [], sort, projectMap)),
    [tasksData, sort, projectMap]
  );
  const virtualsByDay = useMemo(
    () => groupVirtualsByDay(tasksData?.virtualOccurrences ?? []),
    [tasksData]
  );

  const [rootRef, { width }] = useElementSize<HTMLDivElement>();
  const rows = width >= SINGLE_ROW_MIN_WIDTH ? [weekDays] : [days.slice(0, 4), days.slice(4)];

  return (
    <div ref={rootRef} className="h-full flex flex-col bg-kumo-canvas">
      {rows.map((row) => (
        <DayRow
          key={row[0]!.toISOString()}
          days={row}
          byDay={byDay}
          virtualsByDay={virtualsByDay}
          projectMap={projectMap}
          anchor={anchor}
          onOpenDay={onOpenDay}
        />
      ))}
    </div>
  );
}

function DayRow({
  days,
  byDay,
  virtualsByDay,
  projectMap,
  anchor,
  onOpenDay
}: {
  days: Date[];
  byDay: Map<string, Entity[]>;
  virtualsByDay: Map<string, VirtualOccurrence[]>;
  projectMap: Map<string, Project>;
  anchor: Date;
  onOpenDay: (day: Date) => void;
}) {
  return (
    <div className="flex-1 min-h-0 flex border-b border-kumo-line last:border-b-0">
      {days.map((d) => {
        const tasks = byDay.get(dayKey(d)) ?? [];
        const virtuals = virtualsByDay.get(dayKey(d)) ?? [];
        const outOfWeek = !isSameWeek(d, anchor, { weekStartsOn: 1 });
        return (
          <DayCell
            key={d.toISOString()}
            day={d}
            tasks={tasks}
            virtuals={virtuals}
            projectMap={projectMap}
            outOfWeek={outOfWeek}
            onOpenDay={onOpenDay}
          />
        );
      })}
    </div>
  );
}

function DayCell({
  day,
  tasks,
  virtuals,
  projectMap,
  outOfWeek,
  onOpenDay
}: {
  day: Date;
  tasks: Entity[];
  virtuals: VirtualOccurrence[];
  projectMap: Map<string, Project>;
  outOfWeek: boolean;
  onOpenDay: (day: Date) => void;
}) {
  const today = isToday(day);
  const { open: openModal } = useModals();
  const update = useUpdateEntity();
  const [showClosed, setShowClosed] = useState(false);

  // In progress first, then todo; closed tasks fold into one row so the
  // remaining work stays visible.
  const { open, closed } = partitionByStatus(tasks, KEEP_ORDER);
  const totalCount = tasks.length;
  const allClosed = totalCount > 0 && closed.length === totalCount;

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/task-id");
    if (!id) return;
    const due = new Date(day);
    due.setHours(12, 0, 0, 0);
    update.mutate({ id, fields: { dueAt: due.toISOString() } });
  }

  return (
    <div
      className={`flex-1 min-w-0 border-r border-kumo-hairline last:border-r-0 flex flex-col group/col ${
        today ? "bg-kumo-brand-tint/40" : outOfWeek ? "bg-kumo-recessed" : "bg-kumo-base"
      }`}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <div className="px-3 py-1.5 flex items-center justify-between border-b border-kumo-hairline">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-xxs uppercase tracking-wider text-kumo-subtle">
            {format(day, "EEE")}
          </span>
          <button
            type="button"
            onClick={() => onOpenDay(day)}
            title="Open in Day view"
            className={`text-sm tabular-nums font-semibold hover:text-kumo-link ${
              today ? "text-kumo-brand" : outOfWeek ? "text-kumo-subtle" : "text-kumo-default"
            }`}
          >
            {format(day, "d")}
          </button>
          {totalCount > 0 && (
            <span
              className={`text-xxs tabular-nums ${
                allClosed ? "text-kumo-success font-medium" : "text-kumo-placeholder"
              }`}
              title={`${closed.length} closed · ${totalCount} total`}
            >
              {closed.length}/{totalCount}
            </span>
          )}
          {outOfWeek && (
            <span className="text-xxs text-kumo-placeholder italic">next</span>
          )}
        </div>
        <Button
          variant="ghost"
          size="xs"
          shape="square"
          icon={<PlusIcon size={12} />}
          aria-label="Add task"
          className="size-5 text-kumo-subtle opacity-0 group-hover/col:opacity-100 focus-visible:opacity-100 hover:text-kumo-brand"
          onClick={() => openModal({ kind: "quick-create" })}
        />
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin p-1.5 space-y-1">
        {totalCount === 0 && virtuals.length === 0 ? (
          <div className="text-xxs text-kumo-placeholder px-1 py-0.5">—</div>
        ) : (
          <>
            {open.map((t) => (
              <TaskChip
                key={t.id}
                task={t}
                project={t.projectId ? projectMap.get(t.projectId) : undefined}
              />
            ))}
            <GhostChips virtuals={virtuals} projectMap={projectMap} />
            {closed.length > 0 && (
              <ClosedTasksToggle
                tasks={closed}
                expanded={showClosed}
                onToggle={() => setShowClosed(!showClosed)}
              />
            )}
            {showClosed &&
              closed.map((t) => (
                <TaskChip
                  key={t.id}
                  task={t}
                  project={t.projectId ? projectMap.get(t.projectId) : undefined}
                />
              ))}
          </>
        )}
      </div>
    </div>
  );
}
