"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Copy,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  Trash2,
  Webhook,
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
  createWebhook,
  deleteWebhook,
  fetchWebhookDeliveries,
  fetchWebhooks,
  rotateWebhookSecret,
  testWebhook,
  updateWebhook,
  type WebhookEndpoint,
  type WebhookEndpointWithSecret,
  type WebhookEventType
} from "@/lib/api";
import { useCurrentUser } from "@/hooks/use-user";
import { cn, formatDate } from "@/lib/utils";

const DEFAULT_WEBHOOK_EVENTS: WebhookEventType[] = [
  "memory_add",
  "memory_update",
  "memory_delete",
  "document_ingest",
  "document_delete"
];

/** Subscribable events grouped by category for the create/edit form. */
const EVENT_CATALOG: Array<{
  category: string;
  description: string;
  events: Array<{ value: WebhookEventType; label: string }>;
}> = [
  {
    category: "Memory",
    description: "Fires when memories are added, updated, or deleted.",
    events: [
      { value: "memory_add", label: "memory_add" },
      { value: "memory_update", label: "memory_update" },
      { value: "memory_delete", label: "memory_delete" }
    ]
  },
  {
    category: "Sources",
    description: "Fires when extraction is queued, a source is indexed, or it is permanently deleted.",
    events: [
      { value: "document_extract_queued", label: "document_extract_queued" },
      { value: "document_ingest", label: "document_ingest" },
      { value: "document_delete", label: "document_delete" }
    ]
  }
];

export function WebhooksPage() {
  const { jwt, workspaceId } = useCurrentUser();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [createdSecret, setCreatedSecret] =
    useState<WebhookEndpointWithSecret | null>(null);

  const webhooks = useQuery({
    queryKey: ["webhooks", jwt, workspaceId],
    queryFn: () => fetchWebhooks(jwt!, workspaceId),
    enabled: Boolean(jwt && workspaceId)
  });

  const create = useMutation({
    mutationFn: (data: {
      url: string;
      description?: string;
      events: WebhookEventType[];
    }) =>
      createWebhook(jwt!, {
        ...data,
        workspace: workspaceId ?? undefined,
        enabled: true
      }),
    onSuccess: (data) => {
      setCreatedSecret(data);
      void queryClient.invalidateQueries({ queryKey: ["webhooks"] });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Create failed")
  });

  const closeCreate = () => {
    setCreateOpen(false);
    setCreatedSecret(null);
  };

  return (
    <PageShell
      title="Webhooks"
      description="Receive signed HTTPS callbacks for project events."
      actions={
        <button
          className={dashButton.primary}
          onClick={() => setCreateOpen(true)}
          type="button"
        >
          <Plus className="h-4 w-4" />
          New endpoint
        </button>
      }
    >
      <Panel
        title="Endpoints"
        description={
          webhooks.data?.length
            ? `${webhooks.data.length} endpoint${webhooks.data.length === 1 ? "" : "s"} configured`
            : "Send signed project updates to your servers."
        }
      >
        <div className="-mx-5 -my-5">
          {webhooks.isLoading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading webhooks…
            </div>
          ) : !webhooks.data?.length ? (
            <div className="flex flex-col items-center justify-center py-14 text-center">
              <Webhook className="h-8 w-8 text-muted-foreground" />
              <p className="mt-4 text-[1.15rem] font-medium leading-snug tracking-[-0.015em] text-foreground">
                No webhook endpoints yet
              </p>
              <p className="mt-2 max-w-sm text-[13px] text-muted-foreground">
                Create one to receive signed project updates on your server.
              </p>
              <button
                className={cn(dashButton.primary, "mt-5")}
                onClick={() => setCreateOpen(true)}
                type="button"
              >
                <Plus className="h-4 w-4" />
                New endpoint
              </button>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {webhooks.data.map((webhook) => (
                <WebhookRow
                  key={webhook.documentId}
                  webhook={webhook}
                  jwt={jwt!}
                  workspaceId={workspaceId ?? undefined}
                />
              ))}
            </ul>
          )}
        </div>
      </Panel>

      {createOpen ? (
        <Modal onClose={closeCreate}>
          {createdSecret ? (
            <CreatedSecretView
              secret={createdSecret.secret}
              url={createdSecret.url}
              onClose={closeCreate}
            />
          ) : (
            <WebhookForm
              title="New webhook endpoint"
              description="We'll POST signed project updates to this URL."
              submitLabel="Create webhook"
              pending={create.isPending}
              onCancel={closeCreate}
              onSubmit={(data) => create.mutate(data)}
            />
          )}
        </Modal>
      ) : null}
    </PageShell>
  );
}

