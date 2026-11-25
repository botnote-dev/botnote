import type { ActorInfo } from "../api/types";

/**
 * Who wrote something, as inline text: the person's name, with "(agent)" when
 * their agent wrote it. Falls back to the bare kind before accounts exist.
 */
export function actorText(item: { actorKind: string; actor?: ActorInfo }): string {
  const { actor } = item;
  if (!actor) return item.actorKind;
  return actor.user && item.actorKind === "agent" ? `${actor.user} (agent)` : actor.label;
}
