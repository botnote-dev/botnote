import type { EntityKind } from "../api/types";

/** UI names for entity kinds. The API and MCP keep `note`. */
export const KIND_LABEL: Record<EntityKind, string> = {
  task: "task",
  note: "memory",
  worklog: "worklog",
  feedback: "feedback"
};
