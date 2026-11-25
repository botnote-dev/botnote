import { Select } from "@cloudflare/kumo/components/select";
import { useMe, useMembers } from "../../api/hooks";
import { setAssigneeChoice, useAssigneeFilter } from "../../state/assigneeFilter";

/**
 * Picks whose tasks are shown. The choice applies to every task view at once.
 * Renders nothing on an instance with a single person.
 */
export function AssigneeFilter({ className }: { className?: string }) {
  const { available, choice } = useAssigneeFilter();
  const { data: me } = useMe();
  const { data: members } = useMembers();
  if (!available) return null;

  const others = (members ?? []).filter((m) => m.id !== me?.id);
  const label = (value: string) => {
    if (value === "mine") return "My tasks";
    if (value === "everyone") return "Everyone";
    if (value === "unassigned") return "Unassigned";
    return others.find((m) => m.id === value)?.name ?? "My tasks";
  };

  return (
    <Select<string>
      size="sm"
      aria-label="Show tasks assigned to"
      value={choice}
      onValueChange={(v) => {
        if (v !== null) setAssigneeChoice(v);
      }}
      renderValue={label}
      className={className}
    >
      <Select.Option value="mine" className="py-1 text-sm">
        My tasks
      </Select.Option>
      <Select.Option value="everyone" className="py-1 text-sm">
        Everyone
      </Select.Option>
      {others.map((m) => (
        <Select.Option key={m.id} value={m.id} className="py-1 text-sm">
          {m.name}
        </Select.Option>
      ))}
      <Select.Option value="unassigned" className="py-1 text-sm">
        Unassigned
      </Select.Option>
    </Select>
  );
}
