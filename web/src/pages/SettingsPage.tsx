import { Badge } from "@cloudflare/kumo/components/badge";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { ClipboardText } from "@cloudflare/kumo/components/clipboard-text";
import { Collapsible } from "@cloudflare/kumo/components/collapsible";
import { Combobox } from "@cloudflare/kumo/components/combobox";
import { Input } from "@cloudflare/kumo/components/input";
import { Link } from "@cloudflare/kumo/components/link";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Meter } from "@cloudflare/kumo/components/meter";
import { Select } from "@cloudflare/kumo/components/select";
import { SensitiveInput } from "@cloudflare/kumo/components/sensitive-input";
import { Switch } from "@cloudflare/kumo/components/switch";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { cn } from "@cloudflare/kumo/utils";
import {
  ArrowSquareOutIcon,
  ArrowsClockwiseIcon,
  BrainIcon,
  CaretRightIcon,
  CheckCircleIcon,
  CheckIcon,
  CommandIcon,
  CopyIcon,
  GearSixIcon,
  InfoIcon,
  KeyIcon,
  LightningIcon,
  PackageIcon,
  PlugIcon,
  PlusIcon,
  PuzzlePieceIcon,
  SignOutIcon,
  TerminalWindowIcon,
  TrashIcon,
  UserIcon,
  UsersIcon,
  WarningCircleIcon,
  WarningIcon,
  type Icon
} from "@phosphor-icons/react";
import { formatDistanceToNow } from "date-fns";
import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { api, type AccountUser, type Invite, type Member } from "../api/client";
import {
  useBackfillEmbeddings,
  useCreateToken,
  useEmbeddingSettings,
  useHealth,
  useRevokeToken,
  useTokens,
  useUpdateEmbeddingSettings,
  useUpdateWorkspaceSettings,
  useWorkspaceSettings
} from "../api/hooks";
import type { CreatedToken, EmbeddingProvider, EmbeddingStatusReason } from "../api/types";

const BOTNOTE_HOST =
  typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:4280";
const MAX_EMBEDDING_BACKFILL = 100000;

const CARD = "rounded-lg border border-kumo-line bg-kumo-base";

type TabId = "account" | "members" | "tokens" | "cli" | "plugin" | "embedding" | "mcp" | "about";

interface TabDef {
  id: TabId;
  label: string;
  icon: Icon;
}

const TABS: TabDef[] = [
  { id: "account", label: "Account", icon: UserIcon },
  { id: "members", label: "Members", icon: UsersIcon },
  { id: "tokens", label: "API tokens", icon: KeyIcon },
  { id: "cli", label: "CLI", icon: TerminalWindowIcon },
  { id: "plugin", label: "Plugin", icon: PuzzlePieceIcon },
  { id: "embedding", label: "Embeddings", icon: BrainIcon },
  { id: "mcp", label: "MCP", icon: PlugIcon },
  { id: "about", label: "About", icon: InfoIcon }
];

export function SettingsPage() {
  const [tab, setTab] = useState<TabId>("account");

  return (
    <div className="flex h-full flex-col overflow-hidden bg-kumo-canvas md:flex-row">
      <nav
        aria-label="Settings"
        className="hidden w-52 shrink-0 overflow-y-auto border-r border-kumo-line bg-kumo-base scrollbar-thin md:block"
      >
        <div className="flex items-center gap-2 px-4 pt-4 pb-2">
          <GearSixIcon size={16} className="text-kumo-brand" />
          <span className="text-sm font-semibold text-kumo-default">Settings</span>
        </div>
        <ul className="space-y-0.5 px-2 pb-4">
          {TABS.map((t) => {
            const active = tab === t.id;
            return (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => setTab(t.id)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:outline-none",
                    active
                      ? "bg-kumo-tint font-medium text-kumo-default"
                      : "text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default"
                  )}
                >
                  <t.icon size={15} className={active ? "text-kumo-brand" : "text-kumo-placeholder"} />
                  {t.label}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="shrink-0 border-b border-kumo-line bg-kumo-base px-2 md:hidden">
        <Tabs
          variant="underline"
          size="sm"
          tabs={TABS.map((t) => ({ value: t.id, label: t.label }))}
          value={tab}
          onValueChange={(v) => setTab(v as TabId)}
        />
      </div>

      <main className="min-w-0 flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 md:px-8 md:py-8">
          {tab === "account" && <AccountSection />}
          {tab === "members" && <MembersSection />}
          {tab === "tokens" && <TokensSection />}
          {tab === "cli" && <CliSection />}
          {tab === "plugin" && <PluginSection />}
          {tab === "embedding" && <EmbeddingSection />}
          {tab === "mcp" && <McpSection />}
          {tab === "about" && <AboutSection />}
        </div>
      </main>
    </div>
  );
}

// ----------------------------------------------------------------------------

function SectionHeader({ title, blurb }: { title: string; blurb?: string }) {
  return (
    <header className="space-y-1.5 border-b border-kumo-hairline pb-4">
      <h1 className="text-lg font-semibold text-kumo-default">{title}</h1>
      {blurb && <p className="max-w-xl text-xs leading-relaxed text-kumo-subtle">{blurb}</p>}
    </header>
  );
}

function SubHeader({ title, blurb }: { title: string; blurb?: string }) {
  return (
    <div className="pt-2">
      <h2 className="text-sm font-semibold text-kumo-default">{title}</h2>
      {blurb && <p className="mt-0.5 text-xs leading-relaxed text-kumo-subtle">{blurb}</p>}
    </div>
  );
}

function CardHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-8 items-center justify-between gap-2 border-b border-kumo-hairline bg-kumo-recessed px-3">
      <span className="text-xxs font-medium tracking-wider text-kumo-subtle uppercase">{title}</span>
      {children}
    </div>
  );
}

function Field({
  label,
  htmlFor,
  className,
  children
}: {
  label: string;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}) {
  const labelClass = "block text-xs font-medium text-kumo-default";
  return (
    <div className={cn("space-y-1", className)}>
      {htmlFor ? (
        <label htmlFor={htmlFor} className={labelClass}>
          {label}
        </label>
      ) : (
        <div className={labelClass}>{label}</div>
      )}
      {children}
    </div>
  );
}

type NoticeTone = "info" | "success" | "warning" | "error" | "neutral";

const NOTICE_STYLE: Record<
  NoticeTone,
  { variant: "default" | "alert" | "error" | "secondary"; icon: Icon; className?: string }
> = {
  info: { variant: "default", icon: InfoIcon },
  success: {
    variant: "default",
    icon: CheckCircleIcon,
    className: "bg-kumo-success-tint text-kumo-success"
  },
  warning: { variant: "alert", icon: WarningIcon },
  error: { variant: "error", icon: WarningCircleIcon },
  neutral: { variant: "secondary", icon: InfoIcon }
};

