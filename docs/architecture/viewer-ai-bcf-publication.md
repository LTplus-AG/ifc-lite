# Native BCF drafts and publication

The user selected a local test server for publication tests and will review the recorded coordinator workflows. That selection authorizes the local peer; it is not completed UX acceptance. The complete P11/P12 contracts remain in the [program plan](viewer-ai-plan.md). User-facing behaviour is described in the [BCF guide](../guide/bcf.md#bcf-drafts-and-publication).

## Measured native contract

The integration suites use the viewer's `signInWithToken`, `createConnectedClient` and `pullBcfServerProject`, the BCF API client, and the native BCF archive writer/reader. No fetch response is substituted. An independently stateful, loopback-only HTTP peer commits effects, enforces its vocabulary/permission policy, and can drop a response after committing (the next write, or chosen accepted-write ordinals).

| Operation | Evidence | How the outbox handles it |
|---|---|---|
| Topic create | Real HTTP POST; server allocates GUID, author and date | The write DTO has no client GUID or correlation field. The generated description footer names the local draft topic GUID and member digest, so a lost response is recognised by an explicit lookup. Title matching alone (Flow writes) only produces candidates. |
| Topic update | Real HTTP PUT keeps topic GUID, human comments and viewpoints | No conditional version header is exposed. Before a PUT the dispatcher reads the topic and compares the owned fields with the last confirmed values; a difference blocks the update (`remote-conflict`) until the coordinator overwrites or discards it. |
| Comment create | Server GUID, author and text retained | Draft comments carry a generated trailer naming the comment id, so a lost response is recognised by lookup. Flow comments only produce equal-text candidates. |
| Viewpoint create/read | Caller GUID, components, camera and clipping planes survive HTTP pull and archive | The client chooses the GUID; a lookup by GUID is exact. A 409 on create is an unknown outcome, never a failure. |
| Vocabulary/permission refusal | 400 for unsupported values, 403 for revoked permission, no effects | Preflight reads the selected project's `authorization.project_actions` and extensions (type, status, priority, stage, labels, `user_id_type`) and refuses before sending. Topic actions from the create receipt (or a fresh read for updates) gate comments, viewpoints and updates. Unadvertised capabilities are warnings; the server's own refusal is then recorded as a definite failure. |
| Commit then lost response | Native request rejects while the server holds one committed effect | The entry becomes `uncertain`; it and its dependents are never resent automatically. |
| Repeated equal-title creates | Two creates allocate two GUIDs | One outbox record per batch and project; a topic with a create entry never gets another, so republishing the same batch updates instead of duplicating. |

The roundtrip and draft suites use identities (GlobalId, name, IFC type) of the committed SketchUp `building-architecture.ifc` sample through the native parser, with a controlled box layout for the real TS clash engine. Those findings are engine output for that layout, not measured clashes of the authored building. These tests establish client/controlled-peer behaviour, not buildingSMART or vendor conformance.

## Draft model (P11)

`lib/bcf-drafts`: a `DraftBatch` records its source (clash run digest over finding identities and rules, finding count, capture time, render-to-world offset) and topics. A `DraftTopic` has a stable local GUID, title, human description, type, status, priority, labels, an assignee only when chosen from a server user list, its origin (`group` with workspace and group id, `selection`, or `archive`), frozen member findings (review key, occurrence key, rule, detection class, severity, distance, both element identities, render-frame bounds), one viewpoint framed through `createBCFFromClashResult`, and comments. The durable decoder refuses any batch in which two topics claim one finding or two topics share a GUID.

Edits (`draft-edit.ts`) are pure: rename/field edits, member removal, split (both halves keep the origin), merge (first topic keeps its GUID and therefore its server mapping), comments and deletion; membership changes re-frame the viewpoint. `draft-reconcile.ts` resolves members against a newer run with the manual-group occurrence-then-review-key resolver and returns a proposal per topic (unchanged with refreshed snapshots, disappeared, new group matches, matches held by another topic) plus unplaced matches when a group backs several topics. Applying is per topic and explicit.

`draft-archive.ts` writes plain BCF 2.1 through the native writer. The description footer (`-- ifc-lite BCF draft mapping v1 ... --`) carries batch id/name, source, origin, member count/digest and one encoded line per member; reimport restores batch, topic GUIDs, members, origin, viewpoint and comments. A footer whose members do not match its digest is reported as damaged and imported unmapped. Server publication sends only the compact footer (batch, topic, count, digest).

## Outbox (P12)

`lib/bcf-publication`: one `BcfPublication` record per (batch, server, project) — or per (Flow base URL, project) — holds an entry per effect: `createTopic`, `updateTopic`, `createComment`, `createViewpoint`, with the exact frozen payload, a digest of connector + project + effect + payload, dependency on the topic create, attempts, timestamps, receipt, failure, check result and conflict baseline.

```
queued ──► sending ──► done        receipt from the response, a lookup, or a coordinator choice among lookup candidates
                  ├──► failed      HTTP 4xx refusal (401 auth, 403 permission, other rejected): nothing applied
                  └──► uncertain   no answer after dispatch, abort/timeout, 5xx, 409, unreadable body, or interrupted by reload
blocked            imported from a backup, or an update over a conflicting remote edit
```

Rules, each covered by the suites below:

- `sending` is committed with compare-and-swap before the request leaves; if storage refuses, nothing is sent. Receipts are committed after. If that commit fails, the row stays `sending` and becomes `uncertain` on the next start.
- `uncertain` and `blocked` entries, and entries depending on them, are skipped by dispatch and by replanning. Only a definite failure is requeued automatically on republish.
- "Check server" reads only. A unique footer/trailer/GUID match by the signed-in author is a `lookup` receipt; other matches are candidates for an explicit choice; requeueing requires a fresh check that found no trace (Flow entries are then closed as `confirmed-absent`, releasing the node). An indeterminate outcome cannot be waived into a resend.
- On startup every `sending` entry not in flight in this tab becomes `uncertain` (`interrupted`). Queued entries stay queued and resume on the next publish; resuming is a user action, not automatic.
- Library backup import quarantines outbox records: unfinished entries arrive `blocked` (`imported`), done receipts are kept, and a conflicting record forks a blocked copy. Imported entries are never dispatched without a check.
- Dispatch refuses a record whose server or account differs from the connected one.
- Authentication: the connected client refreshes the token once on HTTP 401 and repeats that request. A 401 is returned before any effect, so the repeat cannot duplicate a write; a second 401 is a definite `auth` failure.
- Per-batch partial success is explicit: each dispatch reports receipts, refusals, unknown outcomes, blocked and waiting entries; other topics continue past an uncertain one.

Flow `bcf.createTopic` / `bcf.addComment` in the viewer go through `FlowHost.bcfWrites` (`flow-gateway.ts`): the intent is committed as `sending` first, an identical unresolved write is refused without sending, and the bearer token is never persisted. Hosts without a gateway (CLI, MCP) never retry and report a lost connection as an unknown outcome.

Transport: `FoundationRequestOptions`/`HttpRequestOptions` accept `signal`, `timeoutMs` and headers; an already-aborted signal is refused before `fetch`. `topicToApiWrite` and `viewpointToApi` map local topics/viewpoints to request bodies (client-owned fields only; `default_visibility` always written).

## Evidence

| Suite | Tests | Covers |
|---|---|---|
| `lib/bcf-drafts/draft-model.test.ts` | 5 | Drafts from groups with exact members and bridge viewpoints; split/merge/remove keep a partition and GUIDs; decoder refuses double claims; reconciliation across a newer run with changed model ids; new/claimed/unplaced matches |
| `lib/bcf-drafts/draft-archive.test.ts` | 3 | Real `.bcfzip` bytes: export → import restores batch, GUIDs, members, origin, source, comments and viewpoint; plain-BCF readability; plain and tampered archives import unmapped |
| `lib/bcf-publication/publication.acceptance.test.ts` | 5 | Create/viewpoint/comment receipts and server content; same-batch rerun sends nothing; update keeps server comments/viewpoints; remote edit blocks an update until overwrite; permission, vocabulary and unknown-assignee refusals with nothing sent; revoked token |
| `lib/bcf-publication/publication.recovery.test.ts` | 4 | Lost create → uncertain → dependents wait → rerun sends nothing → check finds committed topic → dependents resume, no duplicate; lost viewpoint/comment responses recovered by GUID/trailer; reload-interrupted write → uncertain → absent check → requeue; backup import blocked, never dispatched, receipts kept, conflicting import forks a blocked copy |
| `lib/bcf-publication/flow-gateway.test.ts` | 2 | Flow write lost response → uncertain, identical rerun refused without sending, token not stored, candidate choice; HTTP refusal is definite |
| `components/viewer/bcf/BCFDraftsDialog.publication.test.tsx` | 2 | Mounted dialog: preflight users, publish with per-topic receipts, unknown-outcome guidance, republish sends nothing, check server, resume; split and merge saved durably |
| Package suites (`opencde-foundation`, `bcf-api`, `flow-nodes`) | 13 | Signal/timeout/headers and refuse-before-fetch; write mapping roundtrip and visibility default; gateway routing, refusal and headless unknown-outcome reporting |

## Remaining limits

- Evidence is from the controlled loopback peer only. Real vendor servers (paging, description length limits, server-side normalisation of owned fields, OAuth refresh, snapshot upload) are not measured.
- Draft topics are created from manual grouping workspaces and checked findings. Drafting from IDS, information/semantic validation, comparisons and the AI grouping preview, language changes and per-topic snapshot images are not implemented.
- Topic deletion or merge does not touch already-published server topics; they are reported as orphaned only in the plan result, not in the UI.
- Update conflicts compare owned fields only; there is no server revision header. A server that rewrites descriptions or labels on save will show as a conflict.
- Resuming queued entries after reload needs the user to publish again; there is no background dispatch.
- Headless Flow hosts (CLI, MCP) have no durable outbox; they report unknown outcomes but cannot block a later rerun.
- No recorded coordinator walkthrough of the dialog exists yet; human UX acceptance remains open.

The peer can be started for recordings using the [testing guide](../contributing/testing.md#local-bcf-publication-peer). Its synthetic token never represents an external account, and shutdown discards all peer data.
