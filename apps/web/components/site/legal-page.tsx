import { SiteFooter } from "@/components/site/footer";
import { SiteHeader } from "@/components/site/header";

export function LegalPage({
  title,
  description,
  sections
}: {
  title: string;
  description: string;
  sections: Array<[string, string]>;
}) {
  return (
    <div className="marketing-shell flex min-h-screen flex-col bg-white text-[#181815]">
      <SiteHeader />
      <main className="flex-1 bg-white">
        <section className="border-b border-border bg-muted/30 py-14">
          <div className="mx-auto max-w-7xl px-4 sm:px-6">
            <p className="text-sm text-muted-foreground">Effective: May 15, 2026 · Last updated: May 15, 2026</p>
            <h1 className="mt-4 text-5xl font-semibold tracking-tight">{title}</h1>
            <p className="mt-5 max-w-3xl text-base leading-7 text-muted-foreground">{description}</p>
          </div>
        </section>
        <div className="mx-auto grid max-w-7xl gap-8 px-4 py-12 sm:px-6 lg:grid-cols-[300px_1fr]">
          <aside className="hidden lg:block">
            <nav className="sticky top-20 rounded-lg border border-border bg-card p-4 text-sm">
              {sections.map(([heading], index) => (
                <a
                  key={heading}
                  href={`#section-${index + 1}`}
                  className="block rounded-md px-2 py-2 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  {index + 1}. {heading}
                </a>
              ))}
            </nav>
          </aside>
          <article className="space-y-5">
            {sections.map(([heading, body], index) => (
              <section
                key={heading}
                id={`section-${index + 1}`}
                className="rounded-lg border border-border bg-card p-6"
              >
                <h2 className="text-xl font-semibold">{index + 1}. {heading}</h2>
                <p className="mt-3 text-sm leading-7 text-muted-foreground">{body}</p>
              </section>
            ))}
          </article>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
