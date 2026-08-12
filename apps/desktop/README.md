# FishMem Desktop

> **One private memory. Every agent.**

A privacy-first local memory layer for Codex and Claude Code. FishMem's value
appears inside those agents; this application is the quiet control surface for
connection, health, provenance, correction, privacy, export, and deletion.

## Storage model

FishMem Desktop does not run a separate vector database service. Graph records,
vectors, keyword indexes, and application data share one local libSQL/SQLite
database. A quantized multilingual E5 ONNX model is downloaded once and runs
locally; no API key or remote embedding provider is supported.

Codex and Claude Code distill durable memories before sending them. FishMem
stores the submitted content verbatim with derivation disabled and does not run
a chat LLM. Add and search fail explicitly until the local model and semantic
index are ready; FishMem never silently substitutes keyword-only search.

Long-form UTF-8 sources use a separate local corpus. The exact source is
canonical; deterministic chunks plus vector/keyword indexes are rebuildable.
The Desktop SDK and machine-oriented CLI expose ingest, search, list, get,
exact-content retrieval, and source-family deletion. Supported textual input is
limited to 1,000,000 UTF-8 bytes; PDF, DOCX, OCR, and other binary parsing are
not claimed.

## Development

```bash
pnpm --filter @fishmem/desktop typecheck
pnpm --filter @fishmem/desktop test
pnpm --filter @fishmem/desktop build
pnpm --filter @fishmem/desktop dev
```

## Production macOS release

`release:mac` is the production path. It builds one Universal application for
Apple silicon and Intel, signs every nested executable with Developer ID,
notarizes and staples both the application and final DMG, and then runs
Gatekeeper, `syspolicy_check`, signature, archive, and architecture checks.

ONNX Runtime 1.24 stopped publishing Intel macOS binaries. The Desktop package
therefore pins the Transformers runtime edge to 1.23.2 (the last upstream
release containing both macOS architectures) and pins the E5 model revision.
Do not remove either release constraint without replacing the Intel inference
runtime and validating it on real x86_64 hardware.

```bash
pnpm --filter @fishmem/desktop release:mac
```

If an automation runner is interrupted only after electron-builder has already
produced the notarized app plus DMG and ZIP, resume final signing, DMG
notarization, validation, and manifest generation without rebuilding:

```bash
pnpm --filter @fishmem/desktop release:mac:finalize
```

For a packaged development build, run the same local add/search/update/history
and delete lifecycle without signing credentials:

```bash
node apps/desktop/scripts/release-mac.mjs --smoke-app \
  apps/desktop/release/mac-arm64/FishMem.app
```

Formal release still requires a clean committed checkout and a real Intel Mac
smoke for the Universal build; an Apple-silicon architecture check cannot prove
the Intel ONNX runtime executes correctly.

The release command deliberately contains no organization-specific signing
identity, team, or keychain profile. Maintainers provide them through the
environment so forks can use their own Apple account without editing source:

```bash
FISHMEM_MAC_IDENTITY="Developer ID Application: …" \
FISHMEM_APPLE_TEAM_ID="…" \
FISHMEM_NOTARY_PROFILE="…" \
pnpm --filter @fishmem/desktop release:mac
```

FishMem's official release automation and storage configuration live outside
the open-source repository. Stable public downloads are:

- `https://downloads.fishmem.com/desktop/mac/latest/FishMem.dmg`
- `https://downloads.fishmem.com/desktop/mac/latest/FishMem.zip`
- `https://downloads.fishmem.com/desktop/mac/latest/manifest.json`

`FISHMEM_DOWNLOAD_BASE_URL` changes the URLs written into a locally generated
manifest. It does not upload artifacts; forks remain free to publish through
their own release infrastructure.

## Agent integration

Current one-click integration support covers Codex and Claude Code. Open the
app, choose **Codex & Claude**, and connect the agent you use. FishMem installs
one self-contained CLI plus the same Agent Skill in the client's global skill
directory:

- Codex: `~/.agents/skills/fishmem`
- Claude Code: `~/.claude/skills/fishmem`

The `fishmem` command communicates with the running app through an authenticated
private local socket. The desktop integration intentionally uses a Skill plus
the local CLI and does not package an MCP server.

Start the installed application from an agent or terminal and wait for the
local service to become ready:

```bash
fishmem desktop start --json
```

The command is idempotent when Desktop is already running. On a non-standard
Windows or Linux installation, set `FISHMEM_DESKTOP_EXECUTABLE` to the exact
Desktop executable or AppImage path.
