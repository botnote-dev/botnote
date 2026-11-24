import { Button } from "@cloudflare/kumo/components/button";
import { Input, InputArea } from "@cloudflare/kumo/components/input";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCreateProject } from "../../api/hooks";
import { PROJECT_STATUSES, type ProjectStatus, type ProjectVisibility } from "../../api/types";
import { DEFAULT_PROJECT_COLOR, DEFAULT_PROJECT_ICON } from "../../lib/projectTheme";
import { PROJECT_STATUS_HELP, PROJECT_STATUS_LABEL } from "../../lib/projectStatus";
import { useModals } from "../../state/modals";
import { IconColorPicker } from "../IconColorPicker";
import { ModalShell } from "../ModalShell";
import { NativeSelect } from "../NativeSelect";

export function NewProjectModal() {
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [status, setStatus] = useState<ProjectStatus>("active");
  const [visibility, setVisibility] = useState<ProjectVisibility>("private");
  const [agentsMd, setAgentsMd] = useState("");
  const [color, setColor] = useState(DEFAULT_PROJECT_COLOR);
  const [icon, setIcon] = useState(DEFAULT_PROJECT_ICON);
  const create = useCreateProject();
  const { close } = useModals();
  const navigate = useNavigate();

  const valid = /^[A-Z][A-Z0-9_]{0,19}$/.test(key) && name.trim().length > 0;

  return (
    <ModalShell title="New project" width="sm:w-md">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!valid) return;
          const p = await create.mutateAsync({
            key: key.trim(),
            name: name.trim(),
            status,
            color,
            icon,
            visibility,
            agentsMd: agentsMd.trim()
          });
          close();
          navigate(`/p/${p.key}`);
        }}
        className="p-4 space-y-4"
      >
        <Input
          autoFocus
          label="Key (uppercase, e.g. BOT)"
          className="w-full font-mono uppercase"
          value={key}
          onChange={(e) => setKey(e.target.value.toUpperCase())}
          placeholder="BOT"
          maxLength={20}
        />
        <Input
          label="Name"
          className="w-full"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="botnote"
        />
        <IconColorPicker
          icon={icon}
          color={color}
          onIconChange={setIcon}
          onColorChange={setColor}
        />
        <NativeSelect
          label="Status"
          className="w-full"
          value={status}
          onChange={(e) => setStatus(e.target.value as ProjectStatus)}
        >
          {PROJECT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {PROJECT_STATUS_LABEL[s]} · {PROJECT_STATUS_HELP[s]}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          label="Who can see it"
          className="w-full"
          value={visibility}
          onChange={(e) => setVisibility(e.target.value as ProjectVisibility)}
        >
          <option value="private">Private · only you and your agents</option>
          <option value="shared">Shared · everyone on this botnote</option>
        </NativeSelect>
        <InputArea
          label="AGENTS.md (optional)"
          className="h-24 w-full resize-y py-1.5 font-mono text-xs leading-snug"
          value={agentsMd}
          onChange={(e) => setAgentsMd(e.target.value)}
          placeholder="## Critical&#10;- ALWAYS run pnpm typecheck before commit."
        />
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!valid || create.isPending}>
            {create.isPending ? "Creating…" : "Create project"}
          </Button>
        </div>
        {create.error && (
          <div className="text-xs text-kumo-danger">{(create.error as Error).message}</div>
        )}
      </form>
    </ModalShell>
  );
}
