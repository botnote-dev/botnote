import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { SignInIcon, UserPlusIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, type AuthStatus } from "../api/client";

const PASSWORD_MIN_LENGTH = 8;

type Mode = "loading" | "setup" | "email" | "password" | "offline";

function modeFor(status: AuthStatus): Mode {
  if (status.login === "email") return "email";
  // An instance with no account offers setup first. One that still runs on
  // its instance password can also sign in the old way.
  return "setup";
}

function failureText(err: unknown, mode: Mode): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("rate_limited") || msg.includes("429")) {
    return "Too many attempts. Wait a minute and try again.";
  }
  if (msg.includes("invalid_setup_code")) return "That is not this instance's password.";
  if (msg.includes("setup_done")) return "This instance already has an owner. Reload to sign in.";
  if (msg.includes("400")) return "Check the email address and use a password of at least 8 characters.";
  if (msg.includes("401")) {
    return mode === "password" ? "Wrong password." : "Wrong email or password.";
  }
  return "Could not reach the server.";
}

export function LoginPage() {
  const [mode, setMode] = useState<Mode>("loading");
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [setupCode, setSetupCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get("next") || "/";

  useEffect(() => {
    let cancelled = false;
    api
      .authStatus()
      .then((s) => {
        if (cancelled) return;
        setStatus(s);
        setMode(modeFor(s));
      })
      .catch(() => {
        if (!cancelled) setMode("offline");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setup = mode === "setup";
  const ready =
    mode === "setup"
      ? email.trim() !== "" &&
        password.length >= PASSWORD_MIN_LENGTH &&
        (!status?.setupCodeRequired || setupCode !== "")
      : mode === "email"
        ? email.trim() !== "" && password !== ""
        : mode === "password"
          ? password !== ""
          : false;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "setup") {
        await api.setup({
          ...(name.trim() ? { name: name.trim() } : {}),
          email: email.trim(),
          password,
          setupCode: status?.setupCodeRequired ? setupCode : undefined
        });
      } else if (mode === "email") {
        await api.login({ email: email.trim(), password });
      } else {
        await api.login({ password });
      }
      // Replace so the back button doesn't go to /login.
      navigate(next, { replace: true });
    } catch (err) {
      setError(failureText(err, mode));
      setBusy(false);
    }
  }

  function switchMode(to: Mode) {
    setMode(to);
    setPassword("");
    setError(null);
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
            <div className="text-xxs text-kumo-subtle">
              {setup ? "Create the owner account" : "Sign in to continue"}
            </div>
          </div>
        </div>

        {mode === "loading" && <p className="text-xs text-kumo-subtle">Loading…</p>}

        {mode === "offline" && (
          <p role="alert" className="text-xs text-kumo-danger">
            Could not reach the server. Reload to try again.
          </p>
        )}

        {setup && (
          <>
            <p className="text-xs leading-relaxed text-kumo-subtle">
              This instance has no account yet. The first account owns it and can invite others
              later.
            </p>
          </>
        )}

        {(setup || mode === "email") && (
          <Input
            label="Email"
            type="email"
            autoFocus={setup || mode === "email"}
            autoComplete={setup ? "email" : "username"}
            className="w-full"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
          />
        )}

        {(setup || mode === "email" || mode === "password") && (
          <Input
            label={mode === "password" ? "Instance password" : "Password"}
            type="password"
            autoFocus={mode === "password"}
            autoComplete={setup ? "new-password" : "current-password"}
            description={setup ? "At least 8 characters." : undefined}
            className="w-full"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
        )}

        {setup && (
          <Input
            label="Name (optional)"
            autoComplete="name"
            description="How others see you. Defaults to the part of your email before @."
            className="w-full"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
        )}

        {setup && status?.setupCodeRequired && (
          <Input
            label="Instance password"
            type="password"
            autoComplete="off"
            description="The BOTNOTE_PASSWORD this instance was started with. It proves the instance is yours and is not used again."
            className="w-full"
            value={setupCode}
            onChange={(e) => setSetupCode(e.target.value)}
            disabled={busy}
          />
        )}

        {error && (
          <div
            role="alert"
            className="text-xs text-kumo-danger bg-kumo-danger-tint border border-kumo-danger/30 rounded-md px-2.5 py-1.5"
          >
            {error}
          </div>
        )}

        {(setup || mode === "email" || mode === "password") && (
          <Button
            type="submit"
            variant="primary"
            className="w-full"
            loading={busy}
            icon={setup ? <UserPlusIcon size={14} /> : <SignInIcon size={14} />}
            disabled={!ready || busy}
          >
            {setup ? "Create account" : "Sign in"}
          </Button>
        )}

        {setup && status?.login === "password" && (
          <button
            type="button"
            className="block w-full text-center text-xxs text-kumo-subtle underline"
            onClick={() => switchMode("password")}
          >
            Sign in with the instance password instead
          </button>
        )}
        {mode === "password" && (
          <button
            type="button"
            className="block w-full text-center text-xxs text-kumo-subtle underline"
            onClick={() => switchMode("setup")}
          >
            Create the owner account
          </button>
        )}

        {(mode === "email" || mode === "password") && (
          <p className="text-xxs text-kumo-subtle text-center pt-1">
            You stay signed in on this browser for 30 days. Agents use API tokens.
          </p>
        )}
      </form>
    </div>
  );
}
