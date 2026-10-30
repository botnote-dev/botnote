import { Button } from "@cloudflare/kumo/components/button";
import { CheckCircleIcon, PlusIcon } from "@phosphor-icons/react";
import { format, isSameMonth, isToday } from "date-fns";
import { useMemo, useState } from "react";
import { useProjects, useTasksRange, useUpdateEntity } from "../../api/hooks";
import type { Entity, Project, VirtualOccurrence } from "../../api/types";
import { useElementSize } from "../../hooks/useElementSize";
import { useModals } from "../../state/modals";
import { RecurrenceIcon } from "./icons";
import { sortTasks, type TaskSort } from "./sorting";
import { TaskChip } from "./TaskChip";
import {
  dayKey,
  daysBetween,
  groupTasksByDay,
  groupVirtualsByDay,
  KEEP_ORDER,
  partitionByStatus,
  projectLookup,
  viewRange,
  visibleChipCount
} from "./utils";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Compact chips are h-5 with a 2px gap; the cell body fits whole rows only.
const CHIP_ROW = 20;
const CHIP_GAP = 2;

export function MonthView({
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
  const range = viewRange("month", anchor);
  const days = daysBetween(range.from, range.to);
  const { data: tasksData } = useTasksRange({
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    projectIds: projectIds ?? null,
    includeBacklog: false,
    // includeDone=true so each cell can show its closed/total progress.
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

  return (
    <div className="h-full flex flex-col">
      <div className="grid grid-cols-7 border-b border-kumo-line bg-kumo-tint">
        {WEEKDAYS.map((d) => (
          <div
            key={d}
            className="px-2 py-1 text-xxs uppercase tracking-wider text-kumo-subtle text-center"
          >
            {d}
          </div>
        ))}
      </div>
      <div
        className="flex-1 grid grid-cols-7 bg-kumo-hairline gap-px overflow-y-auto scrollbar-thin"
        style={{ gridTemplateRows: `repeat(${days.length / 7}, minmax(104px, 1fr))` }}
      >
        {days.map((d) => (
          <DayCell
            key={d.toISOString()}
            day={d}
            tasks={byDay.get(dayKey(d)) ?? []}
            virtuals={virtualsByDay.get(dayKey(d)) ?? []}
            projectMap={projectMap}
            outOfMonth={!isSameMonth(d, anchor)}
            today={isToday(d)}
            onOpenDay={onOpenDay}
          />
        ))}
      </div>
    </div>
  );
}

function DayCell({
  day,
  tasks,
  virtuals,
  projectMap,
  outOfMonth,
  today,
  onOpenDay
}: {
  day: Date;
  tasks: Entity[];
  virtuals: VirtualOccurrence[];
  projectMap: Map<string, Project>;
  outOfMonth: boolean;
  today: boolean;
  onOpenDay: (day: Date) => void;
}) {
  const { open: openModal } = useModals();
  const update = useUpdateEntity();
  const [hovered, setHovered] = useState(false);
  const [bodyRef, { height }] = useElementSize<HTMLDivElement>();

  // Closed tasks only count toward the progress bar; the chips are the work
  // still left on that day.
  const { open, closed } = partitionByStatus(tasks, KEEP_ORDER);
  const inProgress = open.filter((t) => t.status === "in_progress").length;
  const slots = Math.floor((height + CHIP_GAP) / (CHIP_ROW + CHIP_GAP));
  const shown = visibleChipCount(open.length, slots);
  const hidden = open.length - shown;

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setHovered(false);
    const id = e.dataTransfer.getData("text/task-id");
    if (!id) return;
    const due = new Date(day);
    due.setHours(12, 0, 0, 0);
    update.mutate({ id, fields: { dueAt: due.toISOString() } });
  }

  return (
    <div
      className={`group min-h-0 p-1 flex flex-col transition-colors ${
        outOfMonth ? "opacity-50" : ""
      } ${
        hovered
          ? "ring-2 ring-kumo-brand ring-inset bg-kumo-brand-tint"
          : today
            ? "ring-1 ring-kumo-brand ring-inset bg-kumo-brand-tint/40"
            : "bg-kumo-base"
      }`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!hovered) setHovered(true);
      }}
      onDragLeave={() => setHovered(false)}
      onDrop={onDrop}
    >
      <div className="flex items-center gap-1.5 px-1 h-5">
        <button
          type="button"
          onClick={() => onOpenDay(day)}
          title="Open in Day view"
          className={`text-xs tabular-nums hover:text-kumo-link ${
            today ? "font-semibold text-kumo-brand" : "text-kumo-subtle"
          }`}
        >
          {format(day, "d")}
        </button>
        {tasks.length > 0 && (
          <span
            className={`text-xxs tabular-nums ${
              closed.length === tasks.length ? "text-kumo-success font-medium" : "text-kumo-placeholder"
            }`}
            title={`${closed.length} closed · ${tasks.length} total`}
          >
            {closed.length}/{tasks.length}
          </span>
        )}
        {virtuals.length > 0 && <RecurringBadge virtuals={virtuals} />}
        <Button
          variant="ghost"
          size="xs"
          shape="square"
          icon={<PlusIcon size={12} />}
          aria-label="Add task"
          className="ml-auto size-5 text-kumo-subtle opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-kumo-brand"
          onClick={() => openModal({ kind: "quick-create" })}
        />
      </div>
      <DayProgress
        total={tasks.length}
        closed={closed.length}
        inProgress={inProgress}
        className="mx-1 mt-0.5 mb-1"
      />
      <div ref={bodyRef} className="flex-1 min-h-0 overflow-hidden space-y-0.5">
        {open.slice(0, shown).map((t) => (
          <TaskChip
            key={t.id}
            task={t}
            project={t.projectId ? projectMap.get(t.projectId) : undefined}
            compact
          />
        ))}
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => onOpenDay(day)}
            className="w-full h-5 px-1.5 rounded text-left text-xxs text-kumo-subtle hover:bg-kumo-fill hover:text-kumo-link transition-colors"
          >
            +{hidden} more
          </button>
        )}
        {open.length === 0 && closed.length > 0 && (
          <button
            type="button"
            onClick={() => onOpenDay(day)}
            className="w-full h-5 px-1.5 flex items-center gap-1 rounded text-xxs text-kumo-subtle hover:bg-kumo-fill hover:text-kumo-default transition-colors"
          >
            <CheckCircleIcon size={11} weight="fill" className="shrink-0 text-kumo-success" />
            <span className="tabular-nums">{closed.length} done</span>
          </button>
        )}
      </div>
    </div>
  );
}

