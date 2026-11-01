import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useModals } from "../state/modals";

function isEditableTarget(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (t.isContentEditable) return true;
  if (t.closest(".cm-editor")) return true;
  return false;
}

export function useGlobalKeys() {
  const { open } = useModals();
  const navigate = useNavigate();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey;

      if (cmd && e.key.toLowerCase() === "k") {
        e.preventDefault();
        open({ kind: "search" });
        return;
      }

      if (isEditableTarget(e)) return;
      if (e.altKey || cmd) return;

      if (e.key === "c") {
        e.preventDefault();
        open({ kind: "quick-create" });
        return;
      }
      if (e.key === "n") {
        e.preventDefault();
        open({ kind: "new-project" });
        return;
      }
      if (e.key === "g") {
        // g-prefixed navigation: g d → Tasks, g t → Today, g i → Inbox,
        // g o → OKR, g w → Workspace.
        const handler = (ev: KeyboardEvent) => {
          window.removeEventListener("keydown", handler);
          if (isEditableTarget(ev)) return;
          const to: Record<string, string> = {
            d: "/",
            t: "/today",
            i: "/inbox",
            o: "/okr",
            w: "/dashboard"
          };
          const path = to[ev.key];
          if (path) {
            ev.preventDefault();
            navigate(path);
          }
        };
        window.addEventListener("keydown", handler, { once: true });
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, navigate]);
}
