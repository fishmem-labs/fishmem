import { cn } from "./utils";

export function PageShell({
  title,
  description,
  actions,
  children,
  contentClassName
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  contentClassName?: string;
}) {
  return (
    <div className="mx-auto w-full max-w-[946px]">
      <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {title}
          </h1>
          {description ? (
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </header>
      <div className={cn("mt-6 space-y-6", contentClassName)}>{children}</div>
    </div>
  );
}

export function Panel({
  title,
  description,
  actions,
  children,
  className
}: {
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-xl bg-card text-sm text-card-foreground ring-1 ring-foreground/10",
        className
      )}
    >
      {title || actions ? (
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            {title ? (
              <h2 className="text-base font-medium leading-snug text-foreground">
                {title}
              </h2>
            ) : null}
            {description ? (
              <p className="mt-1.5 text-sm leading-normal text-muted-foreground">
                {description}
              </p>
            ) : null}
          </div>
          {actions}
        </div>
      ) : null}
      <div className="p-5">{children}</div>
    </section>
  );
}

const buttonBase =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-transparent px-2.5 text-[13px] font-medium transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 active:translate-y-px disabled:pointer-events-none disabled:opacity-50";

export const dashButton = {
  primary: cn(buttonBase, "bg-primary text-primary-foreground hover:bg-primary/80"),
  secondary: cn(
    buttonBase,
    "bg-secondary text-secondary-foreground hover:bg-secondary/80"
  ),
  outline: cn(
    buttonBase,
    "border-border bg-background hover:bg-muted hover:text-foreground"
  ),
  ghost: cn(buttonBase, "hover:bg-muted hover:text-foreground"),
  danger: cn(
    buttonBase,
    "bg-destructive/10 text-destructive hover:bg-destructive/20"
  )
};

/** Canonical text-input styling — keep all dialog/form inputs on this. */
export const inputClass =
  "h-9 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

/** Canonical toolbar toggle-chip — same scale as the Filters button; selected
 * inverts to a solid fill (matches the active date-range pill). */
export const chipToggle = (active: boolean) =>
  cn(
    "inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[13px] font-medium transition-colors",
    active
      ? "border-foreground bg-foreground text-background"
      : "border-border bg-background text-foreground hover:bg-muted",
  );

export function Metric({
  label,
  value,
  hint
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl bg-card p-5 ring-1 ring-foreground/10">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold leading-none tracking-tight text-foreground">
        {value}
      </p>
      {hint ? <p className="mt-2 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function StatusPill({
  tone = "neutral",
  children
}: {
  tone?: "success" | "warning" | "danger" | "neutral" | "info";
  children: React.ReactNode;
}) {
  const toneStyles: Record<string, string> = {
    success: "bg-success/10 text-success",
    warning: "bg-warning/15 text-warning",
    danger: "bg-destructive/10 text-destructive",
    neutral: "bg-muted text-muted-foreground",
    info: "bg-info/10 text-info"
  };
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-full px-2 text-xs font-medium",
        toneStyles[tone]
      )}
    >
      {children}
    </span>
  );
}
