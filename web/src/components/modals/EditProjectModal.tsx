import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { useEffect, useState } from "react";
import { useMe, useProject, useUpdateProject } from "../../api/hooks";
import { PROJECT_STATUSES, type ProjectStatus, type ProjectVisibility } from "../../api/types";
import { DEFAULT_PROJECT_COLOR, DEFAULT_PROJECT_ICON } from "../../lib/projectTheme";
import { PROJECT_STATUS_HELP, PROJECT_STATUS_LABEL } from "../../lib/projectStatus";
import { useModals } from "../../state/modals";
import { IconColorPicker } from "../IconColorPicker";
import { ModalShell } from "../ModalShell";
import { NativeSelect } from "../NativeSelect";

export function EditProjectModal({ projectId }: { projectId: string }) {
  const { data: project } = useProject(projectId);
  const update = useUpdateProject();
  const { close } = useModals();
  const { data: me } = useMe();

  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<ProjectVisibility>("private");
  const [status, setStatus] = useState<ProjectStatus>("active");
  const [color, setColor] = useState(DEFAULT_PROJECT_COLOR);
  const [icon, setIcon] = useState(DEFAULT_PROJECT_ICON);

  useEffect(() => {
    if (project) {
      setName(project.name);
      setStatus(project.status);
      setColor(project.color);
      setIcon(project.icon);
      setVisibility(project.visibility);
    }
  }, [
    project?.id,
    project?.name,
    project?.status,
    project?.color,
    project?.icon,
    project?.visibility
  ]);

  if (!project) {
    return (
      <ModalShell title="Project settings" width="sm:w-md">
        <div className="p-4 text-sm text-kumo-subtle">Loading…</div>
      </ModalShell>
    );
  }

  const loadedProject = project;
  const dirty =
    name !== loadedProject.name ||
    status !== loadedProject.status ||
    color !== loadedProject.color ||
    icon !== loadedProject.icon ||
    visibility !== loadedProject.visibility;
  // Without accounts there is nobody to share with, and only the owner decides.
  const canShare = Boolean(me) && loadedProject.ownerUserId === me?.id;
  const valid = name.trim().length > 0;

  return (
    <ModalShell title={`Settings · ${loadedProject.key}`} width="sm:w-md">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!dirty || !valid) return;
          await update.mutateAsync({
            id: loadedProject.id,
            fields: {
              name: name.trim(),
              status,
              color,
              icon,
              ...(visibility !== loadedProject.visibility ? { visibility } : {})
            }
          });
          close();
        }}
        className="p-4 space-y-4"
      >
        <Input
          autoFocus
          label="Name"
          className="w-full"
          value={name}
          onChange={(e) => setName(e.target.value)}
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
        {me && (
          <div className="space-y-1">
            <NativeSelect
              label="Who can see it"
              className="w-full"
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as ProjectVisibility)}
              disabled={!canShare}
            >
              <option value="private">Private · only the owner and their agents</option>
              <option value="shared">Shared · everyone on this botnote</option>
            </NativeSelect>
            {!canShare && (
              <div className="text-xxs text-kumo-subtle">
                Only the person who owns this project can change who sees it.
              </div>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!dirty || !valid || update.isPending}>
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
        {update.error && (
          <div className="text-xs text-kumo-danger">{(update.error as Error).message}</div>
        )}
      </form>
    </ModalShell>
  );
}
