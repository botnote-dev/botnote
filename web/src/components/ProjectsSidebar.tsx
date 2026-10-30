import { Button } from "@cloudflare/kumo/components/button";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { Sidebar, useSidebar } from "@cloudflare/kumo/components/sidebar";
import { cn } from "@cloudflare/kumo/utils";
import {
  CalendarBlankIcon,
  GearSixIcon,
  PlusIcon,
  SortAscendingIcon,
  SquaresFourIcon,
  SunHorizonIcon,
  TrashIcon,
  TrayIcon,
  type Icon
} from "@phosphor-icons/react";
import { useEffect, useMemo, type ReactNode } from "react";
import { useLocation, useParams } from "react-router-dom";
import { useProjects, useTrash } from "../api/hooks";
import type { Project, ProjectStatus } from "../api/types";
import { usePersistedState } from "../hooks/usePersistedState";
import { PROJECT_STATUS_GROUPS, PROJECT_STATUS_LABEL } from "../lib/projectStatus";
import { useModals } from "../state/modals";
import { BrandLink } from "./BrandLink";
import { ProjectIcon } from "./ProjectIcon";

type ProjectSort = "key" | "name" | "recent";
const SORT_LABEL: Record<ProjectSort, string> = {
  key: "Key (A→Z)",
  name: "Name (A→Z)",
  recent: "Recently active"
};
const DEFAULT_COLLAPSED_GROUPS: Partial<Record<ProjectStatus, boolean>> = {
  archived: true
};

const ACTIVE_ITEM =
  "data-[active]:bg-kumo-brand-tint data-[active]:text-kumo-link [&[data-active]_svg]:opacity-100";

function sortProjects(projects: Project[], sort: ProjectSort): Project[] {
  const copy = [...projects];
  if (sort === "key") return copy.sort((a, b) => a.key.localeCompare(b.key));
  if (sort === "name") return copy.sort((a, b) => a.name.localeCompare(b.name));
  return copy.sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt));
}

