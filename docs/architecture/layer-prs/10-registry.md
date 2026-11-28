# 10: Layer Registry

## 10.1 What it is

Content-addressed store + ref database + policy engine + review/PR objects + audit index. Substrate: extend `packages/collab-server` and `apps/server` (auth, websocket, persistence already exist). Protocol: plain HTTP push/pull of layers by id (dumb storage, smart client), websocket events for reviews.

As shipped, the registry is part of `@ifc-lite/collab-server`. `startCollabServer({ layerRegistry })` mounts it; it is off by default. Pass `true` for an in-memory registry, or `{ store, maxBytes, webhooks }` to supply a store, a body-size limit and webhooks (`packages/collab-server/src/server.ts`). By default, registry authorization derives from the server's `authenticate` hook. Set `authorizeRegistry` to override it, or to `null` to disable the registry authorizer. The routes (`packages/collab-server/src/layer-registry-route.ts`) live under `/api/v1/`: `layers` (push, list, pull by id), `reports/<digest>` (check evidence, GET/PUT), `refs` (list, read, `PUT` create/move/protect, `POST refs/:name/merge`) and `reviews` (open, read, `topics`, `feedback`). Review events go out through webhooks, not a websocket. `ifc-lite layer push` uploads to it.

## 10.2 Open core split (deliberate Git/GitHub split)

- **MPL-2.0, forever**: layer format, manifest spec, diff, merge, CLI, MCP tools, single-user/local refs, the GitHub Action
- **Paid (a team tier; the Tauri desktop app this once extended has been removed)**: hosted registry, team permissions, protected refs + policies, review workflows + notifications, provenance/audit search ("every layer any agent wrote this month, grouped by model"), sidecar CDN, SLA

The merge engine being open is what makes the standard adoptable (11); coordination is the product.

## 10.3 Federation and grouping

Multi-model sessions (04 §4.2) render as one logical PR. Cross-org federation (architect's registry ↔ engineer's registry) via signed layer exchange: the long-game version is registries syncing like Git remotes, with the DBL/DPP world (manufacturer layers, 03 §3.2) as external principals.

## 10.4 Ref policies (branch protection for buildings)

Per ref: required checks (IDS specs by digest), minimum reviewers, signature requirements, author-kind rules (e.g. agent-authored layers always need one human approval), risk-tier rules (red-tier ops never auto-merge), and **auto-merge**: conflict-free + all-green + in-policy layers merge unattended. Auto-merge is what makes the nightly model-gardener agent (06 §6.5) safe to ship.

As shipped, `RefPolicy` (`packages/merge/src/ref-flow.ts`) has `requireHumanApproval`, `requiredChecks` and `autoMerge` only. `requireHumanApproval` is the one author-kind rule: the local flow requires approval for agent-authored or manifest-less candidates, and the registry requires a recorded approval from a principal other than the author for every candidate on a ref with that policy, since `author.kind` is self-asserted (`packages/collab-server/src/layer-registry-route.ts`). Minimum reviewer counts, signature requirements, other author-kind rules and risk-tier rules are still design.

## 10.5 Visibility

Public, internal, private registries (same trichotomy as code forges). A public registry of open reference models with full layer history is the community flywheel: teaching material (BFH courses run on it), benchmark corpus, and the place hackathon projects publish to.

## 10.6 Endgame

The registry as the system of record for *change* in the built environment: every model state reproducible, every contributor accountable, every agent auditable, across organizations and decades. The pitch to enterprises is insurance-grade: "show me who changed the fire rating of this wall, when, on whose instruction, and what checks passed" answered in one query.
