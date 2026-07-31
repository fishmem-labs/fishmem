import { ArrowRight, CheckCircle2, Database, History } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./utils";

export type MemoryHomeMetric = {
  label: string;
  value: string;
  hint?: string;
};

export type MemoryHomeItem = {
  id: string;
  content: string;
  timestamp: string;
  context?: string;
  href?: string;
};

function RecentList({
  title,
  empty,
  items,
  onOpen,
}: {
  title: string;
  empty: string;
  items: MemoryHomeItem[];
  onOpen?: (id: string) => void;
}) {
  return (
    <section className="min-w-0 border-t border-border pt-4">
      <div className="mb-2 flex items-center gap-2">
        <History className="size-3.5 text-muted-foreground" />
        <h2 className="text-[13px] font-medium text-foreground">{title}</h2>
      </div>
      {items.length ? (
        <div className="divide-y divide-border">
          {items.map((item) => {
            const content = (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-foreground">
                    {item.content}
                  </span>
                  {item.context ? (
                    <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                      {item.context}
                    </span>
                  ) : null}
                </span>
                <time
                  className="shrink-0 text-xs text-muted-foreground"
                  dateTime={item.timestamp}
                >
                  {new Intl.RelativeTimeFormat("en", {
                    numeric: "auto",
                  }).format(
                    -Math.max(
                      0,
                      Math.round(
                        (Date.now() - new Date(item.timestamp).getTime()) /
                          86_400_000,
                      ),
                    ),
                    "day",
                  )}
                </time>
              </>
            );
            const className =
              "flex w-full items-center gap-3 py-3 text-left transition-colors hover:bg-muted/40";
            return item.href ? (
              <a className={className} href={item.href} key={item.id}>
                {content}
              </a>
            ) : (
              <button
                className={className}
                key={item.id}
                onClick={() => onOpen?.(item.id)}
                type="button"
              >
                {content}
              </button>
            );
          })}
        </div>
      ) : (
        <p className="py-8 text-center text-xs text-muted-foreground">{empty}</p>
      )}
    </section>
  );
}

export function MemoryHome({
  title = "Home",
  description,
  environment,
  status,
  statusTone = "success",
  metrics,
  recentRemembered,
  recentRecalled,
  onOpenMemory,
  viewAllHref,
  onViewAll,
  actions,
  children,
}: {
  title?: string;
  description: string;
  environment: string;
  status: string;
  statusTone?: "success" | "warning" | "danger" | "neutral";
  metrics: MemoryHomeMetric[];
  recentRemembered: MemoryHomeItem[];
  recentRecalled: MemoryHomeItem[];
  onOpenMemory?: (id: string) => void;
  viewAllHref?: string;
  onViewAll?: () => void;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const statusClass = {
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-destructive",
    neutral: "bg-muted-foreground",
  }[statusTone];

  const viewAll = (
    <>
      View all memories
      <ArrowRight className="size-3.5" />
    </>
  );

  return (
    <div className="mx-auto w-full max-w-[946px]">
      <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {title}
          </h1>
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        </div>
        {actions}
      </header>

      <section className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 border-y border-border py-3 text-[13px]">
        <span className="flex items-center gap-2 font-medium text-foreground">
          <span className={cn("size-2 rounded-full", statusClass)} />
          {status}
        </span>
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <CheckCircle2 className="size-3.5" />
          {environment}
        </span>
      </section>

      <section className="grid border-b border-border sm:grid-cols-2 lg:grid-cols-4">
        {metrics.map((metric) => (
          <div
            className="min-w-0 border-b border-border py-5 pr-5 sm:odd:border-r sm:even:pl-5 lg:border-b-0 lg:border-r lg:pl-5 lg:first:pl-0 lg:last:border-r-0"
            key={metric.label}
          >
            <p className="text-xs font-medium text-muted-foreground">
              {metric.label}
            </p>
            <p className="mt-2 text-2xl font-semibold leading-none tracking-tight text-foreground">
              {metric.value}
            </p>
            {metric.hint ? (
              <p className="mt-2 truncate text-xs text-muted-foreground">
                {metric.hint}
              </p>
            ) : null}
          </div>
        ))}
      </section>

      <section className="mt-6 grid gap-6 lg:grid-cols-2">
        <RecentList
          empty="No memories have been added yet."
          items={recentRemembered}
          onOpen={onOpenMemory}
          title="Recently remembered"
        />
        <RecentList
          empty="Recalled memories will appear here."
          items={recentRecalled}
          onOpen={onOpenMemory}
          title="Recently recalled"
        />
      </section>

      {viewAllHref || onViewAll ? (
        <div className="mt-4 flex justify-end">
          {viewAllHref ? (
            <a
              className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              href={viewAllHref}
            >
              {viewAll}
            </a>
          ) : (
            <button
              className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={onViewAll}
              type="button"
            >
              {viewAll}
            </button>
          )}
        </div>
      ) : null}

      {children ? (
        <div className="mt-8 border-t border-border pt-8">{children}</div>
      ) : null}
    </div>
  );
}
