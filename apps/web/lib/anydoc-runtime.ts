import type { AnyDocModule } from "@/lib/server/anydoc-extractor";

/**
 * Loader for the in-process document converter.
 *
 * The converter is WebAssembly, and how WebAssembly is instantiated differs by
 * target: a bundled Worker receives a compiled `WebAssembly.Module` from its
 * build, while Node reads the artifact off disk. This module owns the portable
 * path — a dynamic import that resolves through the package's own bindings —
 * and returns `null` when the optional dependency is not installed, which is
 * the signal to keep using the out-of-process extractor.
 *
 * Deployments that bundle their own WebAssembly override this module through
 * the `@/lib/anydoc-runtime` path.
 */
let cached: Promise<AnyDocModule | null> | undefined;

async function importAnyDoc(): Promise<AnyDocModule | null> {
  try {
    const specifier = "@firecrawl/anydoc-wasm";
    const module = (await import(/* @vite-ignore */ specifier)) as Partial<
      AnyDocModule
    > & {
      default?: (input?: unknown) => Promise<unknown>;
    };
    // The wasm-bindgen entry point needs initialising before its exports are
    // callable; on Node the default initialiser resolves the artifact itself.
    if (typeof module.default === "function") await module.default();
    if (
      typeof module.toMarkdownBytes !== "function" ||
      typeof module.formatFromBytes !== "function" ||
      typeof module.formatFromExtension !== "function"
    ) {
      return null;
    }
    return module as AnyDocModule;
  } catch {
    return null;
  }
}

/**
 * Resolve a loader for the in-process converter, or `null` when this runtime
 * cannot host it. The module is instantiated at most once per isolate.
 */
export async function loadAnyDocModule(): Promise<
  (() => Promise<AnyDocModule>) | null
> {
  cached ??= importAnyDoc();
  const module = await cached;
  if (!module) return null;
  return async () => module;
}
