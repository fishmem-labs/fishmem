"use client";

import { FileText, Gauge, Globe2, KeyRound } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { BrandLogo } from "@/components/site/brand-logo";
import { ThemeToggle } from "@/components/site/theme-toggle";
import { SignOutButton } from "@/components/auth/sign-out-button";

const nav = [
  { label: "Dashboard", href: "/dashboard", icon: Gauge },
  { label: "API", href: "/dashboard/api-keys", icon: KeyRound },
  { label: "Blog", href: "/blog", icon: FileText }
];

export function SiteHeader() {
  const session = authClient.useSession().data;

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background/90 backdrop-blur-xl">
      <div className="mx-auto flex h-[52px] max-w-[1440px] items-center justify-between px-5">
        <BrandLogo className="text-sm font-semibold tracking-tight" />
        <nav className="hidden items-center gap-5 md:flex">
          {nav.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground/80 transition hover:text-brand"
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <button className="hidden h-9 items-center gap-1.5 rounded-full px-3 text-sm text-muted-foreground md:inline-flex" type="button">
            <Globe2 className="h-4 w-4" />
            English
          </button>
          <ThemeToggle />
          {session?.user ? (
            <>
              <a
                href="/dashboard"
                className="hidden h-9 items-center rounded-full border border-border px-4 text-sm font-medium transition hover:bg-accent sm:inline-flex"
              >
                Dashboard
              </a>
              <SignOutButton />
            </>
          ) : (
            <a
              href="/login"
              className="inline-flex h-10 items-center rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90"
            >
              Start For Free
            </a>
          )}
        </div>
      </div>
    </header>
  );
}
