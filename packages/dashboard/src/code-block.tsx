"use client";

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import { Check, Copy } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "./utils";

let registered = false;
function ensureRegistered() {
  if (registered) return;
  hljs.registerLanguage("bash", bash);
  hljs.registerLanguage("javascript", javascript);
  hljs.registerLanguage("json", json);
  hljs.registerLanguage("python", python);
  registered = true;
}

const LANG_LABEL: Record<string, string> = {
  bash: "bash",
  javascript: "javascript",
  json: "json",
  python: "python",
};

export function CodeBlock({
  code,
  language = "bash",
  filename,
  className,
}: {
  code: string;
  language?: string;
  filename?: string;
  className?: string;
}) {
  ensureRegistered();
  const [copied, setCopied] = useState(false);
  const trimmed = code.replace(/\n+$/, "");

  const html = useMemo(() => {
    try {
      return hljs.highlight(trimmed, { language }).value;
    } catch {
      return null;
    }
  }, [trimmed, language]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(trimmed);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl bg-muted/40 ring-1 ring-foreground/10",
        className,
      )}
    >
      <div className="flex items-center justify-between border-b border-border bg-muted/40 px-3.5 py-2">
        <span className="font-mono text-[11px] tracking-tight text-muted-foreground">
          {filename ?? LANG_LABEL[language] ?? language}
        </span>
        <button
          aria-label="Copy code"
          className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
          onClick={copy}
          type="button"
        >
          {copied ? (
            <Check className="h-3 w-3 text-success" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="code-hl overflow-x-auto px-4 py-3.5 font-mono text-[12.5px] leading-[1.6] [font-variant-ligatures:none] [tab-size:2]">
        {html ? (
          // biome-ignore lint/security/noDangerouslySetInnerHtml: output is hljs-escaped HTML
          <code dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <code>{trimmed}</code>
        )}
      </pre>
    </div>
  );
}
