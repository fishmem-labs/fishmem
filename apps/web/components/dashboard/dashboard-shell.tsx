"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Brain,
  Check,
  ChevronsUpDown,
  FlaskConical,
  Folder,
  FolderPlus,
  Files,
  House,
  KeyRound,
  ListChecks,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Plus,
  Settings,
  SlidersHorizontal,
  Sun,
  UsersRound,
  Webhook,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  useLocation,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { BrandMark } from "@/components/site/brand-logo";
import { useClickOutside } from "@/hooks/use-click-outside";
import { useCurrentUser } from "@/hooks/use-user";
import { CreateProjectDialog } from "@/components/dashboard/create-project-dialog";
import { createProject } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { BRAND_SHORT_NAME } from "@/lib/config";
import { cn } from "@/lib/utils";

type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
};

type NavSection = {
  label: string;
  items: NavItem[];
};

const navSections: NavSection[] = [
  {
    label: "",
    items: [
      { label: "Home", href: "/dashboard", icon: House },
      { label: "Playground", href: "/dashboard/playground", icon: FlaskConical },
      { label: "Requests", href: "/dashboard/requests", icon: Activity },
      { label: "Entities", href: "/dashboard/entities", icon: UsersRound },
      { label: "Memories", href: "/dashboard/memories", icon: Brain },
      { label: "Sources", href: "/dashboard/sources", icon: Files },
      { label: "Operations", href: "/dashboard/operations", icon: ListChecks },
      { label: "API Keys", href: "/dashboard/api-keys", icon: KeyRound },
      { label: "Webhooks", href: "/dashboard/webhooks", icon: Webhook },
      { label: "Install", href: "/dashboard/create-api", icon: FolderPlus },
    ],
  },
  {
    label: "Manage",
    items: [{ label: "Settings", href: "/dashboard/settings", icon: Settings }],
  },
];

/** Instance-level engine config — admin-only, appended to the Manage group. */
const ADMIN_NAV: NavItem = {
  label: "Configuration",
  href: "/dashboard/configuration",
  icon: SlidersHorizontal,
};

