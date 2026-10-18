import { Badge } from "@cloudflare/kumo/components/badge";
import { cn } from "@cloudflare/kumo/utils";
import {
  BrainIcon,
  CheckSquareIcon,
  ClockCounterClockwiseIcon,
  MegaphoneIcon,
  type Icon
} from "@phosphor-icons/react";
import type { ComponentProps } from "react";
import type { EntityKind } from "../api/types";
import { KIND_LABEL } from "../lib/kindLabel";

const KIND_STYLE: Record<
  EntityKind,
  { icon: Icon; variant: ComponentProps<typeof Badge>["variant"] }
> = {
  task: { icon: CheckSquareIcon, variant: "info" },
  note: { icon: BrainIcon, variant: "secondary" },
  worklog: { icon: ClockCounterClockwiseIcon, variant: "warning" },
  feedback: { icon: MegaphoneIcon, variant: "outline" }
};

export function KindBadge({ kind, compact = false }: { kind: EntityKind; compact?: boolean }) {
  const { icon: KindIcon, variant } = KIND_STYLE[kind];
  const label = KIND_LABEL[kind];
  return (
    <Badge
      variant={variant}
      icon={
        <span title={label} className="flex">
          <KindIcon size={12} weight="bold" />
        </span>
      }
      className={cn("h-5 py-0 text-[11px]", compact ? "px-1.5" : "uppercase tracking-wider")}
    >
      {compact ? <span className="sr-only">{label}</span> : label}
    </Badge>
  );
}
