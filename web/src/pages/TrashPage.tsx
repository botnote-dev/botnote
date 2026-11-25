import { Button } from "@cloudflare/kumo/components/button";
import { ArrowCounterClockwiseIcon, TrashIcon, XIcon } from "@phosphor-icons/react";
import { useProjects, usePurgeEntity, useRestoreEntity, useTrash } from "../api/hooks";
import { KindBadge } from "../components/KindBadge";
import { displayTitle, isUntitled } from "../lib/entityTitle";
import { actorText } from "../lib/actor";

export function TrashPage() {
  const { data: trash } = useTrash(200);
  const { data: projects } = useProjects({ includeArchived: true });
  const restore = useRestoreEntity();
  const purge = usePurgeEntity();

  const emptyTrash = () => {
    if (!trash || trash.length === 0) return;
    if (
      !window.confirm(
        `Permanently delete all ${trash.length} item(s) in the trash? This cannot be undone.`
      )
    ) {
      return;
    }
    for (const e of trash) purge.mutate(e.id);
  };

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="max-w-3xl mx-auto px-6 py-8 space-y-5">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-kumo-default flex items-center gap-2">
              <TrashIcon size={18} className="text-kumo-subtle" /> Trash
            </h1>
            <p className="text-sm text-kumo-subtle mt-1">
              Deleted items land here and are purged automatically after 30 days.
            </p>
          </div>
          {trash && trash.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              icon={<XIcon size={12} />}
              className="shrink-0 text-kumo-subtle hover:text-kumo-danger"
              onClick={emptyTrash}
            >
              Empty trash
            </Button>
          )}
        </header>

        {trash && trash.length === 0 ? (
          <div className="border border-dashed border-kumo-line rounded-lg p-8 text-center text-sm text-kumo-subtle">
            Trash is empty.
          </div>
        ) : (
          <div className="bg-kumo-base border border-kumo-line rounded-lg overflow-hidden divide-y divide-kumo-hairline">
            {trash?.map((e) => {
              const project = projects?.find((p) => p.id === e.projectId);
              return (
                <div key={e.id} className="flex items-center gap-3 px-3 py-2 hover:bg-kumo-tint transition-colors group">
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
                      {project ? project.key : "—"} · deleted{" "}
                      {e.deletedAt ? timeAgo(e.deletedAt) : "—"} ·{" "}
                      <span className="opacity-70">{actorText(e)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    <Button
                      variant="ghost"
                      size="xs"
                      icon={<ArrowCounterClockwiseIcon size={11} />}
                      className="text-kumo-subtle"
                      onClick={() => restore.mutate(e.id)}
                    >
                      Restore
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      icon={<TrashIcon size={11} />}
                      className="text-kumo-subtle hover:text-kumo-danger"
                      onClick={() => {
                        if (
                          window.confirm(
                            `Permanently delete "${displayTitle(e)}"? This cannot be undone.`
                          )
                        ) {
                          purge.mutate(e.id);
                        }
                      }}
                    >
                      Delete forever
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
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