function isItemActive(pathname: string, href: string) {
  if (href === "/dashboard") {
    return pathname === "/dashboard";
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

function SidebarLink({
  item,
  onNavigate,
}: {
  item: NavItem;
  onNavigate: () => void;
}) {
  const pathname = useLocation().pathname;
  const active = isItemActive(pathname, item.href);
  const Icon = item.icon;

  return (
    <a
      className={cn(
        "flex h-8 items-center gap-2 rounded-md px-2.5 text-sm font-medium transition-colors",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      )}
      href={item.href}
      onClick={onNavigate}
    >
      <Icon className="h-4 w-4 shrink-0 text-current" />
      <span>{item.label}</span>
    </a>
  );
}

function SidebarBody({ onNavigate }: { onNavigate: () => void }) {
  const { user } = useCurrentUser();
  const isAdmin = user?.role === "admin";
  const sections = navSections.map((section) =>
    section.label === "Manage" && isAdmin
      ? { ...section, items: [...section.items, ADMIN_NAV] }
      : section,
  );
  return (
    <div className="flex flex-col gap-5 px-2 py-3">
      {sections.map((section) => (
        <div key={section.label}>
          {section.label ? (
            <p className="px-2.5 pb-1.5 pt-1 text-xs font-medium text-muted-foreground">
              {section.label}
            </p>
          ) : null}
          <div className="flex flex-col gap-0.5">
            {section.items.map((item) => (
              <SidebarLink
                item={item}
                key={item.href}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The diagonal divider between the brand mark and the project name. */
function SlashDivider() {
  return (
    <svg
      aria-hidden="true"
      className="shrink-0 text-border"
      fill="none"
      height="20"
      viewBox="0 0 6 21"
      width="6"
    >
      <line
        stroke="currentColor"
        strokeLinecap="round"
        x1="5.36"
        x2="0.61"
        y1="0.61"
        y2="19.64"
      />
    </svg>
  );
}

type Theme = "system" | "light" | "dark";

function ThemeRow() {
  // Mounts fresh each time the account menu opens, so it always reflects the
  // current theme (and stays in sync with the Profile selector via localStorage).
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => {
    const stored =
      localStorage.getItem("fishmem-theme") ||
      localStorage.getItem("seedance-theme");
    setTheme(stored === "light" || stored === "dark" ? stored : "system");
  }, []);

  const apply = (value: Theme) => {
    if (value === "system") {
      localStorage.removeItem("fishmem-theme");
      localStorage.removeItem("seedance-theme");
      const sysDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      document.documentElement.classList.toggle("dark", sysDark);
      document.documentElement.style.colorScheme = sysDark ? "dark" : "light";
    } else {
      localStorage.setItem("fishmem-theme", value);
      document.documentElement.classList.toggle("dark", value === "dark");
      document.documentElement.style.colorScheme = value;
    }
    setTheme(value);
  };

  return (
    <div className="flex rounded-md bg-muted p-0.5">
      {[
        { icon: Monitor, label: "System", value: "system" as const },
        { icon: Sun, label: "Light", value: "light" as const },
        { icon: Moon, label: "Dark", value: "dark" as const },
      ].map((item) => {
        const Icon = item.icon;
        const active = theme === item.value;
        return (
          <button
            aria-label={`${item.label} theme`}
            aria-pressed={active}
            className={cn(
              "flex h-6 w-7 items-center justify-center rounded-[5px] transition-colors",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:bg-background hover:text-foreground",
            )}
            key={item.value}
            onClick={() => apply(item.value)}
            type="button"
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        );
      })}
    </div>
  );
}

/**
 * Consolidated workspace + account menu (trigger.dev-style). OSS build: the
 * header shows "Open source" instead of a billing plan, and there is no
 * Switch/Create organization (those are Cloud-only). Projects map to the user's
 * workspaces.
 */
function WorkspaceSwitcher() {
  const queryClient = useQueryClient();
  const { jwt, projects, setWorkspaceId, workspace } = useCurrentUser();
  const [open, setOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false), open);

  const create = useMutation({
    mutationFn: (value: { name: string; description: string }) =>
      createProject(jwt!, value.name || "Untitled project", value.description),
    onSuccess: (project) => {
      setWorkspaceId(project.documentId);
      setDialogOpen(false);
      toast.success("Project created");
      void queryClient.invalidateQueries({ queryKey: ["current-user"] });
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : "Unable to create project",
      ),
  });

  return (
    <div className="relative" ref={ref}>
      <button
        className="flex h-9 w-full items-center gap-1.5 rounded-md pl-1.5 pr-1 text-left transition-colors hover:bg-sidebar-accent"
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <BrandMark className="h-5 w-5 shrink-0 rounded-xs" />
        <SlashDivider />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground">
          {workspace?.name ?? "Select project"}
        </span>
        <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>

      {open ? (
        <div className="absolute left-0 right-0 top-11 z-40 overflow-hidden rounded-lg bg-popover text-sm text-popover-foreground shadow-[0_18px_46px_rgba(0,0,0,0.16)] ring-1 ring-foreground/10">
          {/* Projects */}
          <div className="flex flex-col gap-0.5 p-1">
            {projects.map((project) => (
              <button
                className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left transition-colors hover:bg-accent"
                key={project.documentId}
                onClick={() => {
                  setWorkspaceId(project.documentId);
                  setOpen(false);
                }}
                type="button"
              >
                <Folder className="h-4 w-4 shrink-0 text-brand" />
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {project.name}
                </span>
                {project.documentId === workspace?.documentId ? (
                  <Check className="h-4 w-4 shrink-0 text-foreground" />
                ) : null}
              </button>
            ))}

            <button
              className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-foreground transition-colors hover:bg-accent"
              onClick={() => {
                setOpen(false);
                setDialogOpen(true);
              }}
              type="button"
            >
              <Plus className="h-4 w-4 shrink-0 text-muted-foreground" />
              New project
            </button>
          </div>
        </div>
      ) : null}

      <CreateProjectDialog
        loading={create.isPending}
        onClose={() => setDialogOpen(false)}
        onCreate={(value) => create.mutate(value)}
        open={dialogOpen}
      />
    </div>
  );
}

function Avatar({ name, email }: { name: string; email: string }) {
  const initial = (name || email || "U").slice(0, 1).toUpperCase();
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
      {initial}
    </span>
  );
}

/** Pinned account control at the foot of the sidebar (cloud-style): the signed-in
 * user, opening a menu with profile, theme, and logout. */
function SidebarAccount() {
  const router = useRouter();
  const navigate = useNavigate();
  const { user } = useCurrentUser();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false), open);

  const email = user?.email ?? "";
  const displayName = user?.name?.trim() || email.split("@")[0] || "You";

  return (
    <div className="relative border-t border-sidebar-border p-2" ref={ref}>
      <button
        className="flex w-full items-center gap-2 rounded-md p-1.5 text-left transition-colors hover:bg-sidebar-accent"
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <Avatar email={email} name={displayName} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-sidebar-foreground">
            {displayName}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {email}
          </span>
        </span>
        <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>

      {open ? (
        <div className="absolute bottom-[calc(100%-0.25rem)] left-2 right-2 z-40 overflow-hidden rounded-lg bg-popover text-[13px] text-popover-foreground shadow-[0_18px_46px_rgba(0,0,0,0.16)] ring-1 ring-foreground/10">
          <div className="p-1">
            <a
              className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-foreground transition-colors hover:bg-accent"
              href="/dashboard/settings#profile"
              onClick={() => setOpen(false)}
            >
              <Settings className="h-4 w-4 shrink-0 text-muted-foreground" />
              Account settings
            </a>
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-1.5">
            <span className="text-xs text-muted-foreground">Theme</span>
            <ThemeRow />
          </div>
          <div className="border-t border-border p-1">
            <button
              className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              onClick={() =>
                authClient.signOut({
                  fetchOptions: {
                    onSuccess: () => {
                      void navigate({ to: "/" });
                      void router.invalidate();
                    },
                  },
                })
              }
              type="button"
            >
              <LogOut className="h-4 w-4 shrink-0" />
              Logout
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = useLocation().pathname;
  // The Playground is a full-bleed app canvas — no page padding, fills height.
  const fullBleed = pathname === "/dashboard/playground";

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <aside className="hidden h-screen w-[260px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex">
        <div className="px-2 pb-2 pt-3">
          <WorkspaceSwitcher />
        </div>
        <div className="dashboard-scrollbar flex-1 overflow-y-auto">
          <SidebarBody onNavigate={() => {}} />
        </div>
        <SidebarAccount />
      </aside>

      {mobileOpen ? (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            aria-label="Close menu"
            className="absolute inset-0 bg-black/40"
            onClick={() => setMobileOpen(false)}
            type="button"
          />
          <aside className="relative flex h-full w-[270px] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
            <div className="px-2 pb-2 pt-3">
              <WorkspaceSwitcher />
            </div>
            <div className="dashboard-scrollbar flex-1 overflow-y-auto">
              <SidebarBody onNavigate={() => setMobileOpen(false)} />
            </div>
            <SidebarAccount />
          </aside>
        </div>
      ) : null}

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="sticky top-0 z-20 flex items-center gap-3 border-b border-border bg-background px-4 py-3 md:hidden">
          <button
            aria-label="Open menu"
            className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-card text-foreground"
            onClick={() => setMobileOpen(true)}
            type="button"
          >
            {mobileOpen ? (
              <X className="h-4 w-4" />
            ) : (
              <Menu className="h-4 w-4" />
            )}
          </button>
          <a
            className="flex items-center gap-2 text-sm font-medium text-foreground"
            href="/dashboard"
          >
            <BrandMark className="h-5 w-5 rounded-xs" />
            <span>{BRAND_SHORT_NAME}</span>
          </a>
          <a
            aria-label="Homepage"
            className="ml-auto flex h-8 w-8 items-center justify-center rounded-md border border-border bg-card text-muted-foreground"
            href="/"
          >
            <House className="h-4 w-4" />
          </a>
        </div>
        <div
          className={
            fullBleed
              ? "h-[calc(100vh_-_3.5rem)] md:h-full"
              : "px-5 py-6 md:px-12 md:py-8 lg:px-14"
          }
        >
          {children}
        </div>
      </main>
    </div>
  );
}
