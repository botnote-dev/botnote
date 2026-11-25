import { useMemo, useSyncExternalStore } from "react";
import { useMe, useMembers } from "../api/hooks";

/**
 * Whose tasks the task views show: one choice shared by Today, Tasks, Inbox
 * and every project board, remembered per browser. "mine" is the default, so
 * a shared instance opens on your own work.
 */
export type AssigneeChoice = "mine" | "everyone" | "unassigned" | (string & {});

const KEY = "botnote.tasks.assignee";
const listeners = new Set<() => void>();

function read(): AssigneeChoice {
  try {
    return window.localStorage.getItem(KEY) || "mine";
  } catch {
    return "mine";
  }
}

let current: AssigneeChoice = typeof window === "undefined" ? "mine" : read();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setAssigneeChoice(next: AssigneeChoice) {
  current = next;
  try {
    window.localStorage.setItem(KEY, next);
  } catch {
    // private mode: the choice lasts for this tab only
  }
  for (const listener of listeners) listener();
}

export interface AssigneeFilterState {
  /** False on an instance with one person, where there is nothing to filter. */
  available: boolean;
  choice: AssigneeChoice;
  /** `assignee` for POST /v1/tasks/range; undefined shows everyone's. */
  param: string | undefined;
  matches: (task: { assigneeUserId?: string | null }) => boolean;
}

export function useAssigneeFilter(): AssigneeFilterState {
  const stored = useSyncExternalStore(subscribe, () => current, () => "mine" as AssigneeChoice);
  const { data: me } = useMe();
  const { data: members } = useMembers();

  return useMemo(() => {
    const available = Boolean(me) && (members?.length ?? 0) > 1;
    const known =
      stored === "mine" ||
      stored === "everyone" ||
      stored === "unassigned" ||
      Boolean(members?.some((m) => m.id === stored));
    const choice: AssigneeChoice = known ? stored : "mine";
    if (!available || choice === "everyone") {
      return { available, choice, param: undefined, matches: () => true };
    }
    if (choice === "unassigned") {
      return { available, choice, param: "none", matches: (t) => !t.assigneeUserId };
    }
    const userId = choice === "mine" ? me!.id : choice;
    return { available, choice, param: userId, matches: (t) => t.assigneeUserId === userId };
  }, [stored, me, members]);
}
