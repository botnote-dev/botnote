import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Input, InputArea } from "@cloudflare/kumo/components/input";
import {
  CaretLeftIcon,
  CaretRightIcon,
  ClockCounterClockwiseIcon,
  PencilSimpleIcon,
  PlusIcon,
  TargetIcon,
  XIcon
} from "@phosphor-icons/react";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import { useSearchParams } from "react-router-dom";
import remarkGfm from "remark-gfm";
import { api } from "../api/client";
import {
  useOkr,
  useOkrCurrent,
  useOkrMutation,
  useOkrReviews,
  useProjects,
  useWorklog
} from "../api/hooks";
import {
  OKR_STATUSES,
  type Entity,
  type KeyResult,
  type Objective,
  type OkrStatus,
  type Project,
  type ReviewType
} from "../api/types";
import { NativeSelect } from "../components/NativeSelect";
import { ProjectIcon } from "../components/ProjectIcon";
import {
  formatMonth,
  parseRefs,
  scoreTone,
  shiftQuarter,
  STATUS_LABEL,
  TIER_SUGGESTIONS
} from "../lib/okr";

type Editor =
  | { kind: "objective"; objective?: Objective }
  | { kind: "key-result"; objective: Objective; keyResult?: KeyResult }
  | { kind: "score"; keyResult: KeyResult }
  | { kind: "review"; type: ReviewType; period: string; existing?: Entity }
  | null;

export function OkrPage() {
  const { data: periods } = useOkrCurrent();
  const [params, setParams] = useSearchParams();
  const quarter = params.get("q") ?? periods?.quarter ?? null;
  const { data: okr, isLoading } = useOkr(quarter);
  const { data: reviews } = useOkrReviews(quarter);
  const { data: projects } = useProjects();
  const projectById = useMemo(
    () => new Map((projects ?? []).map((p) => [p.id, p])),
    [projects]
  );
  const [editor, setEditor] = useState<Editor>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);

  const goQuarter = (delta: number) => {
    if (!quarter) return;
    setParams({ q: shiftQuarter(quarter, delta) });
  };
  const isCurrent = quarter === periods?.quarter;

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        <header className="flex flex-wrap items-center gap-3">
          <TargetIcon size={18} className="text-kumo-brand" />
          <h1 className="text-lg font-semibold">OKR</h1>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              shape="square"
              icon={<CaretLeftIcon size={14} />}
              aria-label="Previous quarter"
              onClick={() => goQuarter(-1)}
            />
            <span className="font-mono tabular-nums text-sm">{quarter ?? "…"}</span>
            <Button
              variant="ghost"
              size="sm"
              shape="square"
              icon={<CaretRightIcon size={14} />}
              aria-label="Next quarter"
              onClick={() => goQuarter(1)}
            />
            {!isCurrent && periods && (
              <button
                className="ml-1 text-xs text-kumo-brand hover:underline"
                onClick={() => setParams({})}
              >
                current
              </button>
            )}
          </div>
          <div className="ml-auto flex gap-2">
            <Button
              size="sm"
              icon={<PlusIcon size={14} />}
              onClick={() =>
                periods &&
                setEditor({ kind: "review", type: "weekly", period: periods.week })
              }
            >
              Weekly review
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={<PlusIcon size={14} />}
              onClick={() => setEditor({ kind: "objective" })}
            >
              Objective
            </Button>
          </div>
        </header>

        <p className="text-xs text-kumo-subtle">
          Higher tier goes first. Objectives stay fixed for the quarter; key results are refined
          monthly, and every plan change keeps its reason. A score of about 0.7 is on target.
        </p>

        {isLoading || !okr ? (
          <div className="text-sm text-kumo-subtle">Loading…</div>
        ) : okr.objectives.length === 0 ? (
          <div className="border border-dashed border-kumo-line rounded-md p-8 text-center text-sm text-kumo-subtle">
            No objectives for {okr.quarter} yet.
          </div>
        ) : (
          <div className="space-y-3">
            {okr.objectives.map((objective) => (
              <ObjectiveCard
                key={objective.id}
                objective={objective}
                months={okr.months}
                currentMonth={periods?.month}
                project={objective.projectId ? projectById.get(objective.projectId) : undefined}
                historyFor={historyFor}
                onToggleHistory={(id) => setHistoryFor(historyFor === id ? null : id)}
                onEdit={setEditor}
              />
            ))}
          </div>
        )}

        <ReviewsSection
          reviews={reviews ?? []}
          onEdit={(review) =>
            setEditor({
              kind: "review",
              type: (review.metadata.type as ReviewType) ?? "weekly",
              period: String(review.metadata.period ?? ""),
              existing: review
            })
          }
          onMonthly={() =>
            periods && setEditor({ kind: "review", type: "monthly", period: periods.month })
          }
        />
      </div>

      {editor?.kind === "objective" && quarter && (
        <ObjectiveForm
          quarter={quarter}
          objective={editor.objective}
          projects={projects ?? []}
          onClose={() => setEditor(null)}
        />
      )}
      {editor?.kind === "key-result" && okr && (
        <KeyResultForm
          objective={editor.objective}
          keyResult={editor.keyResult}
          months={okr.months}
          defaultMonth={
            periods && okr.months.includes(periods.month) ? periods.month : okr.months[0]!
          }
          onClose={() => setEditor(null)}
        />
      )}
      {editor?.kind === "score" && (
        <ScoreForm keyResult={editor.keyResult} onClose={() => setEditor(null)} />
      )}
      {editor?.kind === "review" && (
        <ReviewForm
          type={editor.type}
          period={editor.period}
          existing={editor.existing ?? reviews?.find(
            (r) => r.metadata.type === editor.type && r.metadata.period === editor.period
          )}
          onClose={() => setEditor(null)}
        />
      )}
    </div>
  );
}