function Notice({ tone, children }: { tone: NoticeTone; children: ReactNode }) {
  const { variant, icon: NoticeIcon, className } = NOTICE_STYLE[tone];
  return (
    <Banner
      size="sm"
      variant={variant}
      icon={<NoticeIcon size={14} weight="fill" />}
      description={<span className="text-xs leading-relaxed">{children}</span>}
      className={cn("items-start", className)}
    />
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  function copy(text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  }
  return [copied, copy];
}

// ----------------------------------------------------------------------------

function AccountSection() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  async function onLogout() {
    if (busy) return;
    setBusy(true);
    try {
      await api.logout();
    } catch {
      // Even if the server call fails, fall through to the login page —
      // clearing the cookie locally is the user-visible part.
    }
    navigate("/login", { replace: true });
  }

  return (
    <>
      <SectionHeader
        title="Account"
        blurb="You sign in to the web UI with your email and password. Agents (CLI / MCP) authenticate with bearer tokens, generated under API tokens."
      />
      <PasswordCard />
      <WorkspaceTimezoneCard />
      <div className={cn(CARD, "flex items-center justify-between gap-3 px-4 py-3")}>
        <div className="text-xs text-kumo-subtle">
          Sign out of this browser. Other devices and any active bearer tokens
          are unaffected.
        </div>
        <Button
          variant="secondary-destructive"
          size="sm"
          icon={<SignOutIcon size={13} />}
          disabled={busy}
          onClick={onLogout}
          className="shrink-0"
        >
          Log out
        </Button>
      </div>
    </>
  );
}

function inviteUrl(token: string): string {
  return `${window.location.origin}/invite/${token}`;
}

function MembersSection() {
  const [me, setMe] = useState<AccountUser | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [fresh, setFresh] = useState<{ id: string; url: string } | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canManage = me?.role === "owner" || me?.role === "admin";

  async function load(manage: boolean) {
    const [m, i] = await Promise.all([
      api.listMembers(),
      manage ? api.listInvites() : Promise.resolve([] as Invite[])
    ]);
    setMembers(m);
    setInvites(i);
  }

  useEffect(() => {
    let cancelled = false;
    api
      .whoami()
      .then(async (who) => {
        if (cancelled) return;
        setMe(who.user);
        if (who.user) await load(who.user.role !== "member");
        else setMembers([]);
      })
      .catch((err) => {
        if (!cancelled) setError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      await load(canManage);
    } catch (err) {
      setError(errorText(err));
    }
    setBusy(false);
  }

  function onInvite(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      const invite = await api.createInvite(email.trim() ? { email: email.trim() } : {});
      setFresh({ id: invite.id, url: inviteUrl(invite.token) });
      setEmail("");
    });
  }

  function onRemove(member: Member) {
    if (
      !confirm(
        `Remove ${member.name} (${member.email})? Their sign-in and API tokens stop working. What they wrote stays, and their projects pass to the owner.`
      )
    ) {
      return;
    }
    void run(() => api.removeMember(member.id));
  }

  if (members && !me) {
    return (
      <>
        <SectionHeader title="Members" />
        <Notice tone="info">
          This instance has no accounts yet. Create the owner account from the sign-in page to
          invite other people.
        </Notice>
      </>
    );
  }

  return (
    <>
      <SectionHeader
        title="Members"
        blurb="People who can sign in here. Everyone sees the projects marked Shared. A private project, and anything kept outside a project, is visible only to the person who owns it, and to no one else, the owner of this instance included."
      />

      {error && <Notice tone="error">{error}</Notice>}

      <div className={cn(CARD, "overflow-hidden")}>
        <CardHeader title="People" />
        {!members && (
          <div className="flex items-center gap-2 px-4 py-3 text-xs text-kumo-subtle">
            <Loader size="sm" /> Loading…
          </div>
        )}
        {members?.map((m) => (
          <div
            key={m.id}
            className="flex items-center gap-3 border-b border-kumo-hairline px-4 py-2.5 last:border-b-0"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium text-kumo-default">
                {m.name}
                {m.id === me?.id && <span className="text-kumo-subtle"> (you)</span>}
              </div>
              <div className="truncate text-xxs text-kumo-subtle">{m.email}</div>
            </div>
            <Badge variant="secondary" className="text-[11px] capitalize">
              {m.role}
            </Badge>
            {me?.role === "owner" && m.role !== "owner" && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(() => api.setMemberRole(m.id, m.role === "admin" ? "member" : "admin").then(() => {}))
                }
              >
                {m.role === "admin" ? "Make member" : "Make admin"}
              </Button>
            )}
            {canManage && m.role !== "owner" && m.id !== me?.id && (me?.role === "owner" || m.role === "member") && (
              <Button
                variant="ghost"
                size="sm"
                shape="square"
                icon={<TrashIcon size={13} />}
                title={`Remove ${m.name}`}
                aria-label={`Remove ${m.name}`}
                className="text-kumo-subtle"
                disabled={busy}
                onClick={() => onRemove(m)}
              />
            )}
          </div>
        ))}
      </div>

      {canManage && (
        <form onSubmit={onInvite} className={cn(CARD, "overflow-hidden")}>
          <CardHeader title="Invite someone" />
          <div className="space-y-3 px-4 py-3">
            <div className="text-xs leading-relaxed text-kumo-subtle">
              Create a link and send it yourself, by any channel. It works once and expires in 7
              days. The person picks their own password.
            </div>
            <div className="flex items-end gap-2">
              <Field label="Their email (optional)" htmlFor="invite-email" className="min-w-0 flex-1">
                <Input
                  id="invite-email"
                  type="email"
                  className="w-full"
                  placeholder="Leave empty to let anyone with the link join"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={busy}
                />
              </Field>
              <Button type="submit" variant="primary" size="sm" icon={<PlusIcon size={13} />} disabled={busy}>
                Create invite link
              </Button>
            </div>
            {fresh && (
              <Banner
                variant="alert"
                icon={<WarningIcon size={16} weight="fill" />}
                title="Copy this link now. It is not shown again."
                description={
                  <div className="mt-1.5 flex items-center gap-2">
                    <ClipboardText size="sm" text={fresh.url} className="min-w-0 flex-1" />
                    <Button size="sm" onClick={() => setFresh(null)}>
                      Done
                    </Button>
                  </div>
                }
              />
            )}
            {invites.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-xxs font-medium tracking-wider text-kumo-subtle uppercase">
                  Open invites
                </div>
                {invites.map((i) => (
                  <div key={i.id} className="flex items-center gap-2 text-xs text-kumo-default">
                    <span className="min-w-0 flex-1 truncate">
                      {i.email ?? "Anyone with the link"}
                      <span className="text-kumo-subtle">
                        {" "}
                        · expires {formatDistanceToNow(new Date(i.expiresAt), { addSuffix: true })}
                      </span>
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await api.revokeInvite(i.id);
                          if (fresh?.id === i.id) setFresh(null);
                        })
                      }
                    >
                      Revoke
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </form>
      )}
    </>
  );
}

