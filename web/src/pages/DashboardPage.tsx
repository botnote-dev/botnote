import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import {
  CaretDownIcon,
  CaretRightIcon,
  CheckIcon,
  KanbanIcon,
  MegaphoneIcon,
  PulseIcon,
  XIcon
} from "@phosphor-icons/react";
import { useState, type ComponentProps } from "react";
import { Link } from "react-router-dom";
import { useFeedback, useProjects, useRecent, useTasksRange, useUpdateEntity } from "../api/hooks";
import type { FeedbackCategory, FeedbackStatus, Project, ProjectStatus } from "../api/types";
import { FEEDBACK_CATEGORIES } from "../api/types";
import { KindBadge } from "../components/KindBadge";
import { ProjectIcon } from "../components/ProjectIcon";
import { useDrawer } from "../hooks/useDrawer";
import { usePersistedState } from "../hooks/usePersistedState";
import { isTaskOverdue } from "../components/tasks/utils";
import { displayTitle, isUntitled } from "../lib/entityTitle";
import { actorText } from "../lib/actor";
import { PROJECT_STATUS_GROUPS, PROJECT_STATUS_LABEL } from "../lib/projectStatus";

const DEFAULT_COLLAPSED_GROUPS: Partial<Record<ProjectStatus, boolean>> = {
  archived: true
};