function WebhookRow({
  webhook,
  jwt,
  workspaceId
}: {
  webhook: WebhookEndpoint;
  jwt: string;
  workspaceId: string | undefined;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [rotatedSecret, setRotatedSecret] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  const deliveries = useQuery({
    queryKey: ["webhook-deliveries", webhook.documentId, workspaceId],
    queryFn: () =>
      fetchWebhookDeliveries(jwt, webhook.documentId, workspaceId),
    enabled: open
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      updateWebhook(jwt, webhook.documentId, { enabled }, workspaceId),
    onSuccess: () => {
      toast.success(webhook.enabled ? "Webhook disabled" : "Webhook enabled");
      void queryClient.invalidateQueries({ queryKey: ["webhooks"] });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Update failed")
  });

  const rotate = useMutation({
    mutationFn: () => rotateWebhookSecret(jwt, webhook.documentId, workspaceId),
    onSuccess: (data) => {
      setRotatedSecret(data.secret);
      toast.success("Secret rotated. Copy the new value.");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Rotate failed")
  });

  const test = useMutation({
    mutationFn: () => testWebhook(jwt, webhook.documentId, workspaceId),
    onSuccess: (data) => {
      if (data.success) {
        toast.success(`Test delivered · ${data.httpStatus ?? 200}`);
      } else {
        toast.error(
          data.error ?? `Test failed${data.httpStatus ? ` · ${data.httpStatus}` : ""}`
        );
      }
      void deliveries.refetch();
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Test failed")
  });

  const remove = useMutation({
    mutationFn: () => deleteWebhook(jwt, webhook.documentId, workspaceId),
    onSuccess: () => {
      toast.success("Webhook deleted");
      void queryClient.invalidateQueries({ queryKey: ["webhooks"] });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Delete failed")
  });

  const update = useMutation({
    mutationFn: (data: {
      url: string;
      description?: string;
      events: WebhookEventType[];
    }) => updateWebhook(jwt, webhook.documentId, data, workspaceId),
    onSuccess: () => {
      toast.success("Webhook updated");
      setEditOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["webhooks"] });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Update failed")
  });

  return (
    <li>
      <button
        className="flex w-full items-center gap-4 px-6 py-4 text-left transition-colors hover:bg-muted/40"
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180"
          )}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium text-foreground">
            {webhook.url}
          </p>
          <p className="truncate text-[12px] text-muted-foreground">
            {webhook.description || "Signed delivery endpoint"}
          </p>
          <p className="mt-1 truncate text-[11px] text-muted-foreground">
            {webhook.events.join(" · ")}
          </p>
        </div>
        <StatusPill tone={webhook.enabled ? "success" : "neutral"}>
          {webhook.enabled ? "Active" : "Disabled"}
        </StatusPill>
        <div className="relative" ref={menuRef}>
          <button
            aria-label="Actions"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            type="button"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {menuOpen ? (
            <div
              className="absolute right-0 top-9 z-10 w-44 rounded-md border border-border bg-background p-1 shadow-[0_12px_32px_rgba(24,24,21,0.10)]"
              onClick={(event) => event.stopPropagation()}
            >
              <button
                className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-[13px] text-foreground hover:bg-muted"
                onClick={() => {
                  setMenuOpen(false);
                  setEditOpen(true);
                }}
                type="button"
              >
                <Pencil className="h-3.5 w-3.5" />
                Edit
              </button>
              <button
                className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-[13px] text-foreground hover:bg-muted"
                onClick={() => {
                  setMenuOpen(false);
                  test.mutate();
                }}
                type="button"
              >
                <Send className="h-3.5 w-3.5" />
                Send test
              </button>
              <button
                className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-[13px] text-foreground hover:bg-muted"
                onClick={() => {
                  setMenuOpen(false);
                  toggle.mutate(!webhook.enabled);
                }}
                type="button"
              >
                {webhook.enabled ? "Disable" : "Enable"}
              </button>
              <button
                className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-[13px] text-foreground hover:bg-muted"
                onClick={() => {
                  setMenuOpen(false);
                  rotate.mutate();
                }}
                type="button"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Rotate secret
              </button>
              <button
                className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-[13px] text-destructive hover:bg-destructive/15"
                onClick={() => {
                  setMenuOpen(false);
                  setConfirmDelete(true);
                }}
                type="button"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </button>
            </div>
          ) : null}
        </div>
      </button>
      {open ? (
        <div className="border-t border-border bg-muted/40 px-6 py-4">
          <h4 className="text-[12px] font-medium text-muted-foreground">
            Recent deliveries
          </h4>
          {deliveries.isLoading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading…
            </div>
          ) : !deliveries.data?.length ? (
            <p className="py-6 text-center text-[13px] text-muted-foreground">
              No deliveries yet. Try sending a test.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-border">
              {deliveries.data.slice(0, 8).map((delivery) => (
                <li
                  className="flex items-center justify-between gap-3 py-2 text-[13px]"
                  key={delivery.documentId}
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground">
                      Delivery attempt
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {formatDate(delivery.createdAt)}
                      {delivery.taskId ? ` · ${delivery.taskId}` : ""} ·
                      attempts {delivery.attempts}
                    </p>
                  </div>
                  <StatusPill
                    tone={
                      delivery.status === "success"
                        ? "success"
                        : delivery.status === "failed"
                          ? "danger"
                          : "info"
                    }
                  >
                    {delivery.httpStatus ?? delivery.status}
                  </StatusPill>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-[12px] text-muted-foreground">
            Created {formatDate(webhook.createdAt)}
          </p>
        </div>
      ) : null}

      {editOpen ? (
        <Modal onClose={() => setEditOpen(false)}>
          <WebhookForm
            title="Edit webhook endpoint"
            description="Update the URL or internal description for this endpoint."
            submitLabel="Save changes"
            initial={{
              url: webhook.url,
              description: webhook.description,
              events: webhook.events
            }}
            pending={update.isPending}
            onCancel={() => setEditOpen(false)}
            onSubmit={(data) => update.mutate(data)}
          />
        </Modal>
      ) : null}

      {rotatedSecret ? (
        <Modal onClose={() => setRotatedSecret(null)}>
          <SecretReveal
            label="Signing secret rotated"
            value={rotatedSecret}
            onClose={() => setRotatedSecret(null)}
          />
        </Modal>
      ) : null}

      {confirmDelete ? (
        <Modal onClose={() => setConfirmDelete(false)}>
          <div>
            <h3 className="text-[1.2rem] font-medium leading-snug tracking-[-0.015em] text-foreground">
              Delete webhook
            </h3>
            <p className="mt-2 text-[13px] leading-[1.55] text-muted-foreground">
              {webhook.url} will stop receiving callbacks immediately.
            </p>
            <div className="mt-6 flex items-center justify-end gap-2">
              <button
                className={dashButton.ghost}
                onClick={() => setConfirmDelete(false)}
                type="button"
              >
                Cancel
              </button>
              <button
                className={dashButton.danger}
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
                type="button"
              >
                {remove.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}
                Delete
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
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
      <div className="relative w-full max-w-[480px] rounded-[4px] border border-border bg-background p-6 shadow-[0_24px_56px_rgba(24,24,21,0.16)]">
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

function WebhookForm({
  title,
  description,
  submitLabel,
  initial,
  pending,
  onCancel,
  onSubmit
}: {
  title: string;
  description: string;
  submitLabel: string;
  initial?: {
    url?: string;
    description?: string;
    events?: WebhookEventType[];
  };
  pending: boolean;
  onCancel: () => void;
  onSubmit: (data: {
    url: string;
    description?: string;
    events: WebhookEventType[];
  }) => void;
}) {
  const [url, setUrl] = useState(initial?.url ?? "");
  const [descValue, setDescValue] = useState(initial?.description ?? "");
  const [events, setEvents] = useState<WebhookEventType[]>(
    initial?.events ?? DEFAULT_WEBHOOK_EVENTS
  );
  const valid = url.startsWith("https://") && events.length > 0;

  const toggle = (value: WebhookEventType) =>
    setEvents((prev) =>
      prev.includes(value)
        ? prev.filter((e) => e !== value)
        : [...prev, value]
    );


  return (
    <div>
      <h3 className="text-[1.2rem] font-medium leading-snug tracking-[-0.015em] text-foreground">
        {title}
      </h3>
      <p className="mt-2 text-[13px] text-muted-foreground">{description}</p>
      <label className="mt-5 block text-[12px] font-medium text-muted-foreground">
        Endpoint URL
      </label>
      <input
        autoFocus
        className={cn("mt-1.5", inputClass)}
        onChange={(event) => setUrl(event.target.value)}
        placeholder="https://api.example.com/webhooks/fishmem"
        value={url}
      />
      <label className="mt-4 block text-[12px] font-medium text-muted-foreground">
        Description (optional)
      </label>
      <input
        className={cn("mt-1.5", inputClass)}
        onChange={(event) => setDescValue(event.target.value)}
        placeholder="Production memory events"
        value={descValue}
      />

      <p className="mt-5 text-[12px] font-medium text-muted-foreground">Events</p>
      <div className="mt-2 space-y-3 rounded-xl border border-border p-3">
        {EVENT_CATALOG.map((group) => (
          <div key={group.category}>
            <div className="mb-1.5">
              <p className="text-[13px] font-medium text-foreground">
                {group.category}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {group.description}
              </p>
            </div>
            <div className="grid gap-1 sm:grid-cols-2">
              {group.events.map((e) => (
                <label
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted"
                  key={e.value}
                >
                  <input
                    checked={events.includes(e.value)}
                    className="h-3.5 w-3.5 accent-brand"
                    onChange={() => toggle(e.value)}
                    type="checkbox"
                  />
                  <span className="font-mono text-[12px] text-foreground">
                    {e.label}
                  </span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6 flex items-center justify-end gap-2">
        <button className={dashButton.ghost} onClick={onCancel} type="button">
          Cancel
        </button>
        <button
          className={dashButton.primary}
          disabled={!valid || pending}
          onClick={() =>
            onSubmit({
              url,
              description: descValue || undefined,
              events
            })
          }
          type="button"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

function CreatedSecretView({
  secret,
  url,
  onClose
}: {
  secret: string;
  url: string;
  onClose: () => void;
}) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-success" />
        <h3 className="text-[1.2rem] font-medium leading-snug tracking-[-0.015em] text-foreground">
          Webhook created
        </h3>
      </div>
      <p className="mt-2 text-[13px] text-muted-foreground">
        Save this signing secret. It&apos;s used to verify the FishMem signature
        header on requests to{" "}
        <code className="marketing-mono text-[12px] text-foreground">{url}</code>.
      </p>
      <SecretReveal label="Signing secret" value={secret} onClose={onClose} />
    </div>
  );
}

function SecretReveal({
  label,
  value,
  onClose
}: {
  label: string;
  value: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div>
      <p className="text-[12px] font-medium text-muted-foreground">
        {label}
      </p>
      <div className="mt-2 flex items-center gap-2">
        <code className="marketing-mono min-w-0 flex-1 break-all rounded-[2px] bg-muted/40 px-3 py-2 text-[12px] text-foreground">
          {value}
        </code>
        <button
          aria-label="Copy"
          className="flex h-9 w-9 items-center justify-center rounded-[2px] border border-border text-foreground hover:bg-muted"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          type="button"
        >
          {copied ? (
            <Check className="h-4 w-4 text-success" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </button>
      </div>
      <div className="mt-4 flex items-start gap-2 rounded-[2px] border border-warning/40 bg-warning/10 px-3 py-2.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <p className="text-[12px] leading-[1.5] text-warning">
          We won&apos;t show this secret again. Rotate it from the menu if it
          leaks.
        </p>
      </div>
      <div className="mt-6 flex items-center justify-end gap-2">
        <button className={dashButton.primary} onClick={onClose} type="button">
          Done
        </button>
      </div>
    </div>
  );
}