function ObjectiveCard({
  objective,
  months,
  currentMonth,
  project,
  historyFor,
  onToggleHistory,
  onEdit
}: {
  objective: Objective;
  months: string[];
  currentMonth: string | undefined;
  project: Project | undefined;
  historyFor: string | null;
  onToggleHistory: (id: string) => void;
  onEdit: (editor: Editor) => void;
}) {
  const closed = objective.status === "done" || objective.status === "rejected";
  return (
    <section
      className={`border border-kumo-line rounded-md bg-kumo-base overflow-hidden ${closed ? "opacity-60" : ""}`}
    >
      <div className="px-3 py-2 border-b border-kumo-hairline bg-kumo-tint/40 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={objective.tierRank < 10 ? "info" : "secondary"}>{objective.tier}</Badge>
          {project && (
            <span className="flex items-center gap-1 text-xxs">
              <ProjectIcon color={project.color} icon={project.icon} size={10} />
              <span className="font-mono" style={{ color: project.color }}>
                {project.key}
              </span>
              <span className="text-kumo-subtle">{project.name}</span>
            </span>
          )}
          {objective.key && (
            <span className="font-mono text-xxs text-kumo-placeholder">{objective.key}</span>
          )}
          {objective.status !== "open" && (
            <span className="text-xxs text-kumo-subtle">{STATUS_LABEL[objective.status as OkrStatus]}</span>
          )}
          <div className="ml-auto flex items-center">
            <IconButton label="History" onClick={() => onToggleHistory(objective.id)}>
              <ClockCounterClockwiseIcon size={14} />
            </IconButton>
            <IconButton label="Edit objective" onClick={() => onEdit({ kind: "objective", objective })}>
              <PencilSimpleIcon size={14} />
            </IconButton>
            <IconButton label="Add key result" onClick={() => onEdit({ kind: "key-result", objective })}>
              <PlusIcon size={14} />
            </IconButton>
          </div>
        </div>
        <h2 className="text-sm font-semibold">{objective.title}</h2>
        {objective.body.trim() && <Markdown>{objective.body}</Markdown>}
        {historyFor === objective.id && <History entityId={objective.id} />}
      </div>

      {months.map((month) => {
        const krs = objective.keyResults.filter((kr) => kr.month === month);
        if (!krs.length) return null;
        return (
          <div key={month}>
            <div className="px-3 pt-2 text-xxs uppercase tracking-wide text-kumo-placeholder">
              {formatMonth(month)}
              {month === currentMonth && <span className="ml-1 text-kumo-brand">· this month</span>}
            </div>
            {krs.map((kr) => (
              <KeyResultRow
                key={kr.id}
                keyResult={kr}
                showHistory={historyFor === kr.id}
                onToggleHistory={() => onToggleHistory(kr.id)}
                onEdit={() => onEdit({ kind: "key-result", objective, keyResult: kr })}
                onScore={() => onEdit({ kind: "score", keyResult: kr })}
              />
            ))}
          </div>
        );
      })}
      {objective.keyResults.length === 0 && (
        <div className="px-3 py-2 text-xs text-kumo-placeholder">No key results yet.</div>
      )}
      <div className="h-2" />
    </section>
  );
}

