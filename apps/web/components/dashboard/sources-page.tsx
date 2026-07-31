"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Copy,
  FileText,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@fishmem/dashboard/confirm-dialog";
import {
  dashButton,
  PageShell,
  StatusPill,
} from "@fishmem/dashboard/page-shell";
import { useCurrentUser } from "@/hooks/use-user";
import {
  deleteDocument,
  deleteDocumentUpload,
  fetchAllDocuments,
  fetchDocumentContent,
  fetchDocumentUploads,
  ingestDocument,
  searchDocuments,
  type DocumentRow,
  type DocumentSearchHit,
  type SourceAssetRow,
  uploadDocumentFile,
} from "@/lib/documents-api";
import { retryOperation } from "@/lib/api";
import { cn } from "@/lib/utils";

const MAX_SOURCE_BYTES = 1_000_000;
const MAX_UPLOAD_BYTES = 25_000_000;
const SOURCE_FILE_ACCEPT =
  ".txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.xml,.yaml,.yml,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.odt,.ods,.odp,.rtf,.epub,.eml,.png,.jpg,.jpeg,.tif,.tiff,.bmp,.webp,text/*,application/json,application/pdf,image/*";
type SourceSubmitResult =
  | Awaited<ReturnType<typeof ingestDocument>>
  | Awaited<ReturnType<typeof uploadDocumentFile>>;