export function DashboardPage() {
  const { data: projects } = useProjects({ includeArchived: true });
  const { data: recent } = useRecent({ limit: 20 });
  // One workspace-wide query feeds every card's open/overdue counts.
  const { data: openTasks } = useTasksRange(
    { includeBacklog: true, includeDone: false },
    { everyone: true }
  );
  const drawer = useDrawer();

  const counts = new Map<string, { open: number; overdue: number }>();
  if (openTasks) {
    const now = new Date();
    const all = [...openTasks.scheduled, ...openTasks.overdue, ...openTasks.backlog];
    for (const t of all) {
      if (!t.projectId || t.status === "rejected") continue;
      const c = counts.get(t.projectId) ?? { open: 0, overdue: 0 };
      c.open += 1;
      if (isTaskOverdue(t, now)) c.overdue += 1;
      counts.set(t.projectId, c);
    }
  }
  const [collapsedGroups, setCollapsedGroups] = usePersistedState<
    Partial<Record<ProjectStatus, boolean>>
  >("botnote.workspace.projectGroups.collapsed", DEFAULT_COLLAPSED_GROUPS);
  const projectGroups = PROJECT_STATUS_GROUPS.map((status) => ({
    status,
    projects: (projects ?? []).filter((p) => p.status === status)
  })).filter((group) => group.projects.length > 0);
  const groupCollapsed = (status: ProjectStatus) =>
    collapsedGroups[status] ?? DEFAULT_COLLAPSED_GROUPS[status] ?? false;
  const toggleGroup = (status: ProjectStatus) => {
    const collapsed = groupCollapsed(status);
    setCollapsedGroups({ ...collapsedGroups, [status]: !collapsed });
  };

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">
        <header>
          <h1 className="text-xl font-semibold text-kumo-default">Workspace</h1>
          <p className="text-sm text-kumo-subtle mt-1">
            Projects, tasks, memory, and worklogs — written by you or by your agents.
          </p>
        </header>

        <section className="space-y-5">
          <div className="flex items-center gap-2 mb-3 text-kumo-subtle">
            <KanbanIcon size={14} />
            <h2 className="text-xs uppercase tracking-wider font-medium">
              Projects ({projects?.length ?? 0})
            </h2>
          </div>
          {projects && projects.length === 0 ? (
            <div className="border border-dashed border-kumo-line rounded-lg p-6 text-center text-sm text-kumo-subtle">
              No projects yet. Create one with the + next to Projects in the sidebar.
            </div>
          ) : (
            projectGroups.map((group) => (
              <ProjectGroup
                key={group.status}
                status={group.status}
                projects={group.projects}
                counts={counts}
                collapsed={groupCollapsed(group.status)}
                onToggle={() => toggleGroup(group.status)}
              />
            ))
          )}
        </section>

        <FeedbackSection />

        <section>
          <div className="flex items-center gap-2 mb-3 text-kumo-subtle">
            <PulseIcon size={14} />
            <h2 className="text-xs uppercase tracking-wider font-medium">Recent activity</h2>
          </div>
          {recent && recent.length === 0 ? (
            <div className="text-sm text-kumo-subtle">Nothing yet.</div>
          ) : (
            <div className="bg-kumo-base border border-kumo-line rounded-lg overflow-hidden divide-y divide-kumo-hairline">
              {recent?.map((e) => {
                const project = projects?.find((p) => p.id === e.projectId);
                return (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => drawer.open(e.id)}
                    className="w-full text-left flex items-center gap-3 px-3 py-2 hover:bg-kumo-tint transition-colors"
                  >
                    <KindBadge kind={e.kind} />
                    <div className="flex-1 min-w-0">
                      <div
                        className={`text-sm truncate ${
                          isUntitled(e) ? "text-kumo-subtle italic" : "text-kumo-default"
                        }`}
                      >
                        {displayTitle(e)}
                      </div>
                      <div className="text-xxs text-kumo-subtle mt-0.5">
                        {project ? project.key : "—"} · {timeAgo(e.createdAt)} ·{" "}
                        <span className="opacity-70">{actorText(e)}</span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

const CATEGORY_STYLE: Record<
  FeedbackCategory,
  { badge: ComponentProps<typeof Badge>["variant"]; chip: string }
> = {
  bug: { badge: "error", chip: "bg-kumo-danger-tint text-kumo-danger border-kumo-danger/30" },
  feature: { badge: "info", chip: "bg-kumo-info-tint text-kumo-info border-kumo-info/30" },
  friction: { badge: "warning", chip: "bg-kumo-warning-tint text-kumo-warning border-kumo-warning/30" },
  idea: { badge: "success", chip: "bg-kumo-success-tint text-kumo-success border-kumo-success/30" }
};

const FEEDBACK_STATUSES: { value: FeedbackStatus; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "done", label: "Done" },
  { value: "rejected", label: "Rejected" }
];

function FeedbackSection() {
  const [category, setCategory] = useState<FeedbackCategory | null>(null);
  const [status, setStatus] = useState<FeedbackStatus>("open");
  const { data: feedback } = useFeedback({ category, status, limit: 50 });
  const update = useUpdateEntity();
  const drawer = useDrawer();

  return (
    <section>
      <div className="flex items-center gap-2 mb-3 text-kumo-subtle">
        <MegaphoneIcon size={14} />
        <h2 className="text-xs uppercase tracking-wider font-medium">Product feedback</h2>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 mb-2">
        <Tabs
          variant="segmented"
          size="sm"
          tabs={FEEDBACK_STATUSES}
          value={status}
          onValueChange={(v) => setStatus(v as FeedbackStatus)}
        />
        <div className="w-px h-4 bg-kumo-line mx-1" />
        <button
          type="button"
          aria-pressed={!category}
          className={`h-6 px-2.5 text-xxs rounded-full border transition-colors ${
            !category
              ? "bg-kumo-brand-tint text-kumo-link border-kumo-brand/30"
              : "bg-kumo-base text-kumo-subtle border-kumo-line hover:text-kumo-default"
          }`}
          onClick={() => setCategory(null)}
        >
          All
        </button>
        {FEEDBACK_CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={category === c}
            className={`h-6 px-2.5 text-xxs rounded-full border capitalize transition-colors ${
              category === c ? CATEGORY_STYLE[c].chip : "bg-kumo-base text-kumo-subtle border-kumo-line hover:text-kumo-default"
            }`}
            onClick={() => setCategory(category === c ? null : c)}
          >
            {c}
          </button>
        ))}
      </div>

      {feedback && feedback.length === 0 ? (
        <div className="border border-dashed border-kumo-line rounded-md p-4 text-center text-xs text-kumo-subtle">
          No {status.replace("_", " ")} feedback{category ? ` in “${category}”` : ""}.
        </div>
      ) : (
        <div className="bg-kumo-base border border-kumo-line rounded-lg overflow-hidden divide-y divide-kumo-hairline">
          {feedback?.map((f) => {
            const cat = (f.metadata.category as FeedbackCategory | undefined) ?? "idea";
            const tool = f.metadata.tool as string | undefined;
            const resolvable = f.status === "open" || f.status === "in_progress";
            return (
              <div
                key={f.id}
                className="flex items-start gap-3 px-3 py-2 hover:bg-kumo-tint transition-colors cursor-pointer group"
                onClick={() => drawer.open(f.id)}
              >
                <Badge
                  variant={CATEGORY_STYLE[cat].badge}
                  className="mt-0.5 h-5 shrink-0 px-1.5 py-0 text-[11px] capitalize"
                >
                  {cat}
                </Badge>
                <div className="flex-1 min-w-0">
                  <div
                    className={`text-sm truncate ${isUntitled(f) ? "text-kumo-subtle italic" : "text-kumo-default"}`}
                  >
                    {displayTitle(f)}
                  </div>
                  <div className="text-xxs text-kumo-subtle mt-0.5">
                    {tool && <span className="font-mono">{tool} · </span>}
                    {actorText(f)} · {timeAgo(f.createdAt)}
                  </div>
                </div>
                {resolvable && (
                  <div
                    className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Button
                      variant="ghost"
                      size="xs"
                      icon={<CheckIcon size={11} />}
                      className="text-kumo-subtle"
                      onClick={() => update.mutate({ id: f.id, fields: { status: "done" } })}
                    >
                      Done
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      icon={<XIcon size={11} />}
                      className="text-kumo-subtle hover:text-kumo-danger"
                      onClick={() => update.mutate({ id: f.id, fields: { status: "rejected" } })}
                    >
                      Reject
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ProjectGroup({
  status,
  projects,
  counts,
  collapsed,
  onToggle
}: {
  status: ProjectStatus;
  projects: Project[];
  counts: Map<string, { open: number; overdue: number }>;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <div>
      <button
        type="button"
        className="flex items-center gap-1.5 mb-2 text-kumo-subtle hover:text-kumo-default"
        onClick={onToggle}
        aria-expanded={!collapsed}
        title={`${collapsed ? "Expand" : "Collapse"} ${PROJECT_STATUS_LABEL[status]}`}
      >
        {collapsed ? <CaretRightIcon size={12} /> : <CaretDownIcon size={12} />}
        <span className="text-xxs uppercase tracking-wider font-medium">
          {PROJECT_STATUS_LABEL[status]} ({projects.length})
        </span>
      </button>
      {!collapsed && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p} counts={counts.get(p.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectCard({
  project,
  counts
}: {
  project: Project;
  counts?: { open: number; overdue: number };
}) {
  return (
    <Link
      to={`/p/${project.key}`}
      className={`border border-kumo-line rounded-lg p-3 bg-kumo-base hover:border-kumo-brand/50 transition-colors block ${
        project.status === "archived" ? "opacity-70" : ""
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 min-w-0">
          <ProjectIcon color={project.color} icon={project.icon} size={12} />
          <span className="font-mono text-xs shrink-0" style={{ color: project.color }}>
            {project.key}
          </span>
        </div>
        <span className="text-xxs text-kumo-placeholder shrink-0">
          Updated {new Date(project.updatedAt).toLocaleDateString()}
        </span>
      </div>
      <div className="text-sm font-medium text-kumo-default mt-1 truncate">{project.name}</div>
      <div className="text-xxs text-kumo-subtle mt-1 flex items-center gap-2">
        <span>{counts?.open ?? 0} open</span>
        {counts && counts.overdue > 0 && (
          <span className="text-kumo-danger font-medium">{counts.overdue} overdue</span>
        )}
        {project.agentsMd && <span className="text-kumo-placeholder">· AGENTS.md</span>}
      </div>
    </Link>
  );
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  if (diff < 7 * 86400_000) return `${Math.floor(diff / 86400_000)}d ago`;
  return new Date(iso).toLocaleDateString();
}
