import { Badge } from "@cloudflare/kumo/components/badge";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { BrainIcon, KanbanIcon, RobotIcon, SlidersHorizontalIcon } from "@phosphor-icons/react";
import { useMemo } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useProjectByKey, useProjectTasks } from "../api/hooks";
import { KanbanBoard } from "../components/project/KanbanBoard";
import { NotesList } from "../components/project/NotesList";
import { ProjectIcon } from "../components/ProjectIcon";
import { PROJECT_STATUS_LABEL } from "../lib/projectStatus";
import { useModals } from "../state/modals";

type Tab = "tasks" | "notes" | "agents-md";

export function ProjectPage() {
  const { key } = useParams<{ key: string }>();
  const [search, setSearch] = useSearchParams();
  const tab = (search.get("tab") as Tab) || "tasks";

  const { data: project } = useProjectByKey(key);
  const { data: tasks } = useProjectTasks(project?.id);
  const { open: openModal } = useModals();

  const counts = useMemo(() => {
    const t = tasks ?? [];
    return {
      todo: t.filter((x) => x.status === "open").length,
      in_progress: t.filter((x) => x.status === "in_progress").length,
      done: t.filter((x) => x.status === "done").length,
      tasks: t.length
    };
  }, [tasks]);

  if (!project) {
    return <div className="p-6 text-sm text-kumo-subtle">Loading project…</div>;
  }

  const setTab = (t: Tab) => {
    if (t === "tasks") {
      search.delete("tab");
    } else {
      search.set("tab", t);
    }
    setSearch(search, { replace: true });
  };

  return (
    <div className="h-full flex flex-col">
      <div className="h-11 px-4 border-b border-kumo-line bg-kumo-base flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <ProjectIcon color={project.color} icon={project.icon} size={14} />
          <span className="font-mono text-xs tabular-nums" style={{ color: project.color }}>
            {project.key}
          </span>
          <span className="text-sm font-semibold text-kumo-default truncate">{project.name}</span>
          <Badge variant="secondary" className="hidden sm:inline-flex">
            {PROJECT_STATUS_LABEL[project.status]}
          </Badge>
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            icon={<SlidersHorizontalIcon size={14} />}
            title="Project settings"
            className="text-kumo-subtle"
            onClick={() => openModal({ kind: "edit-project", projectId: project.id })}
          />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Tabs
            variant="segmented"
            size="sm"
            value={tab === "notes" ? "notes" : "tasks"}
            onValueChange={(v) => setTab(v as Tab)}
            tabs={[
              {
                value: "tasks",
                label: (
                  <span className="inline-flex items-center gap-1">
                    <KanbanIcon size={12} />
                    Tasks
                    <span className="tabular-nums text-kumo-subtle">{counts.tasks}</span>
                  </span>
                )
              },
              {
                value: "notes",
                label: (
                  <span className="inline-flex items-center gap-1">
                    <BrainIcon size={12} />
                    Memory
                  </span>
                )
              }
            ]}
          />
          <LinkButton
            href={`/p/${project.key}/agents-md`}
            variant="ghost"
            size="sm"
            icon={<RobotIcon size={14} />}
            aria-label="AGENTS.md"
            className="text-kumo-subtle"
          >
            <span className="hidden sm:inline">AGENTS.md</span>
          </LinkButton>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === "tasks" && <KanbanBoard tasks={tasks ?? []} project={project} />}
        {tab === "notes" && <NotesList project={project} />}
      </div>
    </div>
  );
}
