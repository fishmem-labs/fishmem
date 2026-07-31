import { BrandMark } from "@/components/site/brand-logo";
import { BRAND_CONTACT_EMAIL, BRAND_NAME } from "@/lib/config";

const groups = [
  {
    title: "Product",
    links: [
      ["Dashboard", "/dashboard"],
      ["Blog", "/blog"]
    ]
  },
  {
    title: "Developers",
    links: [
      ["Sign in", "/login"],
      ["Documentation", "https://docs.fishmem.com"],
      ["API keys", "/login"]
    ]
  },
  {
    title: "Legal",
    links: [
      ["Privacy", "/privacy"],
      ["Terms", "/terms"]
    ]
  }
];

export function SiteFooter() {
  return (
    <footer className="border-t border-border bg-background">
      <div className="mx-auto grid max-w-7xl gap-10 px-5 py-12 md:grid-cols-[1.2fr_2fr]">
        <div>
          <div className="flex items-center gap-2 font-semibold text-foreground">
            <BrandMark className="h-8 w-8" />
            {BRAND_NAME}
          </div>
          <p className="mt-4 max-w-md text-sm leading-6 text-muted-foreground">
            Rapid memory for AI agents: a mem0-compatible REST API with hybrid
            graph + vector recall and bi-temporal facts, built on the
            open-source fishmem engine and hosted on the edge.
          </p>
          <form className="mt-5 flex max-w-sm gap-2">
            <input
              type="email"
              placeholder="Enter your email"
              className="h-10 min-w-0 flex-1 rounded-xl border border-border bg-background px-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
            />
            <button type="button" className="h-10 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90">
              Subscribe
            </button>
          </form>
          <a
            className="mt-4 inline-flex text-sm text-muted-foreground hover:text-foreground"
            href={`mailto:${BRAND_CONTACT_EMAIL}`}
          >
            {BRAND_CONTACT_EMAIL}
          </a>
        </div>
        <div className="grid gap-8 sm:grid-cols-3">
          {groups.map((group) => (
            <div key={group.title}>
              <h3 className="text-sm font-semibold text-foreground">{group.title}</h3>
              <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
                {group.links.map(([label, href]) => (
                  <li key={`${label}-${href}`}>
                    <a href={href} className="hover:text-foreground">
                      {label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </footer>
  );
}
