# FishMem Product Strategy

## Product definition

FishMem is the memory layer for AI.

It does not compete for the user's attention. It gives agents and applications
durable, relevant, correctable memory while keeping the owner in control.

The Desktop and open-source project slogan is:

> **One private memory. Every agent.**

The product has three surfaces with different customers and jobs:

| Surface | Customer | Job |
|---|---|---|
| FishMem Desktop | People using Codex or Claude Code | A privacy-first local memory layer shared across their agents |
| `apps/web` | Developers building applications with memory | An open-source, self-hostable memory service with an API, TypeScript/Python SDKs, and operator UI |
| FishMem Cloud | Teams and companies that do not want to operate the service | The managed commercial version of the web service |

These are not three unrelated products. They share the same memory semantics,
contracts, and quality standards, but they must not blur their user journeys.

## Desktop: invisible by default, controllable at any time

FishMem Desktop is local infrastructure, not a destination workspace. Its value
should normally appear inside Codex and Claude Code:

- an agent stores a durable preference, decision, or lesson;
- a later session recalls it at the moment it becomes relevant;
- the user can correct or forget it without teaching every agent separately.

The Desktop application exists as a control surface for:

- one-click agent connection and integration health;
- memory provenance, access history, and explanation;
- correction, deletion, export, backup, and recovery;
- global, project, agent, and sensitive-data boundaries;
- local model and index health.

It must not invent a daily inbox, note-taking ritual, project manager, or chat
client merely to create Desktop engagement.

### Privacy contract

- Local by default; no account, cloud service, or API key is required.
- Canonical content, indexes, and embeddings remain on the device.
- Desktop has no remote embedding provider, provider API key, or silent hosted
  fallback.
- Do not silently capture complete chats, screens, files, or repositories.
- Every memory has an inspectable source and scope.
- Delete means delete; export and backup use documented, portable formats.
- Remote sync is optional, end-to-end encrypted, and separable from the local
  product.

## Web: the open-source application memory service

`apps/web` is the deployable product for application developers. It is analogous
to the self-hostable side of mem0, not a hosted marketing shell and not a remote
version of Desktop.

It must provide:

- a production HTTP API, one maintained universal TypeScript SDK for Node,
  Bun, Deno, Cloudflare Workers, Vercel, and other fetch-compatible runtimes,
  plus a tested synchronous/asynchronous Python SDK;
- explicit mem0 migration guidance without compatibility shims or hidden
  aliases before the first stable release;
- one-command local or Docker deployment and documented production deployment;
- project, namespace, API-key, webhook, observability, backup, and lifecycle
  operations;
- a separate source-backed RAG path that keeps long-form originals canonical
  and retrieval chunks rebuildable instead of polluting conversational memory;
- pluggable storage, embedding, and model providers without hidden cloud
  dependencies;
- an operator UI built with TanStack Start and shared packages for contracts,
  use cases, and reusable presentation components.

Self-hosting is a first-class product path. It is not a degraded trial for
FishMem Cloud.

## Cloud: the managed commercial service

The private `fishmem-cloud` repository contains the managed commercial edition.
Its TanStack Start web application consumes the open-source packages and adds
hosted operations rather than copying or forking them.

Cloud earns money by removing operational and organizational burden:

- managed scaling, backups, upgrades, and reliability;
- usage metering and spend controls;
- team memory spaces and role-based access;
- audit logs, retention policies, SSO, compliance, and data residency;
- dedicated, VPC, and enterprise deployment options;
- premium connectors, evaluation, support, and service-level agreements.

Commercial code may depend on open-source code. Open-source code must never
depend on commercial code.

## Product principles

1. **Useful recall, not stored volume.** More memories are not success.
2. **The source of truth stays inspectable.** Derived summaries and graphs never
   erase provenance.
3. **Remember selectively.** Memory pollution is a product failure.
4. **Correction is as important as capture.** Users must be able to supersede,
   scope, or delete a belief.
5. **One memory, many agents.** Integrations should not create incompatible
   copies of the user's history.
6. **Open locally, paid for coordination.** Local ownership and self-hosting
   build trust; managed operations, sync, teams, and governance fund the
   business.

## Success measures

Desktop should not optimize for daily app opens. Its activation event is:

1. connect an agent;
2. store a useful memory;
3. recall it correctly in a later session.

The primary quality measures are successful useful recall, incorrect-memory
rate, correction rate, recall latency, and integration reliability.

Web and Cloud should measure time to first successful API recall, time to first
source-backed answer, citation integrity, retained production projects, recall
quality, unit economics per memory/document operation, reliability, and
expansion from one application or team to several.

## Commercial hypotheses

The initial business model should be tested in this order:

1. Managed FishMem Cloud for developers and production applications.
2. Team and enterprise governance: shared scopes, audit, retention, SSO, and
   private deployment.
3. Optional end-to-end encrypted sync and recovery for Desktop users.
4. A portable memory identity that a user can authorize across agents and
   applications without surrendering ownership of the underlying data.

The fourth item is a long-term bet. It must earn trust through the first three
and must never turn into a data brokerage model.
