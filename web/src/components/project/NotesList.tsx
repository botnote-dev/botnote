import { Button } from "@cloudflare/kumo/components/button";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { PlusIcon, PushPinIcon, PushPinSlashIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { formatDistanceToNow } from "date-fns";
import { useEntityList, useUpdateEntity } from "../../api/hooks";
import type { Project } from "../../api/types";
import { displayTitle, isUntitled } from "../../lib/entityTitle";
import { actorText } from "../../lib/actor";
import { TagChip } from "../TagChip";
import { useModals } from "../../state/modals";

export function NotesList({ project }: { project: Project }) {
  const [search, setSearch] = useSearchParams();
  const update = useUpdateEntity();
  const { open } = useModals();
  const { data: notes } = useEntityList(project.id, ["note"]);
  const [filter, setFilter] = useState<"all" | "pinned">("all");

  function openDetail(id: string) {
    search.set("d", id);
    setSearch(search, { replace: true });
  }

  const filtered = (notes ?? []).filter((n) => (filter === "pinned" ? n.pinned : true));

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 h-11 flex items-center justify-between gap-2 border-b border-kumo-line bg-kumo-base">
        <Tabs
          variant="segmented"
          size="sm"
          value={filter}
          onValueChange={(v) => setFilter(v as "all" | "pinned")}
          tabs={[
            {
              value: "all",
              label: (
                <span>
                  All <span className="ml-1 text-kumo-placeholder">{notes?.length ?? 0}</span>
                </span>
              )
            },
            {
              value: "pinned",
              label: (
                <span>
                  Pinned{" "}
                  <span className="ml-1 text-kumo-placeholder">
                    {notes?.filter((n) => n.pinned).length ?? 0}
                  </span>
                </span>
              )
            }
          ]}
        />
        <Button
          variant="primary"
          size="sm"
          icon={<PlusIcon size={14} weight="bold" />}
          onClick={() => open({ kind: "quick-create", projectId: project.id, initialKind: "note" })}
        >
          Memory
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin bg-kumo-base">
        {filtered.length === 0 ? (
          <div className="p-8 text-center text-xs text-kumo-subtle">
            {filter === "pinned" ? "Nothing pinned yet." : "No memory yet."}
            <div className="text-kumo-placeholder mt-1">
              {filter === "pinned"
                ? "Pin a memory to put it in every agent's opening brief."
                : "Use New at the top to add one."}
            </div>
          </div>
        ) : (
          filtered.map((n) => (
            <div
              key={n.id}
              className="px-4 py-2.5 border-b border-kumo-hairline hover:bg-kumo-tint transition-colors cursor-pointer group"
              onClick={() => openDetail(n.id)}
            >
              <div className="flex items-start gap-2">
                <button
                  type="button"
                  aria-label={n.pinned ? "Unpin" : "Pin to opening brief"}
                  className={`shrink-0 mt-0.5 p-0.5 -m-0.5 rounded hover:bg-kumo-fill ${
                    n.pinned ? "text-kumo-brand" : "text-kumo-placeholder hover:text-kumo-default"
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    update.mutate({ id: n.id, fields: { pinned: !n.pinned } });
                  }}
                  title={n.pinned ? "Unpin" : "Pin to opening brief"}
                >
                  {n.pinned ? (
                    <PushPinIcon size={12} weight="fill" />
                  ) : (
                    <PushPinSlashIcon size={12} className="opacity-0 group-hover:opacity-100 transition-opacity" />
                  )}
                </button>
                <div className="flex-1 min-w-0">
                  <div
                    className={`text-sm truncate ${
                      isUntitled(n) ? "text-kumo-subtle italic" : "text-kumo-default"
                    }`}
                  >
                    {displayTitle(n)}
                  </div>
                  {!isUntitled(n) && n.body && (
                    <div className="text-xs text-kumo-subtle truncate mt-0.5">
                      {n.body.replace(/\n/g, " ").slice(0, 200)}
                    </div>
                  )}
                  <div className="text-xxs text-kumo-placeholder mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="whitespace-nowrap">{formatDistanceToNow(new Date(n.updatedAt), { addSuffix: true })}</span>
                    <span>·</span>
                    <span>{actorText(n)}</span>
                    {n.tags.length > 0 && (
                      <>
                        <span>·</span>
                        {n.tags.slice(0, 3).map((t) => (
                          <TagChip key={t} tag={t} className="py-0 text-[10px]" />
                        ))}
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
