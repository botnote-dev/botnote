import { Button } from "@cloudflare/kumo/components/button";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { useSidebar } from "@cloudflare/kumo/components/sidebar";
import {
  DesktopIcon,
  ListIcon,
  MagnifyingGlassIcon,
  MoonIcon,
  PlusIcon,
  SidebarSimpleIcon,
  SignOutIcon,
  SunIcon,
  type Icon
} from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useColorMode } from "../hooks/useColorMode";
import { COLOR_MODES, type ColorMode } from "../lib/colorMode";
import { useModals } from "../state/modals";
import { BrandLink } from "./BrandLink";

const COLOR_MODE_OPTIONS: Record<ColorMode, { label: string; icon: Icon }> = {
  light: { label: "Light", icon: SunIcon },
  dark: { label: "Dark", icon: MoonIcon },
  system: { label: "System", icon: DesktopIcon }
};

export function TopBar() {
  const { open } = useModals();
  const navigate = useNavigate();
  const { isMobile, open: sidebarOpen, toggleSidebar } = useSidebar();
  const mod = typeof navigator !== "undefined" && navigator.platform.includes("Mac") ? "⌘" : "Ctrl";

  async function onLogout() {
    try {
      await api.logout();
    } catch {
      // ignore; either way send the user to /login
    }
    navigate("/login", { replace: true });
  }

  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-kumo-line bg-kumo-base px-3">
      <div className="flex min-w-0 items-center gap-2">
        {isMobile ? (
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            icon={<ListIcon size={18} />}
            aria-label="Open navigation"
            onClick={toggleSidebar}
          />
        ) : (
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            icon={<SidebarSimpleIcon size={18} />}
            title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
            className="text-kumo-subtle"
            onClick={toggleSidebar}
          />
        )}
        {(isMobile || !sidebarOpen) && <BrandLink />}
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          icon={<MagnifyingGlassIcon size={14} className="text-kumo-subtle" />}
          className="md:min-w-[220px]"
          onClick={() => open({ kind: "search" })}
        >
          <span className="sr-only sm:not-sr-only sm:flex-1 sm:text-left sm:text-kumo-subtle">
            Search…
          </span>
          <kbd className="hidden md:inline-flex">{mod}K</kbd>
        </Button>
        <Button
          variant="primary"
          size="sm"
          icon={<PlusIcon size={14} weight="bold" />}
          onClick={() => open({ kind: "quick-create" })}
        >
          <span className="sr-only sm:not-sr-only">New</span>
        </Button>
        <ColorModeMenu />
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          icon={<SignOutIcon size={16} />}
          title="Log out"
          className="text-kumo-subtle hover:text-kumo-danger"
          onClick={onLogout}
        />
      </div>
    </header>
  );
}

function ColorModeMenu() {
  const [mode, setMode] = useColorMode();
  const CurrentIcon = COLOR_MODE_OPTIONS[mode].icon;
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            icon={<CurrentIcon size={16} />}
            aria-label={`Theme: ${COLOR_MODE_OPTIONS[mode].label}`}
            className="text-kumo-subtle"
          />
        }
      />
      <DropdownMenu.Content align="end" className="w-36">
        <DropdownMenu.RadioGroup value={mode} onValueChange={(v) => setMode(v as ColorMode)}>
          {COLOR_MODES.map((m) => {
            const { label, icon: ModeIcon } = COLOR_MODE_OPTIONS[m];
            return (
              <DropdownMenu.RadioItem key={m} value={m} className="gap-2">
                <ModeIcon size={14} className="text-kumo-subtle" />
                {label}
                <DropdownMenu.RadioItemIndicator />
              </DropdownMenu.RadioItem>
            );
          })}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}
