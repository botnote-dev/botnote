import { useEffect } from "react";
import { useModals } from "../state/modals";

/**
 * The one global shortcut: Cmd/Ctrl+K opens search. There are no bare-letter
 * shortcuts on purpose; a stray keystroke outside a field must never open a
 * dialog or leave the page.
 */
export function useGlobalKeys() {
  const { open } = useModals();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey;

      if (cmd && e.key.toLowerCase() === "k") {
        e.preventDefault();
        open({ kind: "search" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
}
