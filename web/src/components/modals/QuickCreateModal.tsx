import { Button } from "@cloudflare/kumo/components/button";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { Input, InputArea } from "@cloudflare/kumo/components/input";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { useState } from "react";
import {
  useConfigureRecurrence,
  useProjectTasks,
  useProjects,
  useWriteEntity
} from "../../api/hooks";
import {
  CREATABLE_KINDS,
  PRIORITY_LEVELS,
  type EntityKind,
  type Priority,
  type RecurrenceAnchor,
  type RecurrencePreset
} from "../../api/types";
import { useDrawer } from "../../hooks/useDrawer";
import { displayTitle } from "../../lib/entityTitle";
import { KIND_LABEL } from "../../lib/kindLabel";
import { useModals } from "../../state/modals";
import { ModalShell } from "../ModalShell";
import { NativeSelect } from "../NativeSelect";
import { PriorityIcon, PRIORITY_LABEL } from "../tasks/icons";

export function QuickCreateModal({
  initialProjectId,
  initialKind,
  initialParentId
}: {
  initialProjectId?: string;
  initialKind?: EntityKind;
  initialParentId?: string;
}) {
  const { data: projects } = useProjects();
  const [kind, setKind] = useState<EntityKind>(initialKind ?? "task");
  const [projectId, setProjectId] = useState(initialProjectId ?? "");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tagsStr, setTagsStr] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [priority, setPriority] = useState<Priority>("none");
  const [repeat, setRepeat] = useState<RecurrencePreset | "none">("none");
  const [repeatInterval, setRepeatInterval] = useState(1);
  const [repeatAnchor, setRepeatAnchor] = useState<RecurrenceAnchor>("scheduled");
  const [pinned, setPinned] = useState(false);
  const [parentId, setParentId] = useState<string>(initialParentId ?? "");
  const write = useWriteEntity();
  const configureRecurrence = useConfigureRecurrence();
  const { close } = useModals();
  const { open: openDrawer } = useDrawer();

  const project = projects?.find((p) => p.id === projectId);
  const isNote = kind === "note";
  // A new task only gets a parent picker when it was opened as a sub-task, so the
  // plain create flow stays short.
  const showParentPicker = isNote || Boolean(initialParentId);
  const { data: projectTasks } = useProjectTasks(
    showParentPicker && projectId ? projectId : undefined,
    { poll: false }
  );

  const valid =
    projectId.length > 0 &&
    (isNote
      ? title.trim().length > 0 || body.trim().length > 0
      : title.trim().length > 0 && (repeat === "none" || dueDate.length > 0));

  return (
    <ModalShell title="Quick create" width="sm:w-xl">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!valid) return;
          const trimmedTitle = title.trim();
          const tags = tagsStr.split(",").map((t) => t.trim()).filter(Boolean);
          const entity =
            kind === "task"
              ? await write.mutateAsync({
                  kind: "task",
                  projectId,
                  title: trimmedTitle,
                  body: body.trim(),
                  tags,
                  actorKind: "human",
                  dueAt: dueDate ? new Date(dueDate).toISOString() : null,
                  priority,
                  parentId: parentId || null
                })
              : await write.mutateAsync({
                  kind: "note",
                  projectId,
                  title: trimmedTitle || null,
                  body: body.trim(),
                  tags,
                  actorKind: "human",
                  pinned,
                  parentId: parentId || null
                });
          if (kind === "task" && repeat !== "none") {
            await configureRecurrence.mutateAsync({
              taskId: entity.id,
              input: {
                preset: repeat,
                interval: repeatInterval,
                anchor: repeatAnchor,
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                allDay: true
              }
            });
          }
          close();
          openDrawer(entity.id);
        }}
        className="p-4 space-y-3"
      >
        <div className="flex gap-2">
          <Tabs
            variant="segmented"
            tabs={CREATABLE_KINDS.map((k) => ({
              value: k,
              label: <span className="capitalize">{KIND_LABEL[k]}</span>
            }))}
            value={kind}
            onValueChange={(v) => setKind(v as EntityKind)}
            className="shrink-0"
          />
          <NativeSelect
            aria-label="Project"
            className="flex-1"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">— pick a project —</option>
            {projects?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.key} · {p.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Input
          autoFocus
          aria-label="Title"
          className="w-full"
          placeholder={isNote ? "Title (optional)" : "Title"}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <InputArea
          aria-label="Body"
          className="h-32 w-full resize-y py-1.5 font-mono text-xs leading-snug"
          placeholder="Body (Markdown, optional)"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          <Input
            aria-label="Tags"
            className="min-w-48 flex-1"
            placeholder="Tags (comma-separated, optional)"
            value={tagsStr}
            onChange={(e) => setTagsStr(e.target.value)}
          />
          {kind === "task" && (
            <>
              <Input
                type="date"
                aria-label="Due date"
                className="flex-1 sm:w-36 sm:flex-none"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                title="Due date"
              />
              <NativeSelect
                aria-label="Priority"
                className="flex-1 sm:w-36 sm:flex-none"
                value={priority}
                onChange={(e) => setPriority(e.target.value as Priority)}
                title="Priority"
              >
                {PRIORITY_LEVELS.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABEL[p]}
                  </option>
                ))}
              </NativeSelect>
            </>
          )}
        </div>
        {kind === "task" && (
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_84px_132px] gap-2">
            <NativeSelect
              aria-label="Repeat"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value as RecurrencePreset | "none")}
              title="Repeat"
            >
              <option value="none">Repeat: none</option>
              <option value="hourly">Hourly</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
            </NativeSelect>
            <Input
              type="number"
              min={1}
              max={999}
              aria-label="Repeat interval"
              className="w-full"
              value={repeatInterval}
              disabled={repeat === "none"}
              onChange={(e) => setRepeatInterval(Math.max(1, Number(e.target.value) || 1))}
              title="Repeat interval"
            />
            <NativeSelect
              aria-label="Repeat anchor"
              value={repeatAnchor}
              disabled={repeat === "none"}
              onChange={(e) => setRepeatAnchor(e.target.value as RecurrenceAnchor)}
              title="Repeat anchor"
            >
              <option value="scheduled">Scheduled</option>
              <option value="completion">Completion</option>
            </NativeSelect>
          </div>
        )}
        {kind === "task" && priority !== "none" && (
          <div className="flex items-center gap-1.5 text-xxs text-kumo-subtle">
            <PriorityIcon priority={priority} size={11} />
            <span>{PRIORITY_LABEL[priority]} priority</span>
          </div>
        )}
        {isNote && (
          <Checkbox
            label="📌 Pin to project — auto-include in agent opening brief"
            checked={pinned}
            onCheckedChange={setPinned}
          />
        )}
        {showParentPicker && projectTasks && projectTasks.length > 0 && (
          <div className="flex items-center gap-2 text-sm text-kumo-subtle">
            <span className="shrink-0">{isNote ? "Link to task:" : "Sub-task of:"}</span>
            <NativeSelect
              size="sm"
              aria-label={isNote ? "Link to task" : "Parent task"}
              className="flex-1"
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
            >
              <option value="">— none —</option>
              {projectTasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {project?.key && t.sequenceId ? `${project.key}-${t.sequenceId} · ` : ""}
                  {displayTitle(t)}
                </option>
              ))}
            </NativeSelect>
          </div>
        )}
        <div className="flex justify-end sm:justify-between items-center pt-1">
          <div className="hidden sm:block text-xxs text-kumo-subtle">
            <kbd>⌘</kbd>+<kbd>Enter</kbd> to submit · <kbd>Esc</kbd> to close
          </div>
          <div className="flex gap-2">
            <Button type="button" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!valid || write.isPending}>
              {write.isPending ? "Creating…" : `Create ${KIND_LABEL[kind]}`}
            </Button>
          </div>
        </div>
        {write.error && (
          <div className="text-xs text-kumo-danger">{(write.error as Error).message}</div>
        )}
      </form>
    </ModalShell>
  );
}