function formatBytes(value: number) {
  if (value < 1_000) return `${value} B`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)} KB`;
  return `${(value / 1_000_000).toFixed(1)} MB`;
}

function relativeTime(iso: string) {
  const seconds = Math.max(
    0,
    Math.round((Date.now() - new Date(iso).getTime()) / 1_000),
  );
  if (seconds < 60) return "just now";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function scopeLabel(document: DocumentRow) {
  if (document.user_id) return `user · ${document.user_id}`;
  if (document.agent_id) return `agent · ${document.agent_id}`;
  if (document.run_id) return `run · ${document.run_id}`;
  return "project";
}

export function SourcesPage() {
  const { jwt, workspaceId } = useCurrentUser();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<DocumentRow | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<DocumentRow | null>(null);
  const [pendingUploadDelete, setPendingUploadDelete] =
    useState<SourceAssetRow | null>(null);
  const searching = Boolean(query.trim());

  const sources = useQuery({
    queryKey: ["sources", jwt, workspaceId, searching ? `q:${query}` : "list"],
    queryFn: async () =>
      searching
        ? {
            documents: [],
            hits: await searchDocuments(jwt!, {
              workspace: workspaceId,
              query,
              limit: 20,
              neighbors: 1,
            }),
            uploads: [],
          }
        : await Promise.all([
            fetchAllDocuments(jwt!, { workspace: workspaceId }),
            fetchDocumentUploads(jwt!, workspaceId),
          ]).then(([documents, uploads]) => ({
            documents,
            hits: [],
            uploads,
          })),
    enabled: Boolean(jwt && workspaceId),
    refetchInterval: searching ? false : 5_000,
  });

  const remove = useMutation({
    mutationFn: (document: DocumentRow) =>
      deleteDocument(jwt ?? "", document.id, workspaceId),
    onSuccess: (result) => {
      setPendingDelete(null);
      if (selected?.id === result.id) setSelected(null);
      toast.success(
        `Source deleted (${result.versions} version${
          result.versions === 1 ? "" : "s"
        })`,
      );
      void queryClient.invalidateQueries({ queryKey: ["sources"] });
      void queryClient.invalidateQueries({ queryKey: ["operations-console"] });
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : "Could not delete source",
      ),
  });
  const removeUpload = useMutation({
    mutationFn: (upload: SourceAssetRow) =>
      deleteDocumentUpload(jwt ?? "", upload.id, workspaceId),
    onSuccess: () => {
      setPendingUploadDelete(null);
      toast.success("Upload and retained artifacts deleted");
      void queryClient.invalidateQueries({ queryKey: ["sources"] });
      void queryClient.invalidateQueries({ queryKey: ["operations-console"] });
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : "Could not delete upload",
      ),
  });
  const retryUpload = useMutation({
    mutationFn: (upload: SourceAssetRow) =>
      retryOperation(jwt ?? "", upload.operation_id, workspaceId),
    onSuccess: () => {
      toast.success("Document extraction queued for retry");
      void queryClient.invalidateQueries({ queryKey: ["sources"] });
      void queryClient.invalidateQueries({ queryKey: ["operations-console"] });
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : "Could not retry extraction",
      ),
  });

  const documents = sources.data?.documents ?? [];
  const hits = sources.data?.hits ?? [];
  const activeUploads = (sources.data?.uploads ?? []).filter(
    (upload) => upload.status !== "ready",
  );
  const currentCount = searching
    ? new Set(hits.map((hit) => hit.document.id)).size
    : documents.length;

  return (
    <PageShell
      title="Sources"
      actions={
        <div className="flex items-center gap-2">
          <button
            className={dashButton.secondary}
            disabled={sources.isFetching}
            onClick={() => sources.refetch()}
            type="button"
          >
            {sources.isFetching ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Refresh
          </button>
          <button
            className={dashButton.primary}
            onClick={() => setUploadOpen(true)}
            type="button"
          >
            <Upload className="h-4 w-4" />
            Add source
          </button>
        </div>
      }
      contentClassName="space-y-5"
    >
      <p className="max-w-3xl text-sm text-muted-foreground">
        Exact file originals remain immutable; extracted or pasted UTF-8
        content forms the RAG corpus. Search returns deterministic chunks with
        byte offsets and adjacent evidence.
      </p>

      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(search.trim());
          setSelected(null);
        }}
      >
        <div className="relative min-w-[240px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            className="h-9 w-full rounded-lg border border-input bg-background pl-8 pr-9 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search source evidence…"
            value={search}
          />
          {search ? (
            <button
              aria-label="Clear source search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => {
                setSearch("");
                setQuery("");
                setSelected(null);
              }}
              type="button"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>
        <button className={dashButton.secondary} type="submit">
          Search
        </button>
      </form>

      <div className="flex items-center justify-between border-b border-border pb-2 text-xs text-muted-foreground">
        <span>
          {searching
            ? `${hits.length} evidence hit${hits.length === 1 ? "" : "s"} across ${currentCount} source${currentCount === 1 ? "" : "s"}`
            : `${currentCount} current source${currentCount === 1 ? "" : "s"}`}
        </span>
        <span>Originals are not memory records</span>
      </div>

      {activeUploads.length ? (
        <SourceUploadStatusList
          deleting={removeUpload.isPending}
          onDelete={setPendingUploadDelete}
          onRetry={(upload) => retryUpload.mutate(upload)}
          retrying={retryUpload.isPending}
          uploads={activeUploads}
        />
      ) : null}

      <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
        {searching ? (
          <SearchResults
            hits={hits}
            loading={sources.isLoading}
            onDelete={setPendingDelete}
            onOpen={setSelected}
            selectedId={selected?.id}
          />
        ) : (
          <SourceList
            documents={documents}
            loading={sources.isLoading}
            onDelete={setPendingDelete}
            onOpen={setSelected}
            selectedId={selected?.id}
          />
        )}
      </div>

      <SourceDrawer
        document={selected}
        jwt={jwt}
        onClose={() => setSelected(null)}
        workspaceId={workspaceId}
      />

      <SourceIngestDialog
        jwt={jwt}
        onClose={() => setUploadOpen(false)}
        onCreated={(document) => {
          setUploadOpen(false);
          setSelected(document);
          setQuery("");
          setSearch("");
          void queryClient.invalidateQueries({ queryKey: ["sources"] });
          void queryClient.invalidateQueries({
            queryKey: ["operations-console"],
          });
        }}
        onQueued={() => {
          setUploadOpen(false);
          setQuery("");
          setSearch("");
          void queryClient.invalidateQueries({ queryKey: ["sources"] });
          void queryClient.invalidateQueries({
            queryKey: ["operations-console"],
          });
        }}
        open={uploadOpen}
        workspaceId={workspaceId}
      />

      <ConfirmDialog
        confirmLabel="Delete source"
        description="This permanently deletes the source, every immutable version, and all retrieval chunks. This cannot be undone."
        destructive
        loading={remove.isPending}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) remove.mutate(pendingDelete);
        }}
        open={Boolean(pendingDelete)}
        title="Delete source and versions"
      />
      <ConfirmDialog
        confirmLabel="Delete upload"
        description="This permanently cancels the queued extraction and deletes its exact original plus any retained extraction artifacts. An actively processing upload cannot be removed."
        destructive
        loading={removeUpload.isPending}
        onClose={() => setPendingUploadDelete(null)}
        onConfirm={() => {
          if (pendingUploadDelete) removeUpload.mutate(pendingUploadDelete);
        }}
        open={Boolean(pendingUploadDelete)}
        title="Delete file upload"
      />
    </PageShell>
  );
}

function SourceUploadStatusList({
  uploads,
  deleting,
  retrying,
  onDelete,
  onRetry,
}: {
  uploads: SourceAssetRow[];
  deleting: boolean;
  retrying: boolean;
  onDelete: (upload: SourceAssetRow) => void;
  onRetry: (upload: SourceAssetRow) => void;
}) {
  return (
    <section className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
      <div className="border-b border-border bg-muted/40 px-5 py-2.5">
        <h2 className="text-xs font-medium text-foreground">
          File extraction
        </h2>
      </div>
      {uploads.map((upload) => (
        <div
          className="grid gap-2 border-b border-border px-5 py-3.5 last:border-0 md:grid-cols-[minmax(240px,1fr)_110px_110px_minmax(180px,0.8fr)_72px] md:items-center md:gap-4"
          key={upload.id}
        >
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium text-foreground">
              {upload.title ?? upload.filename}
            </p>
            <p className="truncate font-mono text-[11px] text-muted-foreground">
              {upload.source_key}
            </p>
          </div>
          <span className="text-xs text-muted-foreground">
            {formatBytes(upload.size_bytes)}
          </span>
          <StatusPill
            tone={upload.status === "failed" ? "danger" : "neutral"}
          >
            {upload.status.replaceAll("_", " ")}
          </StatusPill>
          <span
            className={cn(
              "truncate text-xs text-muted-foreground",
              upload.error && "text-destructive",
            )}
            title={upload.error ?? undefined}
          >
            {upload.error ??
              (upload.status === "awaiting_upload"
                ? "Waiting for source bytes"
                : "Original retained; extraction runs asynchronously")}
          </span>
          <div className="flex items-center justify-end gap-1">
            {upload.status === "failed" ? (
              <button
                aria-label="Retry extraction"
                className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                disabled={retrying}
                onClick={() => onRetry(upload)}
                title="Retry extraction"
                type="button"
              >
                <RefreshCw className="h-4 w-4" />
              </button>
            ) : null}
            {upload.status !== "processing" ? (
              <button
                aria-label={`Delete upload ${upload.title ?? upload.filename}`}
                className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                disabled={deleting}
                onClick={() => onDelete(upload)}
                title="Delete upload"
                type="button"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            ) : null}
          </div>
        </div>
      ))}
    </section>
  );
}

function SourceList({
  documents,
  loading,
  selectedId,
  onOpen,
  onDelete,
}: {
  documents: DocumentRow[];
  loading: boolean;
  selectedId?: string;
  onOpen: (document: DocumentRow) => void;
  onDelete: (document: DocumentRow) => void;
}) {
  if (loading) return <Loading label="Loading sources…" />;
  if (!documents.length) {
    return (
      <EmptyState
        detail="Add a text file or paste long-form source content to build the corpus."
        title="No sources yet"
      />
    );
  }
  return (
    <>
      <div className="hidden grid-cols-[120px_minmax(240px,1fr)_150px_200px_56px] gap-4 border-b border-border bg-muted/40 px-5 py-2.5 text-xs font-medium text-muted-foreground md:grid">
        <span>Updated</span>
        <span>Source</span>
        <span>Format</span>
        <span>Scope</span>
        <span className="text-right">Action</span>
      </div>
      {documents.map((document) => (
        <div
          className={cn(
            "grid cursor-pointer grid-cols-1 gap-2 border-b border-border px-5 py-3.5 transition-colors last:border-0 hover:bg-muted/45 md:grid-cols-[120px_minmax(240px,1fr)_150px_200px_56px] md:items-center md:gap-4",
            selectedId === document.id && "bg-muted/60",
          )}
          key={document.id}
          onClick={() => onOpen(document)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onOpen(document);
          }}
          role="button"
          tabIndex={0}
        >
          <span className="text-xs text-muted-foreground">
            {relativeTime(document.created_at)}
          </span>
          <SourceIdentity document={document} />
          <span className="text-xs text-muted-foreground">
            {document.mime_type}
            <br />
            {formatBytes(document.size_bytes)}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {scopeLabel(document)}
          </span>
          <DeleteButton document={document} onDelete={onDelete} />
        </div>
      ))}
    </>
  );
}

function SearchResults({
  hits,
  loading,
  selectedId,
  onOpen,
  onDelete,
}: {
  hits: DocumentSearchHit[];
  loading: boolean;
  selectedId?: string;
  onOpen: (document: DocumentRow) => void;
  onDelete: (document: DocumentRow) => void;
}) {
  if (loading) return <Loading label="Searching source evidence…" />;
  if (!hits.length) {
    return (
      <EmptyState
        detail="Try a more specific term or clear the query to inspect current sources."
        title="No matching evidence"
      />
    );
  }
  return (
    <>
      <div className="hidden grid-cols-[72px_minmax(220px,0.8fr)_minmax(300px,1.4fr)_56px] gap-4 border-b border-border bg-muted/40 px-5 py-2.5 text-xs font-medium text-muted-foreground md:grid">
        <span>Score</span>
        <span>Source</span>
        <span>Evidence</span>
        <span className="text-right">Action</span>
      </div>
      {hits.map((hit) => (
        <div
          className={cn(
            "grid cursor-pointer grid-cols-1 gap-2 border-b border-border px-5 py-3.5 transition-colors last:border-0 hover:bg-muted/45 md:grid-cols-[72px_minmax(220px,0.8fr)_minmax(300px,1.4fr)_56px] md:items-center md:gap-4",
            selectedId === hit.document.id && "bg-muted/60",
          )}
          key={hit.chunk.id}
          onClick={() => onOpen(hit.document)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onOpen(hit.document);
          }}
          role="button"
          tabIndex={0}
        >
          <span className="font-mono text-xs font-medium text-foreground">
            {hit.score.toFixed(3)}
          </span>
          <SourceIdentity document={hit.document} />
          <div className="min-w-0">
            <p className="line-clamp-2 text-[13px] leading-5 text-foreground">
              {hit.chunk.content}
            </p>
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">
              bytes {hit.chunk.start_byte}–{hit.chunk.end_byte}
              {hit.neighbors.length
                ? ` · ${hit.neighbors.length} adjacent chunk${
                    hit.neighbors.length === 1 ? "" : "s"
                  }`
                : ""}
            </p>
          </div>
          <DeleteButton document={hit.document} onDelete={onDelete} />
        </div>
      ))}
    </>
  );
}

function SourceIdentity({ document }: { document: DocumentRow }) {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <FileText className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium text-foreground">
          {document.title ?? document.source_key}
        </p>
        <p className="truncate font-mono text-[11px] text-muted-foreground">
          {document.source_key}
        </p>
      </div>
    </div>
  );
}

function DeleteButton({
  document,
  onDelete,
}: {
  document: DocumentRow;
  onDelete: (document: DocumentRow) => void;
}) {
  return (
    <button
      aria-label={`Delete ${document.title ?? document.source_key}`}
      className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
      onClick={(event) => {
        event.stopPropagation();
        onDelete(document);
      }}
      type="button"
    >
      <Trash2 className="h-3.5 w-3.5" />
    </button>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 px-5 py-16 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex flex-col items-center px-5 py-16 text-center">
      <FileText className="mb-3 h-6 w-6 text-muted-foreground" />
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 max-w-md text-[13px] text-muted-foreground">
        {detail}
      </p>
    </div>
  );
}

function SourceDrawer({
  document,
  jwt,
  workspaceId,
  onClose,
}: {
  document: DocumentRow | null;
  jwt?: string | null;
  workspaceId?: string | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const content = useQuery({
    queryKey: ["source-content", jwt, workspaceId, document?.id],
    queryFn: () => fetchDocumentContent(jwt!, document!.id, workspaceId),
    enabled: Boolean(jwt && workspaceId && document),
  });

  if (!document) return null;
  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true">
      <button
        aria-label="Close source inspector"
        className="absolute inset-0 bg-black/20 backdrop-blur-[1px]"
        onClick={onClose}
        type="button"
      />
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-2xl flex-col bg-background shadow-2xl ring-1 ring-foreground/10">
        <div className="flex items-start gap-3 border-b border-border px-6 py-5">
          <FileText className="mt-0.5 h-5 w-5 shrink-0 text-brand" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold text-foreground">
              {document.title ?? document.source_key}
            </h2>
            <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
              {document.source_key}
            </p>
          </div>
          <button
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={onClose}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-b border-border px-6 py-4 text-xs">
          <div>
            <dt className="text-muted-foreground">Format</dt>
            <dd className="mt-1 text-foreground">{document.mime_type}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Size</dt>
            <dd className="mt-1 text-foreground">
              {formatBytes(document.size_bytes)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Scope</dt>
            <dd className="mt-1 truncate text-foreground">
              {scopeLabel(document)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Created</dt>
            <dd className="mt-1 text-foreground">
              {new Date(document.created_at).toLocaleString()}
            </dd>
          </div>
          <div className="col-span-2">
            <dt className="text-muted-foreground">Content SHA-256</dt>
            <dd className="mt-1 truncate font-mono text-[11px] text-foreground">
              {document.content_hash}
            </dd>
          </div>
        </dl>

        <div className="flex items-center justify-between border-b border-border px-6 py-3">
          <p className="text-xs font-medium text-foreground">
            Indexed UTF-8 content
          </p>
          <button
            className={dashButton.secondary}
            disabled={!content.data}
            onClick={async () => {
              if (!content.data) return;
              await navigator.clipboard.writeText(content.data.content);
              setCopied(true);
              setTimeout(() => setCopied(false), 1_500);
            }}
            type="button"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-muted/20 px-6 py-5">
          {content.isLoading ? (
            <Loading label="Loading indexed content…" />
          ) : content.isError ? (
            <p className="text-sm text-destructive">
              {content.error instanceof Error
                ? content.error.message
                : "Could not load source content"}
            </p>
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5 text-foreground">
              {content.data?.content}
            </pre>
          )}
        </div>
      </aside>
    </div>
  );
}

function SourceIngestDialog({
  open,
  jwt,
  workspaceId,
  onClose,
  onCreated,
  onQueued,
}: {
  open: boolean;
  jwt?: string | null;
  workspaceId?: string | null;
  onClose: () => void;
  onCreated: (document: DocumentRow) => void;
  onQueued: (sourceAsset: SourceAssetRow) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [sourceKey, setSourceKey] = useState("");
  const [title, setTitle] = useState("");
  const [mimeType, setMimeType] = useState("text/plain");
  const [content, setContent] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [fileMeta, setFileMeta] = useState<
    Record<string, unknown> | undefined
  >();

  const create = useMutation<SourceSubmitResult, Error, void>({
    onMutate: () => setSubmitError(null),
    mutationFn: async (): Promise<SourceSubmitResult> =>
      selectedFile
        ? await uploadDocumentFile(jwt ?? "", {
            workspace: workspaceId,
            file: selectedFile,
            source_key: sourceKey.trim(),
            title: title.trim() || undefined,
            mime_type: mimeType,
            metadata: fileMeta,
          })
        : await ingestDocument(jwt ?? "", {
            workspace: workspaceId,
            source_key: sourceKey.trim(),
            content,
            title: title.trim() || undefined,
            mime_type: mimeType,
            metadata: fileMeta,
          }),
    onSuccess: (result) => {
      if ("document" in result) {
        toast.success(
          result.created
            ? `Source indexed into ${result.chunks} chunk${
                result.chunks === 1 ? "" : "s"
              }`
            : "Source already current",
        );
        onCreated(result.document);
      } else {
        toast.success(
          "File uploaded. Extraction is queued; the original is retained.",
        );
        onQueued(result.source_asset);
      }
      setSourceKey("");
      setTitle("");
      setMimeType("text/plain");
      setContent("");
      setSelectedFile(null);
      setSubmitError(null);
      setFileMeta(undefined);
    },
    onError: (error) => {
      const message =
        error instanceof Error ? error.message : "Could not ingest source";
      setSubmitError(message);
      toast.error(message);
    },
  });

  const contentBytes = useMemo(
    () => new TextEncoder().encode(content).byteLength,
    [content],
  );
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <button
        aria-label="Close source dialog"
        className="absolute inset-0 bg-black/35 backdrop-blur-[2px]"
        onClick={onClose}
        type="button"
      />
      <form
        className="relative flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-background shadow-2xl ring-1 ring-foreground/10"
        onSubmit={(event) => {
          event.preventDefault();
          if (
            !sourceKey.trim() ||
            (!selectedFile && !content.trim())
          ) {
            return;
          }
          if (!selectedFile && contentBytes > MAX_SOURCE_BYTES) {
            toast.error("Text sources must be at most 1,000,000 UTF-8 bytes");
            return;
          }
          if (selectedFile && selectedFile.size > MAX_UPLOAD_BYTES) {
            toast.error("File sources must be at most 25 MB");
            return;
          }
          create.mutate();
        }}
      >
        <div className="flex items-start gap-3 border-b border-border px-6 py-5">
          <Upload className="mt-0.5 h-5 w-5 text-brand" />
          <div className="flex-1">
            <h2 className="text-base font-semibold text-foreground">
              Add source
            </h2>
            <p className="mt-1 text-[13px] text-muted-foreground">
              Upload a file for asynchronous extraction, or paste UTF-8 text
              for immediate indexing. Reusing a source key creates an immutable
              new version.
            </p>
          </div>
          <button
            aria-label="Close"
            className="text-muted-foreground transition-colors hover:text-foreground"
            onClick={onClose}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-6 py-5">
          <input
            accept={SOURCE_FILE_ACCEPT}
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              if (file.size > MAX_UPLOAD_BYTES) {
                toast.error("File sources must be at most 25 MB");
                event.target.value = "";
                return;
              }
              setSelectedFile(file);
              setContent("");
              setSourceKey(file.name);
              setTitle(file.name);
              setMimeType(file.type.toLowerCase() || mimeFromName(file.name));
              setFileMeta({
                file_name: file.name,
                last_modified: new Date(file.lastModified).toISOString(),
              });
            }}
            ref={fileInput}
            type="file"
          />
          <button
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border px-4 py-5 text-[13px] font-medium text-muted-foreground transition-colors hover:border-foreground/25 hover:bg-muted/40 hover:text-foreground"
            onClick={() => fileInput.current?.click()}
            type="button"
          >
            <FileText className="h-4 w-4" />
            {selectedFile
              ? `Replace ${selectedFile.name}`
              : "Choose PDF, Office, EPUB, image, or text file"}
          </button>
          {selectedFile ? (
            <div className="flex items-center justify-between rounded-lg bg-muted/45 px-3 py-2 text-xs">
              <span className="min-w-0 truncate text-foreground">
                {selectedFile.name} · {formatBytes(selectedFile.size)}
              </span>
              <button
                className="ml-3 shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => {
                  setSelectedFile(null);
                  setContent("");
                  setFileMeta(undefined);
                  if (fileInput.current) fileInput.current.value = "";
                }}
                type="button"
              >
                Remove file
              </button>
            </div>
          ) : null}

          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">
              Source key
            </span>
            <input
              className="h-9 w-full rounded-lg border border-input bg-background px-3 text-[13px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              maxLength={512}
              onChange={(event) => setSourceKey(event.target.value)}
              placeholder="docs/architecture.md or canonical URL"
              required
              value={sourceKey}
            />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">
                Title
              </span>
              <input
                className="h-9 w-full rounded-lg border border-input bg-background px-3 text-[13px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                maxLength={500}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Optional"
                value={title}
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">
                Media type
              </span>
              <input
                className="h-9 w-full rounded-lg border border-input bg-background px-3 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                onChange={(event) => setMimeType(event.target.value)}
                value={mimeType}
              />
            </label>
          </div>
          {selectedFile ? (
            <p className="rounded-lg bg-muted/45 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
              FishMem stores the exact original bytes, then extracts Markdown
              and structure asynchronously for the RAG corpus. Files do not
              create conversational memory records.
            </p>
          ) : (
            <label className="block">
              <span className="mb-1.5 flex items-center justify-between text-xs font-medium text-foreground">
                <span>Exact source content</span>
                <span
                  className={cn(
                    "font-normal text-muted-foreground",
                    contentBytes > MAX_SOURCE_BYTES && "text-destructive",
                  )}
                >
                  {formatBytes(contentBytes)} / 1.0 MB
                </span>
              </span>
              <textarea
                className="min-h-56 w-full resize-y rounded-lg border border-input bg-background px-3 py-2.5 font-mono text-xs leading-5 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                onChange={(event) => setContent(event.target.value)}
                placeholder="Paste long-form UTF-8 text here…"
                required
                value={content}
              />
            </label>
          )}
          {submitError ? (
            <p
              className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive"
              role="alert"
            >
              {submitError}
            </p>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
          {create.isPending ? (
            <p className="mr-auto flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {selectedFile
                ? "Uploading exact bytes and queueing extraction…"
                : "Indexing source content…"}
            </p>
          ) : null}
          <button
            className={dashButton.secondary}
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
          <button
            className={dashButton.primary}
            disabled={
              create.isPending ||
              !sourceKey.trim() ||
              (!selectedFile && !content.trim()) ||
              (!selectedFile && contentBytes > MAX_SOURCE_BYTES) ||
              Boolean(selectedFile && selectedFile.size > MAX_UPLOAD_BYTES)
            }
            type="submit"
          >
            {create.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="h-4 w-4" />
            )}
            {selectedFile ? "Upload & extract" : "Index source"}
          </button>
        </div>
      </form>
    </div>
  );
}

function mimeFromName(name: string) {
  const extension = name.toLowerCase().split(".").pop();
  const mediaTypes: Record<string, string> = {
    bmp: "image/bmp",
    csv: "text/csv",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    eml: "message/rfc822",
    epub: "application/epub+zip",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    json: "application/json",
    jsonl: "application/json",
    markdown: "text/markdown",
    md: "text/markdown",
    odp: "application/vnd.oasis.opendocument.presentation",
    ods: "application/vnd.oasis.opendocument.spreadsheet",
    odt: "application/vnd.oasis.opendocument.text",
    pdf: "application/pdf",
    png: "image/png",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    rtf: "application/rtf",
    tif: "image/tiff",
    tiff: "image/tiff",
    tsv: "text/tab-separated-values",
    txt: "text/plain",
    webp: "image/webp",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xml: "application/xml",
    yaml: "application/yaml",
    yml: "application/yaml",
  };
  return (extension && mediaTypes[extension]) || "application/octet-stream";
}
