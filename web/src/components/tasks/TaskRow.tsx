import { Badge } from "@cloudflare/kumo/components/badge";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { TrashIcon } from "@phosphor-icons/react";
import { format } from "date-fns";
import { useUpdateEntity } from "../../api/hooks";
import type { Entity, Priority, Project } from "../../api/types";
import { useDrawer } from "../../hooks/useDrawer";
import { useUndoableDelete } from "../../hooks/useUndoableDelete";
import { displayTitle, isUntitled } from "../../lib/entityTitle";
import { TagChip } from "../TagChip";
import { AssigneeButton } from "./Assignee";
import { ParentChip, SubtaskProgress } from "./hierarchy";
import { PriorityIcon, PRIORITY_LABEL, RecurrenceIcon } from "./icons";
import { StatusPickerButton } from "./StatusPickerButton";
import { isRecurring, isTaskOverdue } from "./utils";

const PRIORITY_OPTIONS: Priority[] = ["urgent", "high", "medium", "low", "none"];

export function TaskRow({
  task,
  project,
  showProject = true,
  compact = false
}: {
  task: Entity;
  project?: Project;
  showProject?: boolean;
  compact?: boolean;
}) {
  const drawer = useDrawer();
  const update = useUpdateEntity();
  const deleteWithUndo = useUndoableDelete();

  const idLabel = project && task.sequenceId ? `${project.key}-${task.sequenceId}` : null;
  const overdue = isTaskOverdue(task);
  const recurring = isRecurring(task);
  const visibleDate = task.status === "done" ? (task.completedAt ?? task.updatedAt) : task.dueAt;
  const visibleDateLabel = task.status === "done" ? "Completed" : "Due";

  return (
    <div
      className={`group flex cursor-pointer items-center gap-2 border-b border-kumo-hairline px-3 transition-colors hover:bg-kumo-tint ${
        compact ? "h-7 text-xs" : "h-9 text-sm"
      }`}
      onClick={() => drawer.open(task.id)}
    >
      <StatusPickerButton task={task} />

      {idLabel && !compact && (
        <span className="font-mono text-xxs text-kumo-subtle tabular-nums shrink-0">{idLabel}</span>
      )}

      <span className="flex flex-1 min-w-0 items-center gap-2">
        <span
          className={`min-w-0 truncate ${
            task.status === "done"
              ? "text-kumo-subtle line-through"
              : task.status === "rejected"
                ? "text-kumo-subtle"
                : isUntitled(task)
                  ? "text-kumo-subtle italic"
                  : "text-kumo-default"
          }`}
        >
          {displayTitle(task)}
        </span>
        {!compact && task.subtasks && <SubtaskProgress counts={task.subtasks} />}
      </span>

      {/* Compact rows (inbox rail) give every pixel to the title. */}
      {!compact && task.parent && <ParentChip parent={task.parent} className="hidden sm:inline-flex" />}

      {!compact &&
        task.tags.slice(0, 2).map((t) => (
          <TagChip key={t} tag={t} className="hidden md:inline-flex" />
        ))}

      {showProject && project && compact && (
        <span className="font-mono text-xxs text-kumo-subtle shrink-0">{project.key}</span>
      )}

      {task.blockedBy && task.blockedBy.length > 0 && task.status !== "done" && (
        <Badge variant="warning" className="px-1.5 py-0 text-[10px] uppercase tracking-wide">
          <span title={`Blocked by ${task.blockedBy.map((b) => `${b.ref} ${b.title}`).join(", ")}`}>
            blocked
          </span>
        </Badge>
      )}

      {recurring && (
        <span className="shrink-0 text-kumo-subtle" title="Recurring task">
          <RecurrenceIcon size={12} />
        </span>
      )}

      {!compact && <AssigneeButton task={task} size={16} />}

      {visibleDate && (
        <span
          className={`text-xxs tabular-nums shrink-0 ${overdue ? "text-kumo-danger font-medium" : "text-kumo-subtle"}`}
          title={`${visibleDateLabel} ${new Date(visibleDate).toLocaleString()}`}
        >
          {format(new Date(visibleDate), "MMM d")}
        </span>
      )}

      <DropdownMenu>
        <DropdownMenu.Trigger
          render={
            <button
              className="shrink-0 p-0.5 -m-0.5 rounded hover:bg-kumo-fill"
              onClick={(e) => e.stopPropagation()}
              title={PRIORITY_LABEL[task.priority]}
            >
              <PriorityIcon priority={task.priority} />
            </button>
          }
        />
        <DropdownMenu.Content align="end" onClick={(e) => e.stopPropagation()}>
          <DropdownMenu.RadioGroup
            value={task.priority}
            onValueChange={(p) => {
              if (p === task.priority) return;
              update.mutate({ id: task.id, fields: { priority: p as Priority } });
            }}
          >
            {PRIORITY_OPTIONS.map((p) => (
              <DropdownMenu.RadioItem key={p} value={p} closeOnClick className="gap-2">
                <PriorityIcon priority={p} size={12} />
                <span>{PRIORITY_LABEL[p]}</span>
                <DropdownMenu.RadioItemIndicator />
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu>

      <button
        type="button"
        className="shrink-0 p-1 -m-1 rounded text-kumo-subtle opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:bg-kumo-danger-tint hover:text-kumo-danger"
        onClick={(e) => {
          e.stopPropagation();
          deleteWithUndo(task);
        }}
        title="Delete"
        aria-label="Delete task"
      >
        <TrashIcon size={12} />
      </button>
    </div>
  );
}
