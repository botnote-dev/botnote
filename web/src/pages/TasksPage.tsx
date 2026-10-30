import { useState } from "react";
import { DayView } from "../components/tasks/DayView";
import { InboxRail } from "../components/tasks/InboxRail";
import { MonthView } from "../components/tasks/MonthView";
import { TasksHeader } from "../components/tasks/TasksHeader";
import { WeekView } from "../components/tasks/WeekView";
import type { TaskSort } from "../components/tasks/sorting";
import type { CalendarView } from "../components/tasks/utils";
import { useIsMobile } from "../hooks/useIsMobile";
import { usePersistedState } from "../hooks/usePersistedState";

// Month cells need the width more than the Inbox does, so its rail starts
// collapsed there; each view then remembers the last choice.
const RAIL_COLLAPSED_DEFAULT: Record<CalendarView, boolean> = {
  day: false,
  week: false,
  month: true
};

export function TasksPage() {
  const isMobile = useIsMobile();
  const [view, setView] = useState<CalendarView>("week");
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [projectIds, setProjectIds] = useState<string[] | null>(null);
  const [railCollapsed, setRailCollapsed] = usePersistedState<Partial<Record<CalendarView, boolean>>>(
    "botnote.tasks.inboxCollapsed",
    {}
  );
  const [sort, setSort] = usePersistedState<TaskSort>("botnote.tasks.sort", "status");
  const [mobileRailCollapsed, setMobileRailCollapsed] = useState(true);

  // Multi-column calendars don't fit narrow screens; force the day view there.
  const effectiveView: CalendarView = isMobile ? "day" : view;
  const inboxCollapsed = isMobile
    ? mobileRailCollapsed
    : (railCollapsed[effectiveView] ?? RAIL_COLLAPSED_DEFAULT[effectiveView]);
  const toggleInbox = () => {
    if (isMobile) setMobileRailCollapsed(!mobileRailCollapsed);
    else setRailCollapsed({ ...railCollapsed, [effectiveView]: !inboxCollapsed });
  };
  const openDay = (day: Date) => {
    setAnchor(day);
    setView("day");
  };

  return (
    <div className="h-full flex flex-col">
      <TasksHeader
        view={effectiveView}
        setView={setView}
        anchor={anchor}
        setAnchor={setAnchor}
        projectIds={projectIds}
        setProjectIds={setProjectIds}
        sort={sort}
        setSort={setSort}
      />
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 overflow-hidden bg-kumo-canvas">
          {effectiveView === "day" && <DayView anchor={anchor} projectIds={projectIds} sort={sort} />}
          {effectiveView === "week" && <WeekView anchor={anchor} projectIds={projectIds} sort={sort} onOpenDay={openDay} />}
          {effectiveView === "month" && <MonthView anchor={anchor} projectIds={projectIds} sort={sort} onOpenDay={openDay} />}
        </div>
        <InboxRail
          projectIds={projectIds}
          sort={sort}
          collapsed={inboxCollapsed}
          onToggle={toggleInbox}
        />
      </div>
    </div>
  );
}
