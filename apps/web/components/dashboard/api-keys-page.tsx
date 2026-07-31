"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  Copy,
  Info,
  KeyRound,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  X
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  dashButton,
  inputClass,
  Panel,
  PageShell,
  StatusPill
} from "@fishmem/dashboard/page-shell";
import {
  activateApiToken,
  createApiToken,
  deleteApiToken,
  fetchApiTokens,
  revokeApiToken,
  updateApiToken,
  type ApiToken
} from "@/lib/api";
import { useCurrentUser } from "@/hooks/use-user";
import { cn, formatDate } from "@/lib/utils";

function maskToken(token: string | undefined) {
  if (!token) return "fm_••••••••••••••••••••";
  if (token.length <= 12) return token;
  return `${token.slice(0, 8)}${"•".repeat(16)}${token.slice(-4)}`;
}

function displayMaskedToken(token: ApiToken) {
  if (token.token) return maskToken(token.token);
  return token.masked_token ?? "fm_••••••••••••••••••••";
}

export function ApiKeysPage() {
  const { jwt, workspaceId } = useCurrentUser();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [permissions, setPermissions] = useState<string[]>([
    "memory:read",
    "memory:write",
    "operations:read"
  ]);
  const [expiryDays, setExpiryDays] = useState("90");
  const [createdSecret, setCreatedSecret] = useState<{
    name: string;
    token: string;
  } | null>(null);
  const [confirmAction, setConfirmAction] = useState<
    { kind: "revoke" | "activate" | "delete"; token: ApiToken } | null
  >(null);
  const [renameTarget, setRenameTarget] = useState<ApiToken | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const tokens = useQuery({
    queryKey: ["api-tokens", jwt, workspaceId],
    queryFn: () => fetchApiTokens(jwt!, workspaceId),
    enabled: Boolean(jwt && workspaceId)
  });

  const create = useMutation({
    mutationFn: () =>
      createApiToken(jwt!, name.trim() || "FishMem API key", workspaceId, {
        permissions,
        expiresAt:
          expiryDays === "never"
            ? null
            : new Date(
                Date.now() + Number(expiryDays) * 86_400_000
              ).toISOString()
      }),
    onSuccess: (token) => {
      setCreatedSecret({
        name: token.name,
        token: token.token ?? ""
      });
      setName("");
      void queryClient.invalidateQueries({ queryKey: ["api-tokens"] });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Unable to create key")
  });

  const revoke = useMutation({
    mutationFn: (tokenId: string) => revokeApiToken(jwt!, tokenId, workspaceId),
    onSuccess: () => {
      toast.success("API key disabled");
      setConfirmAction(null);
      void queryClient.invalidateQueries({ queryKey: ["api-tokens"] });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Unable to disable key")
  });

  const activate = useMutation({
    mutationFn: (tokenId: string) => activateApiToken(jwt!, tokenId, workspaceId),
    onSuccess: () => {
      toast.success("API key activated");
      setConfirmAction(null);
      void queryClient.invalidateQueries({ queryKey: ["api-tokens"] });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Unable to enable key")
  });

  const remove = useMutation({
    mutationFn: (tokenId: string) => deleteApiToken(jwt!, tokenId, workspaceId),
    onSuccess: () => {
      toast.success("API key deleted");
      setConfirmAction(null);
      void queryClient.invalidateQueries({ queryKey: ["api-tokens"] });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Unable to delete key")
  });

  const rename = useMutation({
    mutationFn: (args: { tokenId: string; name: string }) =>
      updateApiToken(jwt!, args.tokenId, { name: args.name }, workspaceId),
    onSuccess: () => {
      toast.success("API key renamed");
      setRenameTarget(null);
      setRenameValue("");
      void queryClient.invalidateQueries({ queryKey: ["api-tokens"] });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Unable to rename")
  });

  const closeCreateDialog = () => {
    setCreateOpen(false);
    setCreatedSecret(null);
    setName("");
    setPermissions(["memory:read", "memory:write", "operations:read"]);
    setExpiryDays("90");
  };

  return (
    <PageShell
      title="API Keys"
      description="Create, rotate, and revoke bearer tokens for FishMem."
      actions={
        <button
          type="button"
          className={dashButton.primary}
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="h-4 w-4" />
          New key
        </button>
      }
    >
      <Panel
        title="Keys"
        description={
          tokens.data?.length
            ? `${tokens.data.length} key${tokens.data.length === 1 ? "" : "s"} in this account`
            : "No keys yet. Create one to start calling the API."
        }
        actions={null}
      >
        <div className="-mx-5 -my-5">
          <div className="hidden grid-cols-[1.2fr_0.7fr_1.4fr_0.9fr_0.9fr_auto] gap-4 border-b border-border bg-muted/40 px-6 py-3 text-[12px] font-medium text-muted-foreground md:grid">
            <span>Name</span>
            <span>Status</span>
            <span>Key</span>
            <span>Created</span>
            <span>Last used</span>
            <span className="w-8" />
          </div>
          {tokens.isLoading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading API keys…
            </div>
          ) : tokens.error ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <AlertTriangle className="h-8 w-8 text-destructive/60" />
              <p className="mt-3 text-sm text-destructive">
                Failed to load API keys.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Try again or check your network.
              </p>
            </div>
          ) : !tokens.data?.length ? (
            <div className="flex flex-col items-center justify-center py-14 text-center">
              <KeyRound className="h-8 w-8 text-muted-foreground" />
              <p className="mt-4 text-[1.15rem] font-medium leading-snug tracking-[-0.015em] text-foreground">
                No API keys yet
              </p>
              <p className="mt-2 max-w-sm text-[13px] text-muted-foreground">
                Create your first key, copy the secret once, and connect it from your backend service.
              </p>
              <button
                type="button"
                className={cn(dashButton.primary, "mt-5")}
                onClick={() => setCreateOpen(true)}
              >
                <Plus className="h-4 w-4" />
                New key
              </button>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {tokens.data.map((token) => (
                <TokenRow
                  key={token.documentId ?? String(token.id)}
                  token={token}
                  onAction={(action) => setConfirmAction({ kind: action, token })}
                  onRename={(target) => {
                    setRenameTarget(target);
                    setRenameValue(target.name);
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      </Panel>

      <div className="flex items-start gap-3 rounded-[4px] border border-warning/40 bg-warning/10 px-4 py-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <p className="text-[13px] leading-[1.5] text-foreground">
          API keys are sensitive. Treat them like passwords. Anyone with a key
          can read and modify project memories.
        </p>
      </div>

      {createOpen ? (
        <Modal onClose={closeCreateDialog}>
          {createdSecret ? (
            <CreatedSecretView
              name={createdSecret.name}
              token={createdSecret.token}
              onClose={closeCreateDialog}
            />
          ) : (
            <CreateForm
              name={name}
              onNameChange={setName}
              permissions={permissions}
              onPermissionsChange={setPermissions}
              expiryDays={expiryDays}
              onExpiryDaysChange={setExpiryDays}
              onCancel={closeCreateDialog}
              onCreate={() => create.mutate()}
              pending={create.isPending}
            />
          )}
        </Modal>
      ) : null}

      {confirmAction ? (
        <Modal onClose={() => setConfirmAction(null)}>
          <ConfirmDialog
            tokenName={confirmAction.token.name}
            kind={confirmAction.kind}
            onCancel={() => setConfirmAction(null)}
            pending={revoke.isPending || activate.isPending || remove.isPending}
            onConfirm={() => {
              const tokenId =
                confirmAction.token.documentId ??
                (typeof confirmAction.token.id === "string"
                  ? confirmAction.token.id
                  : "");
              if (!tokenId) return;
              if (confirmAction.kind === "revoke") {
                revoke.mutate(tokenId);
              } else if (confirmAction.kind === "activate") {
                activate.mutate(tokenId);
              } else {
                remove.mutate(tokenId);
              }
            }}
          />
        </Modal>
      ) : null}

      {renameTarget ? (
        <Modal
          onClose={() => {
            setRenameTarget(null);
            setRenameValue("");
          }}
        >
          <RenameDialog
            currentName={renameTarget.name}
            value={renameValue}
            onChange={setRenameValue}
            pending={rename.isPending}
            onCancel={() => {
              setRenameTarget(null);
              setRenameValue("");
            }}
            onConfirm={() => {
              const tokenId =
                renameTarget.documentId ??
                (typeof renameTarget.id === "string" ? renameTarget.id : "");
              if (!tokenId || !renameValue.trim()) return;
              rename.mutate({ tokenId, name: renameValue.trim() });
            }}
          />
        </Modal>
      ) : null}
    </PageShell>
  );
}

function TokenRow({
  token,
  onAction,
  onRename
}: {
  token: ApiToken;
  onAction: (kind: "revoke" | "activate" | "delete") => void;
  onRename: (token: ApiToken) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (event: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(event.target as Node)
      ) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  const copyMasked = async () => {
    const value = token.masked_token ?? maskToken(token.token);
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <li className="grid grid-cols-1 gap-3 px-6 py-4 md:grid-cols-[1.2fr_0.7fr_1.4fr_0.9fr_0.9fr_auto] md:items-center">
      <div className="min-w-0">
        <p className="truncate text-[14px] font-medium text-foreground">
          {token.name}
        </p>
        <p className="text-[11px] text-muted-foreground md:hidden">
          Created {formatDate(token.createdAt)}
        </p>
        <p className="mt-1 truncate text-[11px] text-muted-foreground">
          {token.permissions.join(", ")}
          {token.expires_at ? ` · expires ${formatDate(token.expires_at)}` : ""}
        </p>
      </div>
      <div>
        <StatusPill tone={token.status === "active" ? "success" : "neutral"}>
          {token.status === "active"
            ? "Active"
            : token.status === "expired"
              ? "Expired"
              : "Revoked"}
        </StatusPill>
      </div>
      <div className="flex items-center gap-2">
        <code className="marketing-mono min-w-0 flex-1 truncate rounded-[2px] bg-muted/40 px-2 py-1 text-[12px] text-muted-foreground">
          {displayMaskedToken(token)}
        </code>
        <button
          aria-label="Copy masked key"
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={copyMasked}
          type="button"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-success" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
      <div className="hidden text-[12px] text-muted-foreground md:block">
        {formatDate(token.createdAt)}
      </div>
      <div className="hidden text-[12px] text-muted-foreground md:block">
        {token.last_used_at ? formatDate(token.last_used_at) : "Never"}
      </div>
      <div className="relative justify-self-end" ref={menuRef}>
        <button
          aria-label="Actions"
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={() => setMenuOpen((v) => !v)}
          type="button"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
        {menuOpen ? (
          <div className="absolute right-0 top-9 z-10 w-40 rounded-md border border-border bg-background p-1 shadow-[0_12px_32px_rgba(24,24,21,0.10)]">
            <button
              className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-[13px] text-foreground hover:bg-muted"
              onClick={() => {
                setMenuOpen(false);
                onRename(token);
              }}
              type="button"
            >
              <Pencil className="h-3.5 w-3.5" />
              Rename
            </button>
            {token.status === "active" ? (
              <button
                className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-[13px] text-foreground hover:bg-muted"
                onClick={() => {
                  setMenuOpen(false);
                  onAction("revoke");
                }}
                type="button"
              >
                Disable
              </button>
            ) : token.status === "revoked" ? (
              <button
                className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-[13px] text-foreground hover:bg-muted"
                onClick={() => {
                  setMenuOpen(false);
                  onAction("activate");
                }}
                type="button"
              >
                Enable
              </button>
            ) : null}
            <button
              className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-[13px] text-destructive hover:bg-destructive/15"
              onClick={() => {
                setMenuOpen(false);
                onAction("delete");
              }}
              type="button"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </button>
          </div>
        ) : null}
      </div>
    </li>
  );
}

function Modal({
  children,
  onClose
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        aria-label="Close"
        className="absolute inset-0 bg-black/30"
        onClick={onClose}
        type="button"
      />
      <div className="relative w-full max-w-[440px] rounded-[4px] border border-border bg-background p-6 shadow-[0_24px_56px_rgba(24,24,21,0.16)]">
        <button
          aria-label="Close"
          className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
          onClick={onClose}
          type="button"
        >
          <X className="h-4 w-4" />
        </button>
        {children}
      </div>
    </div>
  );
}

function CreateForm({
  name,
  onNameChange,
  permissions,
  onPermissionsChange,
  expiryDays,
  onExpiryDaysChange,
  onCancel,
  onCreate,
  pending
}: {
  name: string;
  onNameChange: (value: string) => void;
  permissions: string[];
  onPermissionsChange: (value: string[]) => void;
  expiryDays: string;
  onExpiryDaysChange: (value: string) => void;
  onCancel: () => void;
  onCreate: () => void;
  pending: boolean;
}) {
  return (
    <div>
      <h3 className="text-[1.2rem] font-medium leading-snug tracking-[-0.015em] text-foreground">
        Create API key
      </h3>
      <p className="mt-2 text-[13px] text-muted-foreground">
        Pick a memorable name. The full secret will be shown once after
        creation.
      </p>
      <label
        className="mt-5 block text-[12px] font-medium text-muted-foreground"
        htmlFor="api-key-name"
      >
        Key Name
      </label>
      <input
        autoFocus
        className={cn("mt-1.5", inputClass)}
        id="api-key-name"
        onChange={(event) => onNameChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && name.trim()) {
            onCreate();
          }
        }}
        placeholder="e.g. Production server"
        value={name}
      />
      <fieldset className="mt-5">
        <legend className="text-[12px] font-medium text-muted-foreground">
          Permissions
        </legend>
        <div className="mt-2 grid gap-2">
          {[
            ["memory:read", "Read memories and sources"],
            ["memory:write", "Write memories and sources"],
            ["operations:read", "Read operations"]
          ].map(([permission, label]) => (
            <label
              className="flex items-center gap-2 text-[13px] text-foreground"
              key={permission}
            >
              <input
                checked={permissions.includes(permission)}
                onChange={(event) =>
                  onPermissionsChange(
                    event.target.checked
                      ? [...permissions, permission]
                      : permissions.filter((item) => item !== permission)
                  )
                }
                type="checkbox"
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <label
        className="mt-5 block text-[12px] font-medium text-muted-foreground"
        htmlFor="api-key-expiry"
      >
        Expires
      </label>
      <select
        className={cn("mt-1.5", inputClass)}
        id="api-key-expiry"
        onChange={(event) => onExpiryDaysChange(event.target.value)}
        value={expiryDays}
      >
        <option value="30">30 days</option>
        <option value="90">90 days</option>
        <option value="365">1 year</option>
        <option value="never">Never</option>
      </select>
      <div className="mt-6 flex items-center justify-end gap-2">
        <button className={dashButton.ghost} onClick={onCancel} type="button">
          Cancel
        </button>
        <button
          className={dashButton.primary}
          disabled={!name.trim() || permissions.length === 0 || pending}
          onClick={onCreate}
          type="button"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Create key
        </button>
      </div>
    </div>
  );
}

function CreatedSecretView({
  name,
  token,
  onClose
}: {
  name: string;
  token: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <h3 className="text-[1.2rem] font-medium leading-snug tracking-[-0.015em] text-foreground">
        Create API key
      </h3>

      <label className="mt-5 block text-[12px] font-medium text-muted-foreground">
        Key Name
      </label>
      <input className={cn("mt-1.5", inputClass)} readOnly value={name} />

      <div className="mt-4 flex items-center gap-3 rounded-xl bg-muted/40 px-3 py-2.5 ring-1 ring-foreground/10">
        <code className="marketing-mono min-w-0 flex-1 break-all text-[12.5px] text-foreground">
          {token}
        </code>
        <button
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          onClick={async () => {
            await navigator.clipboard.writeText(token);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          type="button"
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <div className="mt-4 flex items-center gap-2 rounded-xl bg-destructive/10 px-3.5 py-2.5">
        <Info className="h-4 w-4 shrink-0 text-destructive" />
        <p className="text-[13px] font-medium text-destructive">
          Copy it now, this key won&apos;t be shown again.
        </p>
      </div>

      <div className="mt-6 flex items-center justify-end">
        <button className={dashButton.outline} onClick={onClose} type="button">
          Close
        </button>
      </div>
    </div>
  );
}

function ConfirmDialog({
  tokenName,
  kind,
  onCancel,
  onConfirm,
  pending
}: {
  tokenName: string;
  kind: "revoke" | "activate" | "delete";
  onCancel: () => void;
  onConfirm: () => void;
  pending: boolean;
}) {
  const copy = {
    revoke: {
      title: "Disable API key",
      body: `Calls using "${tokenName}" will start failing immediately. You can re-enable it later.`,
      cta: "Disable key",
      style: dashButton.primary
    },
    activate: {
      title: "Enable API key",
      body: `Re-enable "${tokenName}" so it can make API calls again.`,
      cta: "Enable key",
      style: dashButton.primary
    },
    delete: {
      title: "Delete API key",
      body: `"${tokenName}" will be removed permanently. Any service using it will start failing.`,
      cta: "Delete key",
      style: dashButton.danger
    }
  }[kind];

  return (
    <div>
      <h3 className="text-[1.2rem] font-medium leading-snug tracking-[-0.015em] text-foreground">
        {copy.title}
      </h3>
      <p className="mt-2 text-[13px] leading-[1.55] text-muted-foreground">
        {copy.body}
      </p>
      <div className="mt-6 flex items-center justify-end gap-2">
        <button className={dashButton.ghost} onClick={onCancel} type="button">
          Cancel
        </button>
        <button
          className={copy.style}
          disabled={pending}
          onClick={onConfirm}
          type="button"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {copy.cta}
        </button>
      </div>
    </div>
  );
}

function RenameDialog({
  currentName,
  value,
  onChange,
  onCancel,
  onConfirm,
  pending
}: {
  currentName: string;
  value: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  pending: boolean;
}) {
  const trimmed = value.trim();
  const canSave = trimmed.length > 0 && trimmed !== currentName;

  return (
    <div>
      <h3 className="text-[1.2rem] font-medium leading-snug tracking-[-0.015em] text-foreground">
        Rename API key
      </h3>
      <p className="mt-2 text-[13px] text-muted-foreground">
        The secret stays the same. Only the display name changes.
      </p>
      <label
        className="mt-5 block text-[12px] font-medium text-muted-foreground"
        htmlFor="rename-input"
      >
        Name
      </label>
      <input
        autoFocus
        className={cn("mt-1.5", inputClass)}
        id="rename-input"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && canSave) {
            onConfirm();
          }
        }}
        value={value}
      />
      <div className="mt-6 flex items-center justify-end gap-2">
        <button className={dashButton.ghost} onClick={onCancel} type="button">
          Cancel
        </button>
        <button
          className={dashButton.primary}
          disabled={!canSave || pending}
          onClick={onConfirm}
          type="button"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Save
        </button>
      </div>
    </div>
  );
}
