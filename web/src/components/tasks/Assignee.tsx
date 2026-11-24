import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { cn } from "@cloudflare/kumo/utils";
import { UserCircleDashedIcon } from "@phosphor-icons/react";
import { useMe, useMembers, useUpdateEntity } from "../../api/hooks";
import type { Entity } from "../../api/types";
import { useToasts } from "../../state/toasts";

// Fixed palette, picked by a hash of the person's id so a face keeps its
// color everywhere.
const AVATAR_COLORS = [
  "#5e6ad2",
  "#0d9488",
  "#d97706",
  "#db2777",
  "#7c3aed",
  "#2563eb",
  "#059669",
  "#dc2626"
];

function colorFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const chars = parts.length === 1 ? [...parts[0]!].slice(0, 2) : [[...parts[0]!][0], [...parts[parts.length - 1]!][0]];
  return chars.join("").toUpperCase();
}

export function MemberAvatar({
  id,
  name,
  size = 18,
  className
}: {
  id: string;
  name: string;
  size?: number;
  className?: string;
}) {
  return (
    <span
      role="img"
      aria-label={name}
      title={name}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white select-none",
        className
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(8, Math.round(size * 0.44)),
        backgroundColor: colorFor(id)
      }}
    >
      {initialsOf(name)}
    </span>
  );
}

const NOBODY = "none";

/**
 * Whose task it is, as an avatar that opens a picker. Renders nothing on an
 * instance with a single person, where every task is theirs.
 */
export function AssigneeButton({
  task,
  size = 18,
  showName = false,
  className
}: {
  task: Entity;
  size?: number;
  showName?: boolean;
  className?: string;
}) {
  const { data: members } = useMembers();
  const { data: me } = useMe();
  const update = useUpdateEntity();
  const { show } = useToasts();

  if (task.kind !== "task" || !me || !members || members.length < 2) return null;

  const assignee = task.assignee ?? null;
  const label = assignee ? (assignee.id === me.id ? `${assignee.name} (you)` : assignee.name) : "Unassigned";

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <button
            type="button"
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-full hover:ring-2 hover:ring-kumo-line focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:outline-none",
              showName && "rounded-md px-1 py-0.5 hover:bg-kumo-fill hover:ring-0",
              className
            )}
            onClick={(e) => e.stopPropagation()}
            title={`Assignee: ${label}`}
            aria-label={`Assignee: ${label}`}
          >
            {assignee ? (
              <MemberAvatar id={assignee.id} name={assignee.name} size={size} />
            ) : (
              <UserCircleDashedIcon size={size} className="text-kumo-placeholder" />
            )}
            {showName && <span className="text-kumo-default">{label}</span>}
          </button>
        }
      />
      <DropdownMenu.Content align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenu.RadioGroup
          value={assignee?.id ?? NOBODY}
          onValueChange={(value) => {
            if (value === (assignee?.id ?? NOBODY)) return;
            update.mutate(
              { id: task.id, fields: { assignee: value } },
              {
                onError: (err) =>
                  show({
                    message: "Could not assign the task",
                    description: err instanceof Error ? err.message : String(err)
                  })
              }
            );
          }}
        >
          {members.map((m) => (
            <DropdownMenu.RadioItem key={m.id} value={m.id} closeOnClick className="gap-2">
              <MemberAvatar id={m.id} name={m.name} size={16} />
              <span>{m.id === me.id ? `${m.name} (you)` : m.name}</span>
              <DropdownMenu.RadioItemIndicator />
            </DropdownMenu.RadioItem>
          ))}
          <DropdownMenu.RadioItem value={NOBODY} closeOnClick className="gap-2">
            <UserCircleDashedIcon size={16} className="text-kumo-placeholder" />
            <span>Unassigned</span>
            <DropdownMenu.RadioItemIndicator />
          </DropdownMenu.RadioItem>
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}