export function ProjectsSidebar() {
  const { open } = useModals();
  const { key: activeKey } = useParams<{ key: string }>();
  const location = useLocation();
  const { setOpenMobile } = useSidebar();
  const [sort, setSort] = usePersistedState<ProjectSort>("botnote.projectSort", "key");
  const [collapsedGroups, setCollapsedGroups] = usePersistedState<
    Partial<Record<ProjectStatus, boolean>>
  >("botnote.sidebar.projectGroups.collapsed", DEFAULT_COLLAPSED_GROUPS);
  const { data: projects, isLoading } = useProjects({ includeArchived: true });
  const { data: trash } = useTrash(200);
  const trashCount = trash?.length ?? 0;

  useEffect(() => {
    setOpenMobile(false);
  }, [location.pathname, location.search, setOpenMobile]);

  const groupedProjects = useMemo(() => {
    const all = projects ?? [];
    return new Map(
      PROJECT_STATUS_GROUPS.map((status) => [
        status,
        sortProjects(
          all.filter((p) => p.status === status),
          sort
        )
      ])
    );
  }, [projects, sort]);
  const projectCount = projects?.length ?? 0;
  const groupCollapsed = (status: ProjectStatus) =>
    collapsedGroups[status] ?? DEFAULT_COLLAPSED_GROUPS[status] ?? false;
  const isActive = (to: string, end = false) =>
    end
      ? location.pathname === to
      : location.pathname === to || location.pathname.startsWith(`${to}/`);

  return (
    <Sidebar>
      <Sidebar.Header className="h-12 px-6">
        <BrandLink />
      </Sidebar.Header>

      <Sidebar.Content>
        <Sidebar.Group>
          <Sidebar.Menu>
            <NavItem
              to="/today"
              icon={SunHorizonIcon}
              label="Today"
              shortcut="g t"
              active={isActive("/today")}
            />
            <NavItem
              to="/"
              icon={CalendarBlankIcon}
              label="Tasks"
              shortcut="g d"
              active={isActive("/", true)}
            />
            <NavItem
              to="/inbox"
              icon={TrayIcon}
              label="Inbox"
              shortcut="g i"
              active={isActive("/inbox")}
            />
            <NavItem
              to="/dashboard"
              icon={SquaresFourIcon}
              label="Workspace"
              shortcut="g w"
              active={isActive("/dashboard")}
            />
          </Sidebar.Menu>
        </Sidebar.Group>

        <Sidebar.Group>
          <div className="mt-4 mb-1 flex items-center justify-between pl-3">
            <span className="text-sm font-medium text-kumo-subtle">Projects</span>
            <div className="flex items-center">
              <DropdownMenu>
                <DropdownMenu.Trigger
                  render={
                    <Button
                      variant="ghost"
                      size="sm"
                      shape="square"
                      icon={<SortAscendingIcon size={14} />}
                      aria-label={`Sort projects: ${SORT_LABEL[sort]}`}
                      className="text-kumo-subtle"
                    />
                  }
                />
                <DropdownMenu.Content align="end">
                  <DropdownMenu.RadioGroup
                    value={sort}
                    onValueChange={(s) => setSort(s as ProjectSort)}
                  >
                    {(Object.keys(SORT_LABEL) as ProjectSort[]).map((s) => (
                      <DropdownMenu.RadioItem key={s} value={s} closeOnClick>
                        <span>{SORT_LABEL[s]}</span>
                        <DropdownMenu.RadioItemIndicator />
                      </DropdownMenu.RadioItem>
                    ))}
                  </DropdownMenu.RadioGroup>
                </DropdownMenu.Content>
              </DropdownMenu>
              <Button
                variant="ghost"
                size="sm"
                shape="square"
                icon={<PlusIcon size={14} />}
                title="New project (n)"
                className="text-kumo-subtle"
                onClick={() => open({ kind: "new-project" })}
              />
            </div>
          </div>

          <Sidebar.Menu>
            {isLoading && <li className="px-3 py-1 text-sm text-kumo-placeholder">Loading…</li>}
            {!isLoading && projectCount === 0 && (
              <Sidebar.MenuButton
                size="sm"
                className="pl-3 text-kumo-subtle"
                onClick={() => open({ kind: "new-project" })}
              >
                No projects yet.
                <span className="text-kumo-link">Create →</span>
              </Sidebar.MenuButton>
            )}
            {!isLoading &&
              PROJECT_STATUS_GROUPS.map((status) => {
                const group = groupedProjects.get(status) ?? [];
                if (group.length === 0) return null;
                return (
                  <Sidebar.MenuItem key={status}>
                    <Sidebar.Collapsible
                      open={!groupCollapsed(status)}
                      onOpenChange={(isOpen) =>
                        setCollapsedGroups({ ...collapsedGroups, [status]: !isOpen })
                      }
                    >
                      <Sidebar.CollapsibleTrigger
                        render={
                          <Sidebar.MenuButton size="sm" className="pl-3 text-xs font-medium text-kumo-subtle">
                            {PROJECT_STATUS_LABEL[status]}
                            <span className="ml-auto tabular-nums text-kumo-placeholder">{group.length}</span>
                            <Sidebar.MenuChevron className="ml-0" />
                          </Sidebar.MenuButton>
                        }
                      />
                      <Sidebar.CollapsibleContent>
                        <Sidebar.Menu>
                          {group.map((p) => (
                            <ProjectItem key={p.id} project={p} active={activeKey === p.key} />
                          ))}
                        </Sidebar.Menu>
                      </Sidebar.CollapsibleContent>
                    </Sidebar.Collapsible>
                  </Sidebar.MenuItem>
                );
              })}
          </Sidebar.Menu>
        </Sidebar.Group>
      </Sidebar.Content>

      <div className="shrink-0 border-t border-kumo-line px-3.5 py-2">
        <Sidebar.Menu>
          <NavItem to="/trash" icon={TrashIcon} label="Trash" active={isActive("/trash")}>
            {trashCount > 0 && (
              <span className="ml-auto text-xs tabular-nums text-kumo-subtle">{trashCount}</span>
            )}
          </NavItem>
          <NavItem to="/settings" icon={GearSixIcon} label="Settings" active={isActive("/settings")} />
        </Sidebar.Menu>
      </div>
    </Sidebar>
  );
}

function NavItem({
  to,
  icon,
  label,
  shortcut,
  active,
  children
}: {
  to: string;
  icon: Icon;
  label: string;
  shortcut?: string;
  active: boolean;
  children?: ReactNode;
}) {
  return (
    <Sidebar.MenuButton href={to} icon={icon} active={active} className={ACTIVE_ITEM}>
      {label}
      {children}
      {shortcut && (
        <kbd className="ml-auto opacity-0 transition-opacity group-hover/menu-button:opacity-100">
          {shortcut}
        </kbd>
      )}
    </Sidebar.MenuButton>
  );
}

function ProjectItem({ project, active }: { project: Project; active: boolean }) {
  const archived = project.status === "archived";
  return (
    <Sidebar.MenuItem>
      <Sidebar.MenuButton
        size="sm"
        href={`/p/${project.key}`}
        active={active}
        icon={<ProjectIcon color={project.color} icon={project.icon} size={14} />}
        title={archived ? `${project.name} (archived)` : project.name}
        className={cn(ACTIVE_ITEM, "pl-3", archived && "opacity-60")}
      >
        <span className="shrink-0 font-mono text-xs tabular-nums" style={{ color: project.color }}>
          {project.key}
        </span>
        <span className="truncate text-kumo-subtle">{project.name}</span>
      </Sidebar.MenuButton>
    </Sidebar.MenuItem>
  );
}