/** Thin closed/in-progress bar under the day header; an empty day keeps the space. */
function DayProgress({
  total,
  closed,
  inProgress,
  className = ""
}: {
  total: number;
  closed: number;
  inProgress: number;
  className?: string;
}) {
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <div
      className={`flex h-[3px] shrink-0 overflow-hidden rounded-full ${total > 0 ? "bg-kumo-fill" : ""} ${className}`}
      aria-hidden
    >
      {total > 0 && (
        <>
          <span className="h-full bg-(--color-kumo-success)" style={{ width: pct(closed) }} />
          <span className="h-full bg-(--color-kumo-warning)" style={{ width: pct(inProgress) }} />
        </>
      )}
    </div>
  );
}

/** Upcoming recurring occurrences, folded into a "↻N" badge with their titles on hover. */
function RecurringBadge({ virtuals }: { virtuals: VirtualOccurrence[] }) {
  const titles = virtuals.map((v) => (v.title && v.title.trim() ? v.title : "Untitled"));
  return (
    <span
      className="inline-flex items-center gap-0.5 text-xxs tabular-nums text-kumo-placeholder"
      title={`Upcoming recurring:\n${titles.join("\n")}`}
      aria-label={`${virtuals.length} upcoming recurring: ${titles.join(", ")}`}
    >
      <RecurrenceIcon size={10} />
      {virtuals.length}
    </span>
  );
}
