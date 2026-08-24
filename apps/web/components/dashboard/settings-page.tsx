"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Loader2, Monitor, Moon, Plus, Sun, Trash2 } from "lucide-react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { BackupSection } from "@/components/dashboard/backup-section";
import { ConfirmDialog } from "@fishmem/dashboard/confirm-dialog";
import { dashButton } from "@fishmem/dashboard/page-shell";
import { Select } from "@fishmem/dashboard/select";
import { useCurrentUser } from "@/hooks/use-user";
import {
  apiFetch,
  deleteProject,
  fetchInvites,
  fetchProjectSettings,
  inviteMember,
  type MemberRole,
  revokeInvite,
  setInviteRole,
  updateProject,
  updateProjectSettings,
} from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

type Section =
  | "general"
  | "instructions"
  | "backup"
  | "members"
  | "profile";
const BASE_TABS: Array<{ id: Section; label: string }> = [
  { id: "general", label: "General" },
  { id: "instructions", label: "Instructions" },
  { id: "backup", label: "Backup" },
  { id: "members", label: "Members" },
  { id: "profile", label: "Profile" },
];

const inputClass =
  "h-9 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";
const disabledInputClass =
  "h-9 w-full rounded-lg border border-border bg-muted px-3 text-[13px] text-muted-foreground";

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label className="mb-1.5 block text-[13px] font-medium text-foreground">
      {children}
    </label>
  );
}

function DangerZone({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-8">
      <p className="mb-3 text-[13px] font-medium text-destructive">Danger zone</p>
      <div className="flex items-center justify-between gap-4 rounded-xl px-4 py-3.5 ring-1 ring-destructive/30">
        {children}
      </div>
    </div>
  );
}