function KeyResultRow({
  keyResult,
  showHistory,
  onToggleHistory,
  onEdit,
  onScore
}: {
  keyResult: KeyResult;
  showHistory: boolean;
  onToggleHistory: () => void;
  onEdit: () => void;
  onScore: () => void;
}) {
  const closed = keyResult.status === "done" || keyResult.status === "rejected";
  return (
    <div className="px-3 py-1 group">
      <div className="flex items-start gap-2 text-sm">
        <button
          onClick={onScore}
          title="Score this key result"
          className={`mt-0.5 shrink-0 w-10 rounded text-center font-mono text-xs tabular-nums py-0.5 ${scoreTone(keyResult.score)}`}
        >
          {keyResult.score === null ? "—" : keyResult.score.toFixed(1)}
        </button>
        <div className="min-w-0 flex-1">
          <div className={closed ? "line-through text-kumo-subtle" : ""}>
            {keyResult.title}
          </div>
          <div className="flex flex-wrap gap-x-2 text-xxs text-kumo-placeholder">
            {keyResult.key && <span className="font-mono">{keyResult.key}</span>}
            {keyResult.dueAt && <span>due {keyResult.dueAt.slice(0, 10)}</span>}
            {keyResult.status !== "open" && (
              <span>{STATUS_LABEL[keyResult.status as OkrStatus]}</span>
            )}
          </div>
          {keyResult.body.trim() && (
            <div className="text-xs text-kumo-subtle whitespace-pre-wrap">{keyResult.body}</div>
          )}
          {showHistory && <History entityId={keyResult.id} />}
        </div>
        <div className="flex sm:opacity-0 sm:group-hover:opacity-100 focus-within:opacity-100">
          <IconButton label="History" onClick={onToggleHistory}>
            <ClockCounterClockwiseIcon size={14} />
          </IconButton>
          <IconButton label="Edit key result" onClick={onEdit}>
            <PencilSimpleIcon size={14} />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

function History({ entityId }: { entityId: string }) {
  const { data, isLoading } = useWorklog(entityId);
  if (isLoading) return <div className="text-xxs text-kumo-subtle py-1">Loading history…</div>;
  if (!data?.length) return <div className="text-xxs text-kumo-subtle py-1">No changes recorded.</div>;
  return (
    <ol className="mt-1 mb-1 space-y-1 border-l border-kumo-line pl-2">
      {data.map((entry) => (
        <li key={entry.id} className="text-xxs">
          <span className="text-kumo-placeholder">
            {entry.createdAt.slice(0, 16).replace("T", " ")}
          </span>
          <div className="whitespace-pre-wrap text-kumo-subtle">{entry.body}</div>
        </li>
      ))}
    </ol>
  );
}

function ReviewsSection({
  reviews,
  onEdit,
  onMonthly
}: {
  reviews: Entity[];
  onEdit: (review: Entity) => void;
  onMonthly: () => void;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">Reviews</h2>
        <button className="ml-auto text-xs text-kumo-brand hover:underline" onClick={onMonthly}>
          + monthly check
        </button>
      </div>
      {reviews.length === 0 ? (
        <div className="text-xs text-kumo-placeholder">No reviews this quarter.</div>
      ) : (
        reviews.map((review) => {
          const top5 = (review.metadata.top5 as Array<{ title: string; refIds: string[] }>) ?? [];
          return (
            <article key={review.id} className="border border-kumo-line rounded-md bg-kumo-base p-3 space-y-1">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-medium">{review.title}</h3>
                <IconButton label="Edit review" onClick={() => onEdit(review)}>
                  <PencilSimpleIcon size={14} />
                </IconButton>
              </div>
              {top5.length > 0 && (
                <ol className="list-decimal pl-5 text-sm">
                  {top5.map((item, i) => (
                    <li key={i}>{item.title}</li>
                  ))}
                </ol>
              )}
              {review.body.trim() && <Markdown>{review.body}</Markdown>}
            </article>
          );
        })
      )}
    </section>
  );
}

function ObjectiveForm({
  quarter,
  objective,
  projects,
  onClose
}: {
  quarter: string;
  objective?: Objective;
  projects: Project[];
  onClose: () => void;
}) {
  const [projectId, setProjectId] = useState(objective?.projectId ?? projects[0]?.id ?? "");
  const [tier, setTier] = useState(objective?.tier ?? "");
  const [title, setTitle] = useState(objective?.title ?? "");
  const [body, setBody] = useState(objective?.body ?? "");
  const [status, setStatus] = useState<OkrStatus>((objective?.status as OkrStatus) ?? "open");
  const [reason, setReason] = useState("");
  const save = useOkrMutation(() =>
    objective
      ? api.updateObjective(objective.id, {
          title: title.trim(),
          body,
          tier: tier.trim(),
          status,
          ...(reason.trim() ? { reason: reason.trim() } : {})
        })
      : api.createObjective({ projectId, quarter, title: title.trim(), body, tier: tier.trim() })
  );
  const valid = title.trim() && tier.trim() && (objective || projectId);

  return (
    <FormDialog
      title={objective ? `Edit objective${objective.key ? ` · ${objective.key}` : ""}` : `New objective · ${quarter}`}
      onClose={onClose}
      onSubmit={async () => {
        await save.mutateAsync(undefined);
        onClose();
      }}
      canSubmit={Boolean(valid) && !save.isPending}
      pending={save.isPending}
      error={save.error}
    >
      {!objective && (
        <NativeSelect label="Project" className="w-full" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.key} — {p.name}
            </option>
          ))}
        </NativeSelect>
      )}
      <Input
        label="Tier"
        className="w-full"
        list="okr-tiers"
        placeholder="P0, P3, Side 1…"
        value={tier}
        onChange={(e) => setTier(e.target.value)}
      />
      <datalist id="okr-tiers">
        {TIER_SUGGESTIONS.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <Input label="Objective" className="w-full" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      <InputArea
        label="Notes (markdown)"
        className="h-24 w-full resize-y py-1.5 text-sm"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      {objective && (
        <>
          <StatusSelect value={status} onChange={setStatus} />
          <Input
            label="Reason for the change"
            className="w-full"
            placeholder="New information, not a new idea"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </>
      )}
    </FormDialog>
  );
}

