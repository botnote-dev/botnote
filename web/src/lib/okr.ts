import { api } from "../api/client";
import type { OkrStatus } from "../api/types";

export const TIER_SUGGESTIONS = ["P0", "P1", "P2", "P3", "Side 1", "Side 2", "Side 3"];

export const STATUS_LABEL: Record<OkrStatus, string> = {
  open: "open",
  in_progress: "in progress",
  done: "done",
  rejected: "dropped"
};

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10" → "Oct 2026". */
export function formatMonth(month: string): string {
  const [year, m] = month.split("-");
  const name = MONTH_NAMES[Number(m) - 1];
  return name ? `${name} ${year}` : month;
}

/** Move a "2026Q4" quarter by `delta` quarters. */
export function shiftQuarter(quarter: string, delta: number): string {
  const year = Number(quarter.slice(0, 4));
  const q = Number(quarter.slice(5));
  const index = year * 4 + (q - 1) + delta;
  return `${Math.floor(index / 4)}Q${(index % 4) + 1}`;
}

/** Background/text classes for a 0–1 score; ~0.7 is on target. */
export function scoreTone(score: number | null): string {
  if (score === null) return "bg-kumo-tint text-kumo-placeholder";
  if (score >= 0.7) return "bg-kumo-success-tint text-kumo-success";
  if (score >= 0.4) return "bg-kumo-warning-tint text-kumo-warning";
  return "bg-kumo-danger-tint text-kumo-danger";
}

const KEY_SEQ = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/;

export function splitRefs(input: string): string[] {
  return input
    .split(/[\s,]+/)
    .map((r) => r.trim())
    .filter(Boolean);
}

/** Resolve "BOT-55, 3f2a91c0" into entity ids. KEY-SEQ refs are looked up;
 *  UUIDs and prefixes pass through for the server to resolve. */
export async function parseRefs(
  input: string,
  lookup: (projectKey: string, seq: number) => Promise<{ id: string }> = api.getEntityByKey
): Promise<string[]> {
  const ids: string[] = [];
  for (const ref of splitRefs(input)) {
    const m = KEY_SEQ.exec(ref);
    const id = m ? (await lookup(m[1]!.toUpperCase(), Number(m[2]))).id : ref;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}
