# Contributing to fishmem

Thanks for your interest! Issues and pull requests are welcome.

## Development setup

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Everything runs offline — no API keys needed for the test suite. The
benchmark harness has an offline mode too: `pnpm bench:locomo -- --smoke`.

## Ground rules

- **Tests with every change.** The suite is fast and offline; new behaviour
  needs new tests. Run the full suite before opening a PR.
- **One canonical writer.** Desktop, self-hosted Web, and FishMem Cloud share
  the same MemoryCore and application contracts. Do not introduce a parallel
  handler, fallback store, duplicate DTO, or compatibility write path.
- **Preserve the write contract.** `infer=true` stores only records extracted
  by one inference operation; `infer=false` stores submitted records as-is.
  Exact long-form text and files belong to the separate source/document
  corpus, not a hidden raw-memory copy.
- **Scope is structural.** Workspace/project namespace and user/agent/run
  filters must remain fail-closed and must be rechecked after backend
  retrieval. An adapter optimization is never an authorization boundary.
- **Cost transparency.** Pure-computation features may default on. Anything
  that spends LLM tokens must be opt-in or an explicit call, documented in
  the README cost-control table.
- **Benchmark discipline.** Performance claims need within-harness numbers
  (`benchmarks/`), reported with the noise floor and dev/hold-out split. Keep
  prompts dataset-neutral — no LOCOMO content in prompt examples.
- **Edge compatibility.** No mandatory native dependencies; new drivers must
  be lazily imported and listed as optional peer dependencies.

## Pull requests

1. Fork, branch from `main`, keep PRs focused.
2. `pnpm lint && pnpm typecheck && pnpm test && pnpm build` must pass.
3. Describe *what* and *why*; link related issues.

## Reporting bugs / requesting features

Use the issue templates. For security issues, see [SECURITY.md](SECURITY.md)
— please do not open public issues for vulnerabilities.
