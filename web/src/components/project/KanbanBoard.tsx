import { AssigneeButton } from "../tasks/Assignee";
import { Button } from "@cloudflare/kumo/components/button";
import { PlusIcon } from "@phosphor-icons/react";
import { format } from "date-fns";
import { useState } from "react";
import { useUpdateEntity } from "../../api/hooks";
import type { Entity, Project } from "../../api/types";
import { useDrawer } from "../../hooks/useDrawer";
import { displayTitle, isUntitled } from "../../lib/entityTitle";
import { TagChip } from "../TagChip";
import { ParentChip, SubtaskProgress } from "../tasks/hierarchy";
import { PriorityIcon, RecurrenceIcon, StatusCircle } from "../tasks/icons";
import { isRecurring, isTaskOverdue } from "../tasks/utils";
import { StatusPickerButton } from "../tasks/StatusPickerButton";
import { useModals } from "../../state/modals";

const COLUMNS: Array<{ status: string; label: string }> = [
  { status: "open", label: "Todo" },
  { status: "in_progress", label: "In Progress" },
  { status: "done", label: "Done" },
  { status: "rejected", label: "Cancelled" }
];

export function KanbanBoard({
  tasks,
  project
}: {
  tasks: Entity[];
  project: Project;
}) {
  const update = useUpdateEntity();
  const { open } = useModals();
  const byStatus: Record<string, Entity[]> = {};
  for (const c of COLUMNS) byStatus[c.status] = [];
  for (const t of tasks) {
    const key = COLUMNS.find((c) => c.status === t.status)?.status ?? "open";
    byStatus[key]!.push(t);
  }
  // Done reads as a recency log, newest completion first.
  byStatus.done!.sort(
    (a, b) =>
      +new Date(b.completedAt ?? b.updatedAt) - +new Date(a.completedAt ?? a.updatedAt)
  );

  function handleDrop(toStatus: string, taskId: string) {
    update.mutate({ id: taskId, fields: { status: toStatus } });
  }

  return (
    <div className="h-full overflow-x-auto overflow-y-hidden">
      <div className="h-full flex gap-3 p-3 min-w-max">
        {COLUMNS.map((col) => (
          <KanbanColumn
            key={col.status}
            status={col.status}
            label={col.label}
            tasks={byStatus[col.status] ?? []}
            project={project}
            onDropTask={(id) => handleDrop(col.status, id)}
            onAdd={() => open({ kind: "quick-create", projectId: project.id })}
            initialLimit={col.status === "done" ? 8 : undefined}
          />
        ))}
      </div>
    </div>
  );
}

function KanbanColumn({
  status,
  label,
  tasks,
  project,
  onDropTask,
  onAdd,
  initialLimit
}: {
  status: string;
  label: string;
  tasks: Entity[];
  project: Project;
  onDropTask: (id: string) => void;
  onAdd: () => void;
  initialLimit?: number;
}) {
  const [over, setOver] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const limited = initialLimit != null && !showAll ? tasks.slice(0, initialLimit) : tasks;
  const hiddenCount = tasks.length - limited.length;
  return (
    <div
      className={`w-72 shrink-0 flex flex-col rounded-lg border ${
        over ? "border-kumo-brand bg-kumo-brand-tint/40" : "border-kumo-line bg-kumo-recessed"
      } transition-colors`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!over) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const id = e.dataTransfer.getData("text/task-id");
        if (id) onDropTask(id);
      }}
    >
      <div className="px-3 h-9 flex items-center justify-between border-b border-kumo-line">
        <div className="flex items-center gap-2">
          <StatusCircle status={status} size={12} />
          <span className="text-xs font-semibold text-kumo-default">{label}</span>
          <span className="text-xxs text-kumo-subtle tabular-nums">{tasks.length}</span>
        </div>
        <Button
          variant="ghost"
          size="xs"
          shape="square"
          icon={<PlusIcon size={12} />}
          aria-label={`Add ${label} task`}
          className="size-5 text-kumo-subtle hover:text-kumo-brand"
          onClick={onAdd}
        />
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin p-2 space-y-1.5">
        {tasks.length === 0 ? (
          <div className="text-xxs text-kumo-placeholder text-center py-4">No tasks</div>
        ) : (
          <>
            {limited.map((t) => (
              <KanbanCard key={t.id} task={t} project={project} />
            ))}
            {hiddenCount > 0 && (
              <Button
                variant="ghost"
                size="xs"
                className="w-full justify-center text-kumo-subtle"
                onClick={() => setShowAll(true)}
              >
                Show all {tasks.length}
              </Button>
            )}
            {showAll && initialLimit != null && tasks.length > initialLimit && (
              <Button
                variant="ghost"
                size="xs"
                className="w-full justify-center text-kumo-subtle"
                onClick={() => setShowAll(false)}
              >
                Show latest {initialLimit}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function KanbanCard({ task, project }: { task: Entity; project: Project }) {
  const drawer = useDrawer();
  const overdue = isTaskOverdue(task);
  const idLabel = task.sequenceId ? `${project.key}-${task.sequenceId}` : null;
  const visibleDate = task.status === "done" ? (task.completedAt ?? task.updatedAt) : task.dueAt;
  const visibleDateLabel = task.status === "done" ? "Completed" : "Due";

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/task-id", task.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={() => drawer.open(task.id)}
      className="group bg-kumo-base border border-kumo-line rounded-lg p-2.5 shadow-xs cursor-grab active:cursor-grabbing hover:border-kumo-brand transition-colors"
    >
      {task.parent && <ParentChip parent={task.parent} variant="line" className="mb-1" />}
      <div className="flex items-start gap-1.5">
        <StatusPickerButton task={task} size={13} className="mt-0.5" />
        <span
          className={`flex-1 min-w-0 text-sm leading-snug ${
            // No strikethrough here: the Done column already says it, and a
            // whole column of struck text is unreadable.
            task.status === "done" || task.status === "rejected"
              ? "text-kumo-subtle"
              : isUntitled(task)
                ? "italic text-kumo-subtle"
                : "text-kumo-default"
          }`}
        >
          {displayTitle(task)}
        </span>
        {isRecurring(task) && (
          <RecurrenceIcon size={11} className="text-kumo-subtle mt-0.5" />
        )}
        <PriorityIcon priority={task.priority} size={11} />
      </div>
      {/* Key and date never wrap or shrink; long tags ellipsize instead. */}
      <div className="mt-1.5 flex items-center gap-2 overflow-hidden text-xxs text-kumo-subtle">
        {idLabel && (
          <span className="font-mono tabular-nums shrink-0 whitespace-nowrap">{idLabel}</span>
        )}
        {visibleDate && (
          <span
            className={`tabular-nums shrink-0 whitespace-nowrap ${
              overdue ? "text-kumo-danger font-medium" : ""
            }`}
            title={`${visibleDateLabel} ${new Date(visibleDate).toLocaleString()}`}
          >
            {format(new Date(visibleDate), "MMM d")}
          </span>
        )}
        {task.subtasks && <SubtaskProgress counts={task.subtasks} />}
        {task.tags.slice(0, 2).map((t) => (
          <TagChip key={t} tag={t} className="py-0 text-[10px]" />
        ))}
        <AssigneeButton task={task} size={16} className="ml-auto" />
      </div>
    </div>
  );
}