function PasswordCard() {
  const [user, setUser] = useState<AccountUser | null>(null);
  const [name, setName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: NoticeTone; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .whoami()
      .then((who) => {
        if (cancelled) return;
        setUser(who.user);
        setName(who.user?.name ?? "");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!user) return null;

  async function onSaveName() {
    if (savingName || !name.trim()) return;
    setSavingName(true);
    setResult(null);
    try {
      const res = await api.updateProfile({ name: name.trim() });
      setUser(res.user);
      setResult({ tone: "success", text: "Name saved." });
    } catch {
      setResult({ tone: "error", text: "Could not save the name." });
    }
    setSavingName(false);
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (busy || !current || next.length < 8) return;
    setBusy(true);
    setResult(null);
    try {
      await api.changePassword({ currentPassword: current, newPassword: next });
      setCurrent("");
      setNext("");
      setResult({ tone: "success", text: "Password changed. Your other browsers were signed out." });
    } catch (err) {
      const wrong = errorText(err).includes("invalid_password");
      setResult({
        tone: "error",
        text: wrong ? "The current password is wrong." : "Could not change the password."
      });
    }
    setBusy(false);
  }

  return (
    <form onSubmit={onSave} className={cn(CARD, "overflow-hidden")}>
      <CardHeader title="Signed in as" />
      <div className="space-y-3 px-4 py-3">
        <div className="text-xs text-kumo-default">
          {user.name} <span className="text-kumo-subtle">· {user.email} · {user.role}</span>
        </div>
        <div className="flex items-end gap-2">
          <Field label="Name" htmlFor="profile-name" className="min-w-0 flex-1">
            <Input
              id="profile-name"
              autoComplete="name"
              className="w-full"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={savingName}
            />
          </Field>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            loading={savingName}
            disabled={savingName || !name.trim() || name.trim() === user.name}
            onClick={onSaveName}
          >
            Save name
          </Button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Current password" htmlFor="current-password">
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              className="w-full"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              disabled={busy}
            />
          </Field>
          <Field label="New password (at least 8 characters)" htmlFor="new-password">
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              className="w-full"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              disabled={busy}
            />
          </Field>
        </div>
        {result && <Notice tone={result.tone}>{result.text}</Notice>}
        <div className="flex justify-end">
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            loading={busy}
            disabled={busy || !current || next.length < 8}
          >
            Change password
          </Button>
        </div>
      </div>
    </form>
  );
}

function WorkspaceTimezoneCard() {
  const { data } = useWorkspaceSettings();
  const update = useUpdateWorkspaceSettings();
  const [timezone, setTimezone] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const timezoneId = useId();

  // Populate from IANA list, guard if unavailable (old browsers).
  const tzOptions = useMemo<string[]>(() => {
    try {
      return (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
    } catch {
      return [];
    }
  }, []);

  useEffect(() => {
    if (data) setTimezone(data.timezone);
  }, [data]);

  function onPick(value: string) {
    setTimezone(value);
    setMessage(null);
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    await update.mutateAsync({ timezone });
    setMessage("Workspace timezone saved.");
  }

  return (
    <div className={cn(CARD, "space-y-3 px-4 py-4")}>
      <div>
        <div className="text-sm font-semibold text-kumo-default">Workspace timezone</div>
        <p className="mt-0.5 text-xs leading-relaxed text-kumo-subtle">
          Used to compute all-day recurring task occurrence dates on the correct local calendar day.
        </p>
      </div>
      <form onSubmit={onSave} className="flex items-end gap-3">
        <Field label="Timezone" htmlFor={timezoneId} className="min-w-0 flex-1">
          {tzOptions.length > 0 ? (
            <Combobox<string>
              size="sm"
              items={tzOptions}
              value={timezone || null}
              onValueChange={(v) => {
                if (v) onPick(v);
              }}
            >
              <Combobox.TriggerInput id={timezoneId} placeholder="Search timezones…" className="w-full" />
              <Combobox.Content>
                <Combobox.List>
                  {(tz: string) => (
                    <Combobox.Item key={tz} value={tz} className="py-1 text-xs">
                      {tz}
                    </Combobox.Item>
                  )}
                </Combobox.List>
                <Combobox.Empty>No matching timezone</Combobox.Empty>
              </Combobox.Content>
            </Combobox>
          ) : (
            <Input
              id={timezoneId}
              size="sm"
              className="w-full font-mono"
              value={timezone}
              onChange={(e) => onPick(e.target.value)}
              placeholder="UTC"
            />
          )}
        </Field>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          icon={<CheckIcon size={12} weight="bold" />}
          disabled={update.isPending || !timezone}
        >
          {update.isPending ? "Saving..." : "Save"}
        </Button>
      </form>
      {message && <Notice tone="success">{message}</Notice>}
      {update.error && <Notice tone="error">{errorText(update.error)}</Notice>}
    </div>
  );
}

// ----------------------------------------------------------------------------

function CliSection() {
  const installSteps: Step[] = [
    {
      note: "Global install on any machine with node + npm:",
      code: "npm i -g botnote"
    },
    {
      note: (
        <>
          One-time login. The default URL is the daemon on the same machine,{" "}
          <code className="text-kumo-default">http://127.0.0.1:4280</code> (no token needed, loopback is
          trusted). From another machine enter <code className="text-kumo-default">{BOTNOTE_HOST}</code> and
          paste a bearer token from Settings → API tokens.
        </>
      ),
      code: "botnote login"
    }
  ];

  const dailyCommands = [
    { code: "botnote today", desc: "today + overdue" },
    { code: "botnote tasks --status open", desc: "list open tasks" },
    {
      code: 'botnote task "Ship the CLI" --project BOT --priority high --due 2026-06-10',
      desc: "create a task"
    },
    { code: 'botnote note "Random capture" --project BOT --pin', desc: "capture a pinned note" },
    { code: 'botnote search "deployment"', desc: "hybrid search" },
    { code: "botnote projects", desc: "list project keys" }
  ];

  const overrideSteps: Step[] = [
    {
      note: (
        <>
          Per-shell override — skips{" "}
          <code className="text-kumo-default">~/.config/botnote/config.json</code>:
        </>
      ),
      code: "BOTNOTE_URL=http://127.0.0.1:4280 botnote today"
    },
    {
      note: (
        <>
          Config file, preferred for the daemon host —{" "}
          <code className="text-kumo-default">~/.config/botnote/config.json</code>:
        </>
      ),
      code: '{ "baseUrl": "http://127.0.0.1:4280" }'
    }
  ];

  return (
    <>
      <SectionHeader
        title="CLI"
        blurb="The botnote npm package ships a binary that talks to this daemon over HTTP. Same tool for quick capture, today review, and ad-hoc search from any terminal."
      />

      <StepsCard title="Install + login" steps={installSteps} />
      <CommandList title="Daily commands" items={dailyCommands} />
      <StepsCard title="Override the URL" steps={overrideSteps} />
    </>
  );
}

// ----------------------------------------------------------------------------

type PluginClientId = "skills" | "claude" | "codex" | "cursor" | "cli";

const REPO_MARKETPLACE_JSON = `{
  "name": "botnote-plugins",
  "interface": { "displayName": "botnote Plugins" },
  "plugins": [
    {
      "name": "botnote",
      "source": { "source": "local", "path": "./plugins/botnote" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
      "category": "Productivity"
    }
  ]
}`;

function PluginSection() {
  const [client, setClient] = useState<PluginClientId>("claude");

  const clients: {
    id: PluginClientId;
    label: string;
    icon: Icon;
    subtitle: string;
    cards: { title: string; steps: Step[] }[];
  }[] = [
    {
      id: "claude",
      label: "Claude Code",
      icon: CommandIcon,
      subtitle:
        "Recommended for day-to-day work. Update through /plugin, then reload plugins in-session with /reload-plugins.",
      cards: [
        {
          title: "Install",
          steps: [
            {
              note: "In Claude Code, add the marketplace and install the plugin:",
              code: "/plugin marketplace add botnote-dev/botnote\n/plugin install botnote@botnote"
            },
            {
              note: (
                <>
                  Claude Code prompts for <code className="text-kumo-default">botnote_url</code> — leave it
                  empty on the daemon host (defaults to{" "}
                  <code className="text-kumo-default">http://127.0.0.1:4280</code>), enter{" "}
                  <code className="text-kumo-default">{BOTNOTE_HOST}</code> elsewhere — and{" "}
                  <code className="text-kumo-default">botnote_token</code>, a bearer from Settings → API
                  tokens (skip on loopback).
                </>
              )
            }
          ]
        },
        {
          title: "Update",
          steps: [
            {
              note: (
                <>
                  Not every build exposes auto-update. Try the marketplace update first: open{" "}
                  <code className="text-kumo-default">/plugin</code>, then Marketplaces → botnote → Update,
                  if your build shows it.
                </>
              ),
              code: "/plugin"
            },
            {
              note: "If there is no Update action, remove botnote in /plugin, then install it again:",
              code: "/plugin install botnote@botnote"
            },
            {
              note: "Apply changes in the current session:",
              code: "/reload-plugins"
            }
          ]
        }
      ]
    },
    {
      id: "codex",
      label: "Codex",
      icon: TerminalWindowIcon,
      subtitle:
        "Git marketplace flow with sparse checkout — no full botnote source checkout. Restart Codex after install or update.",
      cards: [
        {
          title: "Install",
          steps: [
            {
              note: "Add the Git marketplace. Sparse checkout keeps it light:",
              code: "codex plugin marketplace add https://github.com/botnote-dev/botnote.git \\\n  --sparse .agents/plugins \\\n  --sparse plugins/botnote"
            },
            {
              note: "Install the plugin from it:",
              code: "codex plugin add botnote@botnote-plugins"
            },
            {
              note: (
                <>
                  Restart Codex — exit this session, then run{" "}
                  <code className="text-kumo-default">codex</code> again. In the new session, check{" "}
                  <code className="text-kumo-default">/mcp</code>.
                </>
              )
            }
          ]
        },
        {
          title: "Update",
          steps: [
            {
              note: "Refresh the Git marketplace snapshot, then reinstall from it:",
              code: "codex plugin marketplace upgrade botnote-plugins\ncodex plugin remove botnote@botnote-plugins\ncodex plugin add botnote@botnote-plugins"
            },
            { note: "Open a new Codex session after updating." }
          ]
        }
      ]
    },
    {
      id: "cursor",
      label: "Cursor",
      icon: PuzzlePieceIcon,
      subtitle:
        "Uses the same plugin bundle. Keep the CLI installed only if you want terminal commands or offline fallback.",
      cards: [
        {
          title: "Install",
          steps: [
            {
              note: (
                <>
                  Add the repository marketplace in Cursor's plugin UI — metadata lives at{" "}
                  <code className="text-kumo-default">.cursor-plugin/marketplace.json</code>:
                </>
              ),
              code: "https://github.com/botnote-dev/botnote"
            },
            {
              note: "Then install:",
              code: "botnote@botnote-plugins"
            }
          ]
        },
        {
          title: "Update",
          steps: [
            {
              note: "Refresh the marketplace in Cursor's plugin UI. If an explicit update action is unavailable, remove and install again from the same repository marketplace."
            },
            {
              note: "Keep the shared runtime current too:",
              code: "npm i -g botnote@latest"
            }
          ]
        }
      ]
    },
    {
      id: "skills",
      label: "Skills CLI",
      icon: LightningIcon,
      subtitle:
        "Skills-only alternative: installs the workflow skills into 70+ agents, but NOT the MCP server or hooks. Prefer the plugin install above; use this when your agent has no plugin system.",
      cards: [
        {
          title: "Install",
          steps: [
            {
              note: "Install all botnote skills straight from the GitHub repo:",
              code: "npx skills add botnote-dev/botnote"
            },
            {
              note: (
                <>
                  One-time MCP wiring — the skills call botnote MCP tools, which the skills CLI
                  does not set up. Use the command for your client:
                </>
              ),
              code: `# Claude Code\nclaude mcp add botnote \\\n  -e BOTNOTE_URL=${BOTNOTE_HOST} \\\n  -e BOTNOTE_TOKEN=<token> \\\n  -- npx -y botnote mcp\n\n# Codex\ncodex mcp add botnote \\\n  --env BOTNOTE_URL=${BOTNOTE_HOST} \\\n  --env BOTNOTE_TOKEN=<token> \\\n  -- npx -y botnote mcp`
            },
            {
              note: (
                <>
                  On the daemon host use <code className="text-kumo-default">http://127.0.0.1:4280</code> and
                  skip the token. Want the bundled MCP prompts and the session-close feedback hook?
                  Use the Claude Code plugin tab instead.
                </>
              )
            }
          ]
        },
        {
          title: "Update",
          steps: [
            {
              note: "Refresh every installed skill from its source repo:",
              code: "npx skills update"
            },
            {
              note: "Inspect or prune what is installed:",
              code: "npx skills list\nnpx skills remove <name>"
            }
          ]
        }
      ]
    },
    {
      id: "cli",
      label: "CLI runtime",
      icon: PackageIcon,
      subtitle:
        "Optional helper for login, manual CLI commands, and offline fallback. Plugin MCP can run through npx without a global CLI.",
      cards: [
        {
          title: "Install runtime",
          steps: [
            {
              note: "Global install on any machine with node + npm:",
              code: "npm i -g botnote@latest"
            },
            {
              note: (
                <>
                  One-time login. Remote clients: save{" "}
                  <code className="text-kumo-default">{BOTNOTE_HOST}</code> plus a bearer token from
                  Settings → API tokens. On the daemon host, keep the default{" "}
                  <code className="text-kumo-default">http://127.0.0.1:4280</code> and skip the token.
                </>
              ),
              code: "botnote login"
            }
          ]
        },
        {
          title: "Update runtime",
          steps: [
            {
              note: "If you installed the optional helper CLI, keep it current:",
              code: "npm i -g botnote@latest\nbotnote --version"
            }
          ]
        }
      ]
    }
  ];

  const slashCommands = [
    { code: "/botnote:today", desc: "today + overdue" },
    { code: "/botnote:show-todo", desc: "open work across projects" },
    { code: '/botnote:add-task "..."', desc: "create a task" },
    { code: "/botnote:start-work DEMO-12", desc: "pick up a task with project context" },
    { code: '/botnote:remember "..."', desc: "capture a note" },
    { code: '/botnote:recall "..."', desc: "hybrid search" },
    { code: "/botnote:done", desc: "mark current focus done" }
  ];

  const active = clients.find((c) => c.id === client) ?? clients[0]!;

  return (
    <>
      <SectionHeader
        title="Plugin"
        blurb="Add botnote as the plugin-backed MCP + workflow layer for each agent client. Letheia / Plane MCP setup should stay retired."
      />

      <ol className="grid grid-cols-1 gap-2 md:grid-cols-3">
        <PluginStep
          n={1}
          title="Optional CLI"
          body="Install the npm binary when you want botnote login or terminal commands. Plugins can run without it via npx."
        />
        <PluginStep
          n={2}
          title="Install the plugin"
          body="Install the marketplace plugin for your client — it bundles MCP wiring, hooks, and skills. The Skills CLI tab is a skills-only fallback for agents without a plugin system."
        />
        <PluginStep
          n={3}
          title="Reload client"
          body="Claude Code reloads plugins in-session. Codex needs a new session after install or update."
        />
      </ol>

      <Notice tone="info">
        Use <code className="text-kumo-default">{BOTNOTE_HOST}</code> with an API token from this
        settings page on remote devices. On the daemon host, leave the URL empty (defaults to{" "}
        <code className="text-kumo-default">http://127.0.0.1:4280</code>) and skip the token.
      </Notice>

      <section className="space-y-3">
        <Tabs
          variant="underline"
          size="sm"
          tabs={clients.map((c) => ({
            value: c.id,
            label: (
              <span className="flex items-center gap-1.5">
                <c.icon size={13} />
                {c.label}
              </span>
            )
          }))}
          value={client}
          onValueChange={(v) => setClient(v as PluginClientId)}
        />
        <p className="text-xs leading-relaxed text-kumo-subtle">{active.subtitle}</p>
        {active.cards.map((c) => (
          <StepsCard key={`${active.id}-${c.title}`} title={c.title} steps={c.steps} />
        ))}
      </section>

      <SubHeader
        title="Slash commands"
        blurb="Available after Claude Code reloads plugins or Codex starts a new session with the plugin installed."
      />
      <CommandList title="Commands" items={slashCommands} />

      <Collapsible className={CARD}>
        <Collapsible.Trigger className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-4 py-3 text-left text-sm text-kumo-default select-none focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:outline-none">
          <CaretRightIcon
            size={12}
            weight="bold"
            className="shrink-0 text-kumo-placeholder transition-transform [[data-panel-open]_&]:rotate-90"
          />
          <span className="font-medium">Advanced: repo-local marketplace entry</span>
          <span className="ml-1 text-xxs text-kumo-placeholder">
            only when a repo vendors the plugin files
          </span>
        </Collapsible.Trigger>
        <Collapsible.Panel className="space-y-2 px-4 pb-4">
          <p className="text-xs leading-relaxed text-kumo-subtle">
            Marketplace entry for <code className="text-kumo-default">.agents/plugins/marketplace.json</code>.
            Use this only when the repo already vendors{" "}
            <code className="text-kumo-default">./plugins/botnote</code>.
          </p>
          <Snippet code={REPO_MARKETPLACE_JSON} />
        </Collapsible.Panel>
      </Collapsible>

      <div className={cn(CARD, "flex items-start gap-3 px-4 py-3 text-xs leading-relaxed text-kumo-subtle")}>
        <ArrowSquareOutIcon size={14} className="mt-0.5 shrink-0 text-kumo-brand" />
        <div>
          Plugin distribution lives at{" "}
          <Link href="https://github.com/botnote-dev/botnote" target="_blank" rel="noreferrer">
            botnote-dev/botnote
          </Link>
          {". "}
          Claude Code updates through <code className="text-kumo-default">/plugin</code>; after updating or
          reinstalling, run <code className="text-kumo-default">/reload-plugins</code>. Codex has no reload
          command: refresh Git marketplace snapshots with{" "}
          <code className="text-kumo-default">codex plugin marketplace upgrade</code>, reinstall the plugin,
          then start a new Codex session.
        </div>
      </div>
    </>
  );
}

function PluginStep({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <li className={cn(CARD, "px-4 py-3")}>
      <div className="flex items-center gap-2">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-kumo-brand-tint text-xxs font-semibold text-kumo-brand">
          {n}
        </span>
        <span className="text-sm font-medium text-kumo-default">{title}</span>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-kumo-subtle">{body}</p>
    </li>
  );
}

// ----------------------------------------------------------------------------

function EmbeddingSection() {
  const { data, isLoading } = useEmbeddingSettings();
  const update = useUpdateEmbeddingSettings();
  const backfill = useBackfillEmbeddings();
  const [enabled, setEnabled] = useState(true);
  const [provider, setProvider] = useState<EmbeddingProvider>("openai");
  const [model, setModel] = useState("text-embedding-3-small");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const modelId = useId();
  const baseUrlId = useId();
  const apiKeyId = useId();

  useEffect(() => {
    if (!data) return;
    setEnabled(data.enabled);
    setProvider(data.provider);
    setModel(data.model);
    setBaseUrl(data.baseUrl ?? "");
    setApiKey("");
    setClearKey(false);
  }, [data]);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    const trimmedKey = apiKey.trim();
    const input = {
      enabled,
      provider,
      model: model.trim(),
      baseUrl: provider === "openai_compatible" ? baseUrl.trim() || null : null,
      ...(trimmedKey ? { apiKey: trimmedKey } : clearKey ? { apiKey: null } : {})
    };
    const next = await update.mutateAsync(input);
    setApiKey("");
    setClearKey(false);
    setMessage(next.effectiveEnabled ? "Embedding search is ready." : statusReasonText(next.statusReason));
  }

  async function onBackfill() {
    setMessage(null);
    const requested = Math.min(data?.missingCount ?? MAX_EMBEDDING_BACKFILL, MAX_EMBEDDING_BACKFILL);
    const result = await backfill.mutateAsync(requested);
    const capped = data && data.missingCount > MAX_EMBEDDING_BACKFILL;
    setMessage(
      capped
        ? `Queued ${result.enqueued} item(s), the maximum per request. Pending queue: ${result.pendingCount}.`
        : `Queued all ${result.enqueued} missing item(s). Pending queue: ${result.pendingCount}.`
    );
  }

  const embeddedPercent =
    data && data.totalCount > 0 ? Math.round((data.embeddedCount / data.totalCount) * 100) : 0;
  const canBackfill = Boolean(data?.effectiveEnabled && data.missingCount > 0);

  return (
    <>
      <SectionHeader
        title="Embeddings"
        blurb="Configure semantic search for botnote. The database vector column is fixed at 384 dimensions, so provider models must return 384-dimensional embeddings."
      />

      <Notice tone={isLoading ? "neutral" : data?.effectiveEnabled ? "success" : "warning"}>
        {isLoading ? (
          "Loading embedding settings..."
        ) : data?.effectiveEnabled ? (
          <>
            Semantic search is enabled via <strong>{providerLabel(data.provider)}</strong> using{" "}
            <code>{data.model}</code>. Search merges BM25 + cosine + time decay.
          </>
        ) : (
          <>
            Semantic search is not active: {statusReasonText(data?.statusReason ?? "not_loaded")}.
            Text search still works through BM25.
          </>
        )}
      </Notice>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <MetricCard label="Status" value={data?.effectiveEnabled ? "On" : "Off"} />
        <MetricCard label="Embedded" value={`${data?.embeddedCount ?? 0}/${data?.totalCount ?? 0}`} />
        <MetricCard label="Missing" value={`${data?.missingCount ?? 0}`} />
        <MetricCard label="Queue" value={`${data?.pendingCount ?? 0}`} />
      </div>

      <div className={cn(CARD, "space-y-3 px-4 py-3")}>
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs font-semibold text-kumo-default">Vector coverage</div>
          <Button
            size="sm"
            icon={<ArrowsClockwiseIcon size={12} />}
            disabled={!canBackfill || backfill.isPending}
            onClick={onBackfill}
            title={
              data?.effectiveEnabled
                ? "Queue embeddings for all existing records without body_vec"
                : "Enable embeddings before backfilling"
            }
          >
            {backfill.isPending ? "Queueing..." : "Backfill all missing"}
          </Button>
        </div>
        <Meter
          label={`${embeddedPercent}% of task/note records have embeddings.`}
          value={embeddedPercent}
          showValue={false}
        />
      </div>

      <form onSubmit={onSave} className={cn(CARD, "space-y-4 px-4 py-4")}>
        <Switch
          size="sm"
          label="Enable semantic search"
          checked={enabled}
          onCheckedChange={setEnabled}
          // Kumo's default Switch hard-codes a blue checked track; repaint it in the brand color.
          className={cn(
            enabled &&
              "bg-kumo-brand ring-kumo-brand-hover dark:bg-kumo-brand dark:ring-kumo-brand dark:[&>div]:bg-neutral-100"
          )}
        />

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Provider">
            <Select<EmbeddingProvider>
              size="sm"
              aria-label="Provider"
              value={provider}
              onValueChange={(v) => {
                if (v !== null) setProvider(v);
              }}
              renderValue={(v) => providerLabel(v)}
              className="w-full"
            >
              <Select.Option value="openai" className="py-1 text-sm">
                OpenAI
              </Select.Option>
              <Select.Option value="openai_compatible" className="py-1 text-sm">
                OpenAI-compatible
              </Select.Option>
            </Select>
          </Field>

          <Field label="Model" htmlFor={modelId}>
            <Input
              id={modelId}
              size="sm"
              className="w-full font-mono"
              list="embedding-models"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="text-embedding-3-small"
            />
            <datalist id="embedding-models">
              <option value="text-embedding-3-small" />
              <option value="text-embedding-3-large" />
            </datalist>
          </Field>
        </div>

        {provider === "openai_compatible" && (
          <Field label="Base URL" htmlFor={baseUrlId}>
            <Input
              id={baseUrlId}
              size="sm"
              className="w-full font-mono"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
            />
          </Field>
        )}

        <Field label="API key" htmlFor={apiKeyId}>
          <SensitiveInput
            id={apiKeyId}
            size="sm"
            className="font-mono"
            value={apiKey}
            onValueChange={(v) => {
              setApiKey(v);
              if (v) setClearKey(false);
            }}
            placeholder={
              data?.apiKeyConfigured
                ? `Configured (${data.apiKeySource ?? "unknown"}${data.apiKeyPreview ? ` · ${data.apiKeyPreview}` : ""})`
                : "sk-..."
            }
          />
          <div className="flex items-center justify-between gap-3 text-xxs text-kumo-subtle">
            <span>
              Full keys are stored server-side and are not returned to the browser after save.
            </span>
            {data?.settingsApiKeyConfigured && (
              <label className="inline-flex shrink-0 cursor-pointer items-center gap-1.5">
                <Checkbox
                  checked={clearKey}
                  onCheckedChange={(checked) => {
                    setClearKey(checked);
                    if (checked) setApiKey("");
                  }}
                />
                Clear stored key
              </label>
            )}
          </div>
        </Field>

        <Notice tone="neutral">
          OpenAI-compatible providers must accept the OpenAI embeddings API and return{" "}
          <code className="text-kumo-default">384</code> dimensions for the selected model. Existing
          vectors are not automatically regenerated when provider or model changes; use Backfill
          all missing to queue every record that does not have a vector yet.
        </Notice>

        {message && <Notice tone="info">{message}</Notice>}
        {update.error && <Notice tone="error">{errorText(update.error)}</Notice>}
        {backfill.error && <Notice tone="error">{errorText(backfill.error)}</Notice>}

        <div className="flex justify-end">
          <Button
            type="submit"
            variant="primary"
            size="sm"
            icon={<CheckIcon size={12} weight="bold" />}
            disabled={update.isPending || model.trim().length === 0}
          >
            {update.isPending ? "Saving..." : "Save embedding settings"}
          </Button>
        </div>
      </form>
    </>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className={cn(CARD, "px-3 py-2")}>
      <div className="text-xxs tracking-wider text-kumo-subtle uppercase">{label}</div>
      <div className="mt-0.5 text-lg font-semibold text-kumo-default tabular-nums">{value}</div>
    </div>
  );
}

function providerLabel(provider: EmbeddingProvider): string {
  return provider === "openai_compatible" ? "OpenAI-compatible" : "OpenAI";
}

function statusReasonText(reason: EmbeddingStatusReason): string {
  switch (reason) {
    case "ready":
      return "ready";
    case "disabled":
      return "disabled";
    case "missing_api_key":
      return "missing API key";
    case "missing_base_url":
      return "missing base URL";
    case "injected":
      return "using injected test embedder";
    case "not_loaded":
      return "configuration not loaded yet";
  }
}

// ----------------------------------------------------------------------------

function McpSection() {
  const claudeJson = `{
  "mcpServers": {
    "botnote": {
      "command": "botnote",
      "args": ["mcp"],
      "env": {
        "BOTNOTE_URL": "${BOTNOTE_HOST}",
        "BOTNOTE_TOKEN": "bn_..."
      }
    }
  }
}`;

  const codexToml = `[mcp_servers.botnote]
command = "botnote"
args = ["mcp"]

[mcp_servers.botnote.env]
BOTNOTE_URL = "${BOTNOTE_HOST}"
BOTNOTE_TOKEN = "bn_..."`;

  const codexSteps: Step[] = [
    {
      note: (
        <>
          Add to <code className="text-kumo-default">~/.codex/config.toml</code>. On the daemon host, drop{" "}
          <code className="text-kumo-default">BOTNOTE_TOKEN</code> and set{" "}
          <code className="text-kumo-default">BOTNOTE_URL = "http://127.0.0.1:4280"</code> (loopback is
          trusted).
        </>
      ),
      code: codexToml
    }
  ];

  const curlSteps: Step[] = [
    {
      note: "Create a task:",
      code: `curl -X POST '${BOTNOTE_HOST}/v1/tasks' \\
  -H 'authorization: Bearer bn_...' \\
  -H 'content-type: application/json' \\
  -d '{
    "title": "Finish migration",
    "projectId": "<uuid>",
    "priority": "high"
  }'`
    },
    {
      note: "Create a note:",
      code: `curl -X POST '${BOTNOTE_HOST}/v1/notes' \\
  -H 'authorization: Bearer bn_...' \\
  -H 'content-type: application/json' \\
  -d '{ "body": "Quick capture", "pinned": false }'`
    },
    {
      note: "Hybrid search:",
      code: `curl -X POST '${BOTNOTE_HOST}/v1/search' \\
  -H 'authorization: Bearer bn_...' \\
  -H 'content-type: application/json' \\
  -d '{ "query": "deployment", "limit": 10 }'`
    }
  ];

  return (
    <>
      <SectionHeader
        title="MCP (raw integration)"
        blurb="Skip the Claude Code plugin and wire the MCP server in by hand — for Codex, custom agents, or any MCP-aware client. The botnote binary doubles as the MCP stdio server."
      />

      <CodeBlock title="Claude Code (~/.claude.json or project-local .mcp.json)" code={claudeJson} />
      <StepsCard title="Codex (~/.codex/config.toml)" steps={codexSteps} />
      <StepsCard title="REST · curl" steps={curlSteps} />

      <div className={cn(CARD, "px-4 py-3 text-xs leading-relaxed text-kumo-subtle")}>
        Raw MCP configuration requires the <code className="text-kumo-default">botnote</code> binary in
        <code className="text-kumo-default"> PATH</code>{" "}
        (<code className="text-kumo-default">npm i -g botnote</code>). The Claude Code and Codex plugins do not
        require a global CLI install; they run the matching npm package version automatically. The
        MCP server has no DB connection of its own; it speaks HTTP to whichever{" "}
        <code className="text-kumo-default">BOTNOTE_URL</code> you set.
      </div>
    </>
  );
}

// ----------------------------------------------------------------------------

function AboutSection() {
  const { data: health, isLoading } = useHealth();
  const versionLabel = health?.version ? `v${health.version}` : isLoading ? "loading..." : "unknown";

  return (
    <>
      <SectionHeader title="About" blurb="Build + runtime info for this daemon." />
      <div className={cn(CARD, "space-y-2 px-4 py-3 text-xs text-kumo-subtle")}>
        <div>
          <span className="text-kumo-default">botnote {versionLabel}</span> — Postgres 16 + pgvector + Fastify 5 +
          MCP SDK
        </div>
        <div>
          REST: <code className="text-kumo-default">{BOTNOTE_HOST}</code> · docs:{" "}
          <Link href="/docs" target="_blank" rel="noreferrer">
            /docs
          </Link>
        </div>
        <div className="border-t border-kumo-hairline pt-1">
          Auth is enforced when <code className="text-kumo-default">BOTNOTE_REQUIRE_AUTH=1</code> (or a{" "}
          <code>BOTNOTE_PASSWORD</code> is set) on the daemon. Every request then needs a bearer
          token or a browser session cookie, except direct connections from the daemon host itself
          (<code>BOTNOTE_TRUST_LOCALHOST=0</code> closes that too). Forwarded headers are honoured
          only from proxies listed in <code>BOTNOTE_TRUST_PROXY</code> (default: loopback).
        </div>
      </div>
    </>
  );
}

// ----------------------------------------------------------------------------

interface Step {
  note?: ReactNode;
  code?: string;
}

/** Card of prose steps interleaved with pure-command snippets. Copy buttons
 *  live on the snippets only, so copying never picks up explanatory text. */
function StepsCard({ title, steps }: { title: string; steps: Step[] }) {
  return (
    <div className={cn(CARD, "overflow-hidden")}>
      <CardHeader title={title} />
      <div className="space-y-3 px-3 py-3">
        {steps.map((s, i) => (
          <div key={i} className="space-y-1.5">
            {s.note && <p className="text-xs leading-relaxed text-kumo-subtle">{s.note}</p>}
            {s.code && <Snippet code={s.code} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function CopyButton({
  copied,
  onClick,
  className
}: {
  copied: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      shape="square"
      title={copied ? "Copied" : "Copy command"}
      icon={copied ? <CheckIcon size={13} weight="bold" /> : <CopyIcon size={13} />}
      className={cn(copied ? "text-kumo-success" : "text-kumo-subtle hover:text-kumo-default", className)}
      onClick={onClick}
    />
  );
}

function Snippet({ code }: { code: string }) {
  const [copied, copy] = useCopied();

  return (
    <div className="relative rounded-md border border-kumo-hairline bg-kumo-recessed">
      <pre className="overflow-x-auto px-3 py-2 pr-10 font-mono text-xs leading-relaxed whitespace-pre text-kumo-default scrollbar-thin">
        {code}
      </pre>
      <CopyButton copied={copied} onClick={() => copy(code)} className="absolute top-1 right-1" />
    </div>
  );
}

/** Cheat-sheet list: one command per row with its description as plain text
 *  and a per-row copy button that copies only the command. */
function CommandList({
  title,
  items
}: {
  title: string;
  items: { code: string; desc: string }[];
}) {
  return (
    <div className={cn(CARD, "overflow-hidden")}>
      <CardHeader title={title} />
      <ul className="divide-y divide-kumo-hairline">
        {items.map((it) => (
          <CommandRow key={it.code} code={it.code} desc={it.desc} />
        ))}
      </ul>
    </div>
  );
}

function CommandRow({ code, desc }: { code: string; desc: string }) {
  const [copied, copy] = useCopied();

  return (
    <li className="group flex items-center gap-3 py-1 pr-1.5 pl-3">
      <code className="overflow-x-auto font-mono text-xs whitespace-nowrap text-kumo-default scrollbar-thin">
        {code}
      </code>
      <span className="flex-1 truncate text-right text-xs text-kumo-subtle">{desc}</span>
      <CopyButton
        copied={copied}
        onClick={() => copy(code)}
        className={cn(
          !copied &&
            "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
        )}
      />
    </li>
  );
}

function CodeBlock({ title, code }: { title: string; code: string }) {
  const [copied, copy] = useCopied();

  return (
    <div className={cn(CARD, "overflow-hidden")}>
      <CardHeader title={title}>
        <Button
          variant="ghost"
          size="xs"
          icon={copied ? <CheckIcon size={11} weight="bold" /> : <CopyIcon size={11} />}
          className={cn("text-[11px]", copied ? "text-kumo-success" : "text-kumo-subtle")}
          onClick={() => copy(code)}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </CardHeader>
      <pre className="overflow-x-auto px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre text-kumo-default scrollbar-thin">
        {code}
      </pre>
    </div>
  );
}

// ----------------------------------------------------------------------------

function TokensSection() {
  const { data: tokens, isLoading } = useTokens();
  const create = useCreateToken();
  const revoke = useRevokeToken();
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<CreatedToken | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Single state for "which row just flashed Copied" — only one feedback at
  // a time, auto-clears after a brief moment.
  const [copiedId, setCopiedId] = useState<string | null>(null);

  function copyToken(t: { id: string; plaintext: string }) {
    navigator.clipboard.writeText(t.plaintext).then(() => {
      setCopiedId(t.id);
      setTimeout(() => setCopiedId((cur) => (cur === t.id ? null : cur)), 1400);
    });
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    const t = await create.mutateAsync(name.trim());
    setFresh(t);
    setName("");
  }

  async function onRevoke(id: string, tokenName: string) {
    if (deletingId) return;
    if (!confirm(`Revoke token "${tokenName}"? Any client using it stops working.`)) return;
    setDeletingId(id);
    setDeleteError(null);
    try {
      await revoke.mutateAsync(id);
      if (fresh?.id === id) setFresh(null);
    } catch (err) {
      setDeleteError(`Could not revoke "${tokenName}": ${errorText(err)}`);
    } finally {
      setDeletingId((cur) => (cur === id ? null : cur));
    }
  }

  return (
    <>
      <SectionHeader
        title="API tokens"
        blurb="Bearer tokens for the CLI, MCP server, and direct REST calls. A token acts as you: an agent using it sees what you see. The full value is shown once, when you create it; if you lose it, revoke the token and create a new one."
      />

      {fresh && (
        <Banner
          variant="alert"
          icon={<WarningIcon size={16} weight="fill" />}
          title="Copy this token now. It is not shown again."
          description={
            <div className="mt-1.5 flex items-center gap-2">
              <ClipboardText size="sm" text={fresh.plaintext} className="min-w-0 flex-1" />
              <Button size="sm" onClick={() => setFresh(null)}>
                Done
              </Button>
            </div>
          }
        />
      )}

      {deleteError && <Notice tone="error">{deleteError}</Notice>}

      <div className="space-y-1.5">
        <form onSubmit={onCreate} className="flex gap-2">
          <Input
            size="sm"
            aria-label="Token name"
            className="min-w-0 flex-1"
            placeholder="Who will use it? e.g. Claude Code @ MacBook"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button
            type="submit"
            variant="primary"
            size="sm"
            icon={<PlusIcon size={12} weight="bold" />}
            disabled={!name.trim() || create.isPending}
          >
            {create.isPending ? "Generating…" : "Generate"}
          </Button>
        </form>
        <p className="text-xxs text-kumo-placeholder">
          The name is shown as the author of everything written with this token, so name it after
          the agent and machine.
        </p>
      </div>

      <div className={cn(CARD, "divide-y divide-kumo-hairline overflow-hidden")}>
        {isLoading && (
          <div className="flex items-center gap-2 p-3 text-xs text-kumo-subtle">
            <Loader size={12} /> Loading…
          </div>
        )}
        {!isLoading && (!tokens || tokens.length === 0) && (
          <div className="p-4 text-center text-xs text-kumo-placeholder">No tokens yet.</div>
        )}
        {tokens?.map((t) => {
          const justCopied = copiedId === t.id;
          return (
            <div key={t.id} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-kumo-default">{t.name}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xxs text-kumo-subtle">
                  <code className="font-mono text-kumo-placeholder">{t.prefix}…</code>
                  <span>
                    created {formatDistanceToNow(new Date(t.createdAt), { addSuffix: true })}
                  </span>
                  <span>
                    {t.lastUsedAt
                      ? `used ${formatDistanceToNow(new Date(t.lastUsedAt), { addSuffix: true })}`
                      : "never used"}
                  </span>
                </div>
              </div>
              {t.plaintext ? (
                <Button
                  size="sm"
                  icon={justCopied ? <CheckIcon size={12} weight="bold" /> : <CopyIcon size={12} />}
                  className={cn("shrink-0", justCopied && "text-kumo-success!")}
                  onClick={() => copyToken({ id: t.id, plaintext: t.plaintext! })}
                >
                  {justCopied ? "Copied" : "Copy token"}
                </Button>
              ) : (
                <span
                  className="shrink-0"
                  title="The full token is shown only once, when it is created."
                >
                  <Badge variant="secondary" className="text-[11px]">
                    Shown once
                  </Badge>
                </span>
              )}
              <Button
                variant="ghost"
                size="sm"
                shape="square"
                icon={<TrashIcon size={14} />}
                title={deletingId === t.id ? "Revoking" : "Revoke"}
                loading={deletingId === t.id}
                disabled={deletingId !== null}
                className="shrink-0 text-kumo-subtle hover:text-kumo-danger"
                onClick={() => onRevoke(t.id, t.name)}
              />
            </div>
          );
        })}
      </div>
    </>
  );
}
