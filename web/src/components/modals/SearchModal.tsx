import { CommandPalette } from "@cloudflare/kumo/components/command-palette";
import { Loader } from "@cloudflare/kumo/components/loader";
import {
  ArrowRightIcon,
  BrainIcon,
  ClockCounterClockwiseIcon,
  MegaphoneIcon,
  type Icon
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { useProjects, useSearch } from "../../api/hooks";
import type { EntityKind, SearchHit } from "../../api/types";
import { useDrawer } from "../../hooks/useDrawer";
import { displayTitle } from "../../lib/entityTitle";
import { useModals } from "../../state/modals";
import { StatusCircle } from "../tasks/icons";

const KIND_META: Record<EntityKind, { label: string; icon: Icon | null }> = {
  task: { label: "task", icon: null },
  note: { label: "memory", icon: BrainIcon },
  worklog: { label: "worklog", icon: ClockCounterClockwiseIcon },
  feedback: { label: "feedback", icon: MegaphoneIcon }
};

export function SearchModal() {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const { close } = useModals();
  const { open: openDrawer } = useDrawer();
  const { data: projects } = useProjects();

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);

  const { data, isFetching } = useSearch(
    debounced ? { query: debounced, limit: 20 } : null
  );
  const hits = debounced ? (data?.hits ?? []) : [];

  const projectKeyById = useMemo(() => {
    const m = new Map<string, string>();
    projects?.forEach((p) => m.set(p.id, p.key));
    return m;
  }, [projects]);

  const select = (hit: SearchHit) => {
    close();
    openDrawer(hit.entity.id);
  };

  return (
    <CommandPalette.Root
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      items={hits}
      value={q}
      onValueChange={setQ}
      itemToStringValue={(h) => displayTitle(h.entity)}
    >
      <CommandPalette.Input
        placeholder="Search tasks, memory, worklogs…"
        aria-label="Search"
        trailing={isFetching ? <Loader size={14} /> : <kbd>esc</kbd>}
      />
      <CommandPalette.List className="scrollbar-thin">
        <CommandPalette.Results className="space-y-0.5">
          {(h: SearchHit) => {
            const kind = KIND_META[h.entity.kind];
            const KindIcon = kind.icon;
            const projectKey = h.entity.projectId ? projectKeyById.get(h.entity.projectId) : null;
            const snippet = h.entity.body.replace(/\n/g, " ").slice(0, 140);
            return (
              <CommandPalette.Item
                key={h.entity.id}
                value={h}
                onClick={() => select(h)}
                className="items-start"
              >
                <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-kumo-subtle">
                  {KindIcon ? <KindIcon size={16} /> : <StatusCircle status={h.entity.status} />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-kumo-default">{displayTitle(h.entity)}</div>
                  {snippet && (
                    <div className="mt-0.5 truncate text-xs text-kumo-subtle">{snippet}</div>
                  )}
                  <div className="mt-0.5 flex gap-1.5 text-xxs text-kumo-placeholder tabular-nums">
                    <span>{kind.label}</span>
                    {projectKey && <span>· {projectKey}</span>}
                    <span>· score {h.score.toFixed(3)}</span>
                    {h.components.bm25 && <span>· bm25</span>}
                    {h.components.cosine && <span>· vec</span>}
                  </div>
                </div>
                <ArrowRightIcon
                  size={14}
                  className="mt-0.5 shrink-0 text-kumo-subtle opacity-0 transition-opacity group-data-[highlighted]:opacity-100"
                />
              </CommandPalette.Item>
            );
          }}
        </CommandPalette.Results>
        <CommandPalette.Empty>
          {!debounced
            ? "Hybrid search over BM25, vectors and recency."
            : isFetching
              ? "Searching…"
              : "No matches."}
        </CommandPalette.Empty>
      </CommandPalette.List>
      <CommandPalette.Footer>
        <span>
          {data && debounced
            ? `${data.hits.length} result(s) · embedding ${data.embeddingUsed ? "on" : "off (BM25-only)"}`
            : null}
        </span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <kbd>↑</kbd>
            <kbd>↓</kbd>
            navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd>↵</kbd>
            open
          </span>
        </span>
      </CommandPalette.Footer>
    </CommandPalette.Root>
  );
}
