import { Button } from "@cloudflare/kumo/components/button";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { CaretLeftIcon, CaretRightIcon, FunnelIcon, PlusIcon } from "@phosphor-icons/react";
import { useProjects } from "../../api/hooks";
import type { Project } from "../../api/types";
import { useModals } from "../../state/modals";
import type { TaskSort } from "./sorting";
import { moveAnchor, rangeLabel, type CalendarView } from "./utils";
import { ViewOptionsMenu } from "./ViewOptionsMenu";

const VIEW_TABS = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" }
];

export function TasksHeader({
  view,
  setView,
  anchor,
  setAnchor,
  projectIds,
  setProjectIds,
  sort,
  setSort
}: {
  view: CalendarView;
  setView: (v: CalendarView) => void;
  anchor: Date;
  setAnchor: (d: Date) => void;
  projectIds: string[] | null;
  setProjectIds: (ids: string[] | null) => void;
  sort: TaskSort;
  setSort: (s: TaskSort) => void;
}) {
  const { data: projects } = useProjects();
  const { open } = useModals();

  const projectLabel = !projectIds
    ? "All projects"
    : projectIds.length === 1
      ? projects?.find((p) => p.id === projectIds[0])?.key ?? "1 project"
      : `${projectIds.length} projects`;

  return (
    <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-kumo-line bg-kumo-base px-3">
      <div className="flex min-w-0 items-center gap-3">
        <h1 className="hidden text-sm font-semibold text-kumo-default sm:block">Tasks</h1>
        <Tabs
          variant="segmented"
          size="sm"
          tabs={VIEW_TABS}
          value={view}
          onValueChange={(v) => setView(v as CalendarView)}
          className="hidden md:block"
        />

        <div className="flex min-w-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            icon={<CaretLeftIcon size={14} />}
            aria-label="Previous"
            className="text-kumo-subtle"
            onClick={() => setAnchor(moveAnchor(view, anchor, -1))}
          />
          <Button size="sm" onClick={() => setAnchor(moveAnchor(view, anchor, 0))}>
            Today
          </Button>
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            icon={<CaretRightIcon size={14} />}
            aria-label="Next"
            className="text-kumo-subtle"
            onClick={() => setAnchor(moveAnchor(view, anchor, 1))}
          />
          <div className="ml-2 truncate text-sm font-medium tabular-nums text-kumo-default">
            {rangeLabel(view, anchor)}
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <ViewOptionsMenu sort={sort} setSort={setSort} />
        <ProjectFilter
          projects={projects ?? []}
          projectIds={projectIds}
          setProjectIds={setProjectIds}
          label={projectLabel}
        />
        <Button
          variant="primary"
          size="sm"
          icon={<PlusIcon size={14} weight="bold" />}
          aria-label="New task"
          onClick={() => open({ kind: "quick-create" })}
        >
          <span className="hidden sm:inline">Task</span>
          <kbd className="hidden border-white/25 bg-white/15 text-white md:inline-flex">c</kbd>
        </Button>
      </div>
    </div>
  );
}

function ProjectFilter({
  projects,
  projectIds,
  setProjectIds,
  label
}: {
  projects: Project[];
  projectIds: string[] | null;
  setProjectIds: (ids: string[] | null) => void;
  label: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <Button
            size="sm"
            icon={<FunnelIcon size={14} className="text-kumo-subtle" />}
            aria-label={`Filter projects: ${label}`}
          >
            <span className="hidden sm:inline">{label}</span>
          </Button>
        }
      />
      <DropdownMenu.Content align="end" className="w-56">
        <DropdownMenu.CheckboxItem checked={!projectIds} onCheckedChange={() => setProjectIds(null)}>
          All projects
        </DropdownMenu.CheckboxItem>
        <DropdownMenu.Separator />
        {projects.map((p) => {
          const isOn = projectIds?.includes(p.id) ?? false;
          return (
            <DropdownMenu.CheckboxItem
              key={p.id}
              checked={isOn}
              onCheckedChange={() => {
                if (!projectIds) {
                  setProjectIds([p.id]);
                } else if (isOn) {
                  const rest = projectIds.filter((id) => id !== p.id);
                  setProjectIds(rest.length ? rest : null);
                } else {
                  setProjectIds([...projectIds, p.id]);
                }
              }}
              className="gap-2"
            >
              <span className="font-mono text-xxs text-kumo-subtle tabular-nums">{p.key}</span>
              <span className="truncate">{p.name}</span>
            </DropdownMenu.CheckboxItem>
          );
        })}
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}