export function SettingsPage() {
  const router = useRouter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { jwt, projects, refetch, setWorkspaceId, user, workspaceId, workspace } =
    useCurrentUser();
  const tabs = BASE_TABS;
  const [active, setActive] = useState<Section>("general");
  const [name, setName] = useState("");
  const [projectName, setProjectName] = useState("");
  const [projectDesc, setProjectDesc] = useState("");
  const [instructions, setInstructions] = useState("");
  const [theme, setTheme] = useState<"system" | "light" | "dark">("system");
  const [delProjectOpen, setDelProjectOpen] = useState(false);
  const [delAccountOpen, setDelAccountOpen] = useState(false);

  const settings = useQuery({
    queryKey: ["project-settings", jwt, workspaceId],
    queryFn: () => fetchProjectSettings(jwt!, workspaceId),
    enabled: Boolean(jwt && workspaceId),
  });

  useEffect(() => setName(user?.name ?? user?.username ?? ""), [user?.name, user?.username]);
  useEffect(() => setProjectName(workspace?.name ?? ""), [workspace?.name]);
  useEffect(() => setProjectDesc(workspace?.description ?? ""), [workspace?.description]);
  useEffect(() => {
    if (settings.data) setInstructions(settings.data.instructions);
  }, [settings.data]);
  useEffect(() => {
    // Match the boot script (layout.tsx), which also honors the legacy key —
    // otherwise a theme stored under "seedance-theme" would wrongly show System.
    const stored =
      localStorage.getItem("fishmem-theme") ||
      localStorage.getItem("seedance-theme");
    setTheme(stored === "light" || stored === "dark" ? stored : "system");
    const hash = window.location.hash.replace("#", "");
    if (BASE_TABS.some((t) => t.id === hash)) setActive(hash as Section);
  }, []);

  const applyTheme = (value: "system" | "light" | "dark") => {
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

  const saveProfile = useMutation({
    mutationFn: () =>
      apiFetch("/api/users/me", { method: "PUT", jwt, body: JSON.stringify({ name }) }),
    onSuccess: () => {
      toast.success("Profile updated");
      void refetch();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Save failed"),
  });

  const saveProject = useMutation({
    mutationFn: () =>
      updateProject(jwt!, workspaceId!, {
        name: projectName.trim(),
        description: projectDesc,
      }),
    onSuccess: () => {
      toast.success("Project updated");
      void queryClient.invalidateQueries({ queryKey: ["current-user"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Save failed"),
  });

  const saveInstructions = useMutation({
    mutationFn: () => updateProjectSettings(jwt!, { instructions }, workspaceId),
    onSuccess: (data) => {
      setInstructions(data.instructions);
      toast.success("Instructions saved");
      void queryClient.invalidateQueries({ queryKey: ["project-settings"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Save failed"),
  });

  const delProject = useMutation({
    mutationFn: () => deleteProject(jwt!, workspaceId!),
    onSuccess: () => {
      const next = projects.find((p) => p.documentId !== workspaceId);
      if (next) setWorkspaceId(next.documentId);
      setDelProjectOpen(false);
      toast.success("Project deleted");
      void queryClient.invalidateQueries({ queryKey: ["current-user"] });
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Could not delete project"),
  });

  const delAccount = useMutation({
    mutationFn: async () => {
      const res = await authClient.deleteUser({});
      if (res.error) throw new Error(res.error.message ?? "Could not delete account");
    },
    onSuccess: () => {
      toast.success("Account deleted");
      void navigate({ to: "/login" });
      void router.invalidate();
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Could not delete account"),
  });

  return (
    <div className="mx-auto w-full max-w-[946px]">
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        Settings
      </h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        Configure project behavior, members, and your profile.
      </p>

      <nav aria-label="Settings sections" className="mt-8 border-b border-border">
        <div className="flex gap-6 overflow-x-auto">
          {tabs.map((t) => (
            <button
              className={cn(
                "h-10 shrink-0 border-b-2 text-[13px] font-medium transition-colors",
                active === t.id
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
              key={t.id}
              onClick={() => {
                setActive(t.id);
                window.history.replaceState(null, "", `#${t.id}`);
              }}
              type="button"
            >
              {t.label}
            </button>
          ))}
        </div>
      </nav>

      <div className="mt-7">
        {active === "general" ? (
          <section>
            <div className="max-w-md space-y-4">
              <div>
                <Label>Project name</Label>
                <input
                  className={inputClass}
                  onChange={(e) => setProjectName(e.target.value)}
                  value={projectName}
                />
              </div>
              <div>
                <Label>Project description</Label>
                <textarea
                  className={cn(inputClass, "h-auto min-h-[80px] py-2 leading-relaxed")}
                  onChange={(e) => setProjectDesc(e.target.value)}
                  placeholder="What this project is for (optional)."
                  value={projectDesc}
                />
              </div>
              <button
                className={dashButton.primary}
                disabled={saveProject.isPending || !projectName.trim()}
                onClick={() => saveProject.mutate()}
                type="button"
              >
                {saveProject.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}
                Save
              </button>
            </div>

            <DangerZone>
              <div>
                <p className="text-[13px] font-medium text-foreground">Delete project</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Permanently delete this project and all its memories, requests,
                  and keys. If it&apos;s your last project, a fresh empty one is
                  created.
                </p>
              </div>
              <button
                className={dashButton.danger}
                onClick={() => setDelProjectOpen(true)}
                type="button"
              >
                Delete project
              </button>
            </DangerZone>
          </section>
        ) : null}

        {active === "instructions" ? (
          <section className="max-w-2xl space-y-3">
            <div>
              <p className="text-[13px] font-medium text-foreground">
                Memory instructions
              </p>
              <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                Guidance the engine follows when deciding what to store and how
                to categorize it for this project.
              </p>
            </div>
            <textarea
              className={cn(inputClass, "h-auto min-h-[180px] py-2.5 leading-relaxed")}
              onChange={(e) => setInstructions(e.target.value)}
              value={instructions}
            />
            <button
              className={dashButton.primary}
              disabled={saveInstructions.isPending}
              onClick={() => saveInstructions.mutate()}
              type="button"
            >
              {saveInstructions.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              Save instructions
            </button>
          </section>
        ) : null}

        {active === "backup" ? (
          <BackupSection projectName={workspace?.name ?? ""} />
        ) : null}

        {active === "members" ? <MembersSection /> : null}

        {active === "profile" ? (
          <section>
            <div className="max-w-md space-y-4">
              <div>
                <Label>Name</Label>
                <input
                  className={inputClass}
                  onChange={(e) => setName(e.target.value)}
                  value={name}
                />
              </div>
              <div>
                <Label>Email</Label>
                <input className={disabledInputClass} disabled value={user?.email ?? ""} />
              </div>
              <button
                className={dashButton.primary}
                disabled={saveProfile.isPending}
                onClick={() => saveProfile.mutate()}
                type="button"
              >
                {saveProfile.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}
                Save
              </button>

              <div className="pt-2">
                <Label>Theme</Label>
                <div className="inline-flex rounded-lg bg-muted p-[3px]">
                  {[
                    { value: "system", label: "System", icon: Monitor },
                    { value: "light", label: "Light", icon: Sun },
                    { value: "dark", label: "Dark", icon: Moon },
                  ].map((opt) => {
                    const Icon = opt.icon;
                    return (
                      <button
                        className={cn(
                          "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-colors",
                          theme === opt.value
                            ? "bg-background text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                        key={opt.value}
                        onClick={() => applyTheme(opt.value as "system" | "light" | "dark")}
                        type="button"
                      >
                        <Icon className="h-3.5 w-3.5" />
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <DangerZone>
              <div>
                <p className="text-[13px] font-medium text-foreground">Delete account</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Permanently delete your account and every project, memory, and key
                  you own. This cannot be undone.
                </p>
              </div>
              <button
                className={dashButton.danger}
                onClick={() => setDelAccountOpen(true)}
                type="button"
              >
                Delete account
              </button>
            </DangerZone>
          </section>
        ) : null}
      </div>

      <ConfirmDialog
        confirmLabel="Delete project"
        confirmText={workspace?.name}
        description={
          <>
            This permanently deletes{" "}
            <span className="font-medium text-foreground">{workspace?.name}</span>{" "}
            and all of its memories, requests, and API keys. This cannot be undone.
          </>
        }
        destructive
        loading={delProject.isPending}
        onClose={() => setDelProjectOpen(false)}
        onConfirm={() => delProject.mutate()}
        open={delProjectOpen}
        title="Delete project"
      />

      <ConfirmDialog
        confirmLabel="Delete account"
        confirmText={user?.email}
        description="This permanently deletes your account and every project, memory, and API key you own. This cannot be undone."
        destructive
        loading={delAccount.isPending}
        onClose={() => setDelAccountOpen(false)}
        onConfirm={() => delAccount.mutate()}
        open={delAccountOpen}
        title="Delete account"
      />
    </div>
  );
}

function MemberAvatar({ str }: { str?: string | null }) {
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
      {(str ?? "U").slice(0, 1).toUpperCase()}
    </span>
  );
}

function MembersSection() {
  const { jwt, user } = useCurrentUser();
  const queryClient = useQueryClient();
  const isAdmin = user?.role === "admin";
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MemberRole>("member");

  const invites = useQuery({
    queryKey: ["invites", jwt],
    queryFn: () => fetchInvites(jwt!),
    enabled: Boolean(jwt) && isAdmin,
  });
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["invites"] });

  const add = useMutation({
    mutationFn: () => inviteMember(jwt!, email.trim(), role),
    onSuccess: (row) => {
      setEmail("");
      if (row.link) void navigator.clipboard?.writeText(row.link).catch(() => {});
      toast.success("Invite created — link copied");
      void invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Invite failed"),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => revokeInvite(jwt!, id),
    onSuccess: () => {
      toast.success("Invite revoked");
      void invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Revoke failed"),
  });
  const changeRole = useMutation({
    mutationFn: (v: { id: string; role: MemberRole }) =>
      setInviteRole(jwt!, v.id, v.role),
    onSuccess: () => void invalidate(),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Update failed"),
  });

  if (!isAdmin) {
    return (
      <p className="max-w-2xl text-[13px] text-muted-foreground">
        Only an admin can manage members.
      </p>
    );
  }

  const rows = invites.data ?? [];

  return (
    <section className="max-w-2xl space-y-4">
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        Invite teammates to this FishMem instance. They register with the invited
        email; the invite link is copied here (and emailed if a provider is
        configured).
      </p>

      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (email.trim()) add.mutate();
        }}
      >
        <input
          className={cn(inputClass, "min-w-0 flex-1")}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="teammate@company.com"
          type="email"
          value={email}
        />
        <Select<MemberRole>
          onChange={setRole}
          options={[
            { value: "member", label: "Member" },
            { value: "admin", label: "Admin" },
          ]}
          value={role}
        />
        <button
          className={dashButton.primary}
          disabled={add.isPending || !email.trim()}
          type="submit"
        >
          {add.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          Invite
        </button>
      </form>

      <div className="overflow-hidden rounded-xl ring-1 ring-foreground/10">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <MemberAvatar str={user?.name ?? user?.email} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium text-foreground">
              {user?.name?.trim() || user?.email}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {user?.email}
            </p>
          </div>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            Owner
          </span>
        </div>

        {invites.isLoading ? (
          <div className="px-4 py-6 text-center text-muted-foreground">
            <Loader2 className="mx-auto h-4 w-4 animate-spin" />
          </div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-6 text-center text-[13px] text-muted-foreground">
            No invites yet.
          </div>
        ) : (
          rows.map((inv) => (
            <div
              className="flex items-center gap-2 border-b border-border px-4 py-3 last:border-b-0"
              key={inv.id}
            >
              <MemberAvatar str={inv.email ?? "?"} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-foreground">
                  {inv.email ?? "(any email)"}
                </p>
                <p className="text-xs capitalize text-muted-foreground">
                  {inv.status}
                </p>
              </div>
              {inv.status === "pending" ? (
                <Select<MemberRole>
                  align="right"
                  onChange={(role) => changeRole.mutate({ id: inv.id, role })}
                  options={[
                    { value: "member", label: "Member" },
                    { value: "admin", label: "Admin" },
                  ]}
                  size="sm"
                  value={inv.role as MemberRole}
                />
              ) : (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium capitalize text-muted-foreground">
                  {inv.role}
                </span>
              )}
              {inv.status === "pending" ? (
                <>
                  {inv.token ? (
                    <button
                      aria-label="Copy invite link"
                      className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      onClick={() => {
                        void navigator.clipboard?.writeText(
                          `${window.location.origin}/invite/${inv.token}`,
                        );
                        toast.success("Invite link copied");
                      }}
                      type="button"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                  <button
                    aria-label="Revoke invite"
                    className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => revoke.mutate(inv.id)}
                    type="button"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </>
              ) : null}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
