/**
 * Response decoration for write attribution. Every serialized entity carries
 * `actorKind` and `actorTokenId`; this adds the additive `actor` field
 * (`{ kind, label }`) where label is the token's name when the row was written
 * through an API token, otherwise the bare actor kind. Runs as a
 * preSerialization hook so all 30-odd entity-returning routes get it without
 * each one resolving labels.
 */

export interface ActorInfo {
  kind: string;
  label: string;
  /** The person who wrote it, or whose agent did. Absent before accounts. */
  user?: string;
}

/** Whose task it is. `me` is true when it is the caller's. */
export interface AssigneeInfo {
  id: string;
  name: string;
  me: boolean;
}

const MAX_DEPTH = 8;

type Attributable = {
  actorKind: string;
  actorTokenId: string | null;
  authorUserId?: string | null;
  assigneeUserId?: string | null;
  actor?: ActorInfo;
  assignee?: AssigneeInfo | null;
};

function isAttributable(node: Record<string, unknown>): node is Attributable {
  return typeof node["actorKind"] === "string" && "actorTokenId" in node;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  if (value instanceof Date) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function walk(node: unknown, depth: number, visit: (n: Attributable) => void): void {
  if (depth > MAX_DEPTH) return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, depth + 1, visit);
    return;
  }
  if (!isPlainObject(node)) return;
  if (isAttributable(node)) visit(node);
  for (const value of Object.values(node)) {
    if (value !== null && typeof value === "object") walk(value, depth + 1, visit);
  }
}

export function actorLabelFor(
  entity: { actorKind: string; actorTokenId: string | null },
  labels: ReadonlyMap<string, string>
): string {
  return (entity.actorTokenId && labels.get(entity.actorTokenId)) || entity.actorKind;
}

/**
 * Mutates `payload` in place, adding `actor` to every attributable object.
 * `loadLabels` is only called when at least one object references a token,
 * so responses without entities cost nothing.
 */
export async function attachActorLabels(
  payload: unknown,
  loadLabels: () => Promise<ReadonlyMap<string, string>>,
  loadUserNames?: (ids: string[]) => Promise<ReadonlyMap<string, string>>,
  callerUserId?: string | null
): Promise<unknown> {
  if (payload === null || typeof payload !== "object") return payload;
  const targets: Attributable[] = [];
  walk(payload, 0, (n) => targets.push(n));
  if (targets.length === 0) return payload;
  const needsLabels = targets.some((t) => t.actorTokenId != null);
  const labels = needsLabels ? await loadLabels() : new Map<string, string>();
  const userIds = targets
    .flatMap((t) => [t.authorUserId, t.assigneeUserId])
    .filter((id): id is string => !!id);
  const names =
    loadUserNames && userIds.length > 0 ? await loadUserNames(userIds) : new Map<string, string>();
  for (const t of targets) {
    const user = t.authorUserId ? names.get(t.authorUserId) : undefined;
    const tokenLabel = t.actorTokenId ? labels.get(t.actorTokenId) : undefined;
    t.actor = {
      kind: t.actorKind,
      label: tokenLabel ?? (t.actorKind === "human" && user ? user : t.actorKind),
      ...(user ? { user } : {})
    };
    if ("assigneeUserId" in t) {
      const name = t.assigneeUserId ? names.get(t.assigneeUserId) : undefined;
      t.assignee =
        t.assigneeUserId && name
          ? { id: t.assigneeUserId, name, me: t.assigneeUserId === callerUserId }
          : null;
    }
  }
  return payload;
}