function KeyResultForm({
  objective,
  keyResult,
  months,
  defaultMonth,
  onClose
}: {
  objective: Objective;
  keyResult?: KeyResult;
  months: string[];
  defaultMonth: string;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(keyResult?.title ?? "");
  const [body, setBody] = useState(keyResult?.body ?? "");
  const [month, setMonth] = useState(keyResult?.month ?? defaultMonth);
  const [due, setDue] = useState(keyResult?.dueAt?.slice(0, 10) ?? "");
  const [status, setStatus] = useState<OkrStatus>((keyResult?.status as OkrStatus) ?? "open");
  const [reason, setReason] = useState("");
  const dueAt = due ? `${due}T12:00:00.000Z` : null;

  const planChanged =
    !!keyResult &&
    (title.trim() !== (keyResult.title ?? "") ||
      body !== keyResult.body ||
      month !== keyResult.month ||
      (keyResult.dueAt?.slice(0, 10) ?? "") !== due);
  const needsReason = planChanged && !reason.trim();

  const save = useOkrMutation(() =>
    keyResult
      ? api.updateKeyResult(keyResult.id, {
          ...(planChanged ? { title: title.trim(), body, month, dueAt } : {}),
          status,
          ...(reason.trim() ? { reason: reason.trim() } : {})
        })
      : api.createKeyResult({ objectiveId: objective.id, title: title.trim(), body, month, dueAt })
  );

  return (
    <FormDialog
      title={keyResult ? `Edit key result${keyResult.key ? ` · ${keyResult.key}` : ""}` : `New key result · ${objective.title}`}
      onClose={onClose}
      onSubmit={async () => {
        await save.mutateAsync(undefined);
        onClose();
      }}
      canSubmit={Boolean(title.trim()) && !needsReason && !save.isPending}
      pending={save.isPending}
      error={save.error}
    >
      <Input label="Key result" className="w-full" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      <div className="grid grid-cols-2 gap-3">
        <NativeSelect label="Month" className="w-full" value={month} onChange={(e) => setMonth(e.target.value)}>
          {months.map((m) => (
            <option key={m} value={m}>
              {formatMonth(m)}
            </option>
          ))}
        </NativeSelect>
        <Input label="Due date" type="date" className="w-full" value={due} onChange={(e) => setDue(e.target.value)} />
      </div>
      <InputArea
        label="Details"
        className="h-20 w-full resize-y py-1.5 text-sm"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      {keyResult && (
        <>
          <StatusSelect value={status} onChange={setStatus} />
          <Input
            label={planChanged ? "Reason for the change (required)" : "Reason for the change"}
            className="w-full"
            placeholder="New information, not a new idea"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </>
      )}
    </FormDialog>
  );
}

function ScoreForm({ keyResult, onClose }: { keyResult: KeyResult; onClose: () => void }) {
  const [score, setScore] = useState(keyResult.score === null ? "" : String(keyResult.score));
  const [note, setNote] = useState("");
  const parsed = score.trim() === "" ? null : Number(score);
  const valid = parsed === null || (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1);
  const save = useOkrMutation(() =>
    api.scoreKeyResult(keyResult.id, { score: parsed, ...(note.trim() ? { note: note.trim() } : {}) })
  );
  return (
    <FormDialog
      title={`Score · ${keyResult.title}`}
      width="sm:w-md"
      onClose={onClose}
      onSubmit={async () => {
        await save.mutateAsync(undefined);
        onClose();
      }}
      canSubmit={valid && !save.isPending}
      pending={save.isPending}
      error={save.error}
    >
      <Input
        label="Score (0–1, about 0.7 is on target; empty clears it)"
        type="number"
        min={0}
        max={1}
        step={0.1}
        className="w-full"
        value={score}
        onChange={(e) => setScore(e.target.value)}
        autoFocus
      />
      <Input label="Note" className="w-full" value={note} onChange={(e) => setNote(e.target.value)} />
    </FormDialog>
  );
}

function ReviewForm({
  type,
  period,
  existing,
  onClose
}: {
  type: ReviewType;
  period: string;
  existing?: Entity;
  onClose: () => void;
}) {
  const existingTop = (existing?.metadata.top5 as Array<{ title: string; refIds: string[] }>) ?? [];
  const [reviewType, setReviewType] = useState<ReviewType>(type);
  const [reviewPeriod, setReviewPeriod] = useState(period);
  const [body, setBody] = useState(existing?.body ?? "");
  const [items, setItems] = useState(() =>
    Array.from({ length: 5 }, (_, i) => ({
      title: existingTop[i]?.title ?? "",
      refs: (existingTop[i]?.refIds ?? []).map((id) => id.slice(0, 8)).join(", ")
    }))
  );
  const save = useOkrMutation(async () => {
    const top5 = [];
    for (const item of items) {
      if (!item.title.trim()) continue;
      top5.push({ title: item.title.trim(), refIds: await parseRefs(item.refs) });
    }
    return api.recordReview({ type: reviewType, period: reviewPeriod.trim(), body, top5 });
  });

  return (
    <FormDialog
      title={reviewType === "weekly" ? "Weekly review" : "Monthly check"}
      onClose={onClose}
      onSubmit={async () => {
        await save.mutateAsync(undefined);
        onClose();
      }}
      canSubmit={Boolean(reviewPeriod.trim()) && !save.isPending}
      pending={save.isPending}
      error={save.error}
    >
      <div className="grid grid-cols-2 gap-3">
        <NativeSelect
          label="Type"
          className="w-full"
          value={reviewType}
          onChange={(e) => setReviewType(e.target.value as ReviewType)}
        >
          <option value="weekly">Weekly review</option>
          <option value="monthly">Monthly check</option>
        </NativeSelect>
        <Input
          label={reviewType === "weekly" ? "Week (2026-W44)" : "Month (2026-11)"}
          className="w-full"
          value={reviewPeriod}
          onChange={(e) => setReviewPeriod(e.target.value)}
        />
      </div>
      {reviewType === "weekly" && (
        <div className="space-y-2">
          <div className="text-base font-medium">Top 5</div>
          {items.map((item, i) => (
            <div key={i} className="grid grid-cols-[1.5rem_1fr_9rem] items-center gap-2">
              <span className="text-xs text-kumo-subtle tabular-nums">{i + 1}.</span>
              <Input
                aria-label={`Top ${i + 1}`}
                className="w-full"
                value={item.title}
                onChange={(e) =>
                  setItems(items.map((it, j) => (j === i ? { ...it, title: e.target.value } : it)))
                }
              />
              <Input
                aria-label={`Top ${i + 1} tasks`}
                className="w-full font-mono text-xs"
                placeholder="BOT-55, T2DF-3"
                value={item.refs}
                onChange={(e) =>
                  setItems(items.map((it, j) => (j === i ? { ...it, refs: e.target.value } : it)))
                }
              />
            </div>
          ))}
        </div>
      )}
      <InputArea
        label="Notes (markdown)"
        className="h-28 w-full resize-y py-1.5 text-sm"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
    </FormDialog>
  );
}

function StatusSelect({ value, onChange }: { value: OkrStatus; onChange: (s: OkrStatus) => void }) {
  return (
    <NativeSelect label="Status" className="w-full" value={value} onChange={(e) => onChange(e.target.value as OkrStatus)}>
      {OKR_STATUSES.map((s) => (
        <option key={s} value={s}>
          {STATUS_LABEL[s]}
        </option>
      ))}
    </NativeSelect>
  );
}

function FormDialog({
  title,
  width = "sm:w-xl",
  onClose,
  onSubmit,
  canSubmit,
  pending,
  error,
  children
}: {
  title: string;
  width?: string;
  onClose: () => void;
  onSubmit: () => Promise<void>;
  canSubmit: boolean;
  pending: boolean;
  error: unknown;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog className={width}>
        <div className="h-11 pl-4 pr-2 flex items-center justify-between border-b border-kumo-hairline">
          <Dialog.Title className="text-base font-semibold text-kumo-default truncate">{title}</Dialog.Title>
          <Button variant="ghost" size="sm" shape="square" icon={<XIcon size={14} />} aria-label="Close" onClick={onClose} />
        </div>
        <form
          className="p-4 space-y-4 max-h-[75vh] overflow-y-auto"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (canSubmit) onSubmit().catch(() => undefined);
          }}
        >
          {children}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!canSubmit}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
          {error != null && <div className="text-xs text-kumo-danger break-words">{(error as Error).message}</div>}
        </form>
      </Dialog>
    </Dialog.Root>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Button variant="ghost" size="sm" shape="square" icon={children} aria-label={label} title={label} onClick={onClick} />
  );
}

function Markdown({ children }: { children: string }) {
  return (
    <div className="text-xs leading-relaxed text-kumo-subtle space-y-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_code]:bg-kumo-tint [&_code]:px-1 [&_code]:rounded">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
