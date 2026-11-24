import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { UserPlusIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, type InviteInfo } from "../api/client";

const PASSWORD_MIN_LENGTH = 8;

function failureText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("rate_limited") || msg.includes("429")) {
    return "Too many attempts. Wait a minute and try again.";
  }
  if (msg.includes("email_mismatch")) return "This invite was made for a different email address.";
  if (msg.includes("email_taken")) return "That email already has an account here. Sign in instead.";
  if (msg.includes("invalid_invite")) return "This invite link is not valid any more. Ask for a new one.";
  if (msg.includes("400")) return "Check the email address and use a password of at least 8 characters.";
  return "Could not reach the server.";
}

export function InvitePage() {
  const { token = "" } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [invite, setInvite] = useState<InviteInfo | null | "invalid">(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .lookupInvite(token)
      .then((info) => {
        if (cancelled) return;
        setInvite(info);
        if (info.email) setEmail(info.email);
      })
      .catch(() => {
        if (!cancelled) setInvite("invalid");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const ready = email.trim() !== "" && password.length >= PASSWORD_MIN_LENGTH;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.acceptInvite({
        token,
        email: email.trim(),
        password,
        ...(name.trim() ? { name: name.trim() } : {})
      });
      navigate("/", { replace: true });
    } catch (err) {
      setError(failureText(err));
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-kumo-canvas px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm bg-kumo-base border border-kumo-line rounded-lg shadow-xs p-6 space-y-5"
      >
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-md bg-kumo-brand flex items-center justify-center text-white text-sm font-bold">
            b
          </div>
          <div>
            <div className="text-sm font-semibold text-kumo-default leading-tight">botnote</div>
            <div className="text-xxs text-kumo-subtle">Join with an invite</div>
          </div>
        </div>

        {invite === null && <p className="text-xs text-kumo-subtle">Loading…</p>}

        {invite === "invalid" && (
          <p role="alert" className="text-xs text-kumo-danger">
            This invite link is not valid any more. Ask the person who sent it for a new one.
          </p>
        )}

        {invite && invite !== "invalid" && (
          <>
            <p className="text-xs leading-relaxed text-kumo-subtle">
              {invite.invitedBy ? `${invite.invitedBy} invited you` : "You were invited"} to this
              botnote. You will see the projects people share here. Projects you create are private
              until you share them.
            </p>
            <Input
              label="Email"
              type="email"
              autoFocus={!invite.email}
              autoComplete="email"
              className="w-full"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy || Boolean(invite.email)}
            />
            <Input
              label="Password"
              type="password"
              autoFocus={Boolean(invite.email)}
              autoComplete="new-password"
              description="At least 8 characters."
              className="w-full"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
            <Input
              label="Name (optional)"
              autoComplete="name"
              description="How others see you. Defaults to the part of your email before @."
              className="w-full"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
            />
            {error && (
              <div
                role="alert"
                className="text-xs text-kumo-danger bg-kumo-danger-tint border border-kumo-danger/30 rounded-md px-2.5 py-1.5"
              >
                {error}
              </div>
            )}
            <Button
              type="submit"
              variant="primary"
              className="w-full"
              loading={busy}
              icon={<UserPlusIcon size={14} />}
              disabled={!ready || busy}
            >
              Join
            </Button>
          </>
        )}
      </form>
    </div>
  );
}
