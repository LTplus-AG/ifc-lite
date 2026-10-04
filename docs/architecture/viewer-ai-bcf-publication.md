# Native BCF publication evidence

The user selected a local test server for publication tests and will review the recorded coordinator workflows. That selection authorizes the local peer; it is not completed UX acceptance. The complete P11/P12 contracts remain in the [program plan](viewer-ai-plan.md).

## Measured initial native contract

The integration suite uses the viewer's `signInWithToken`, `createConnectedClient` and `pullBcfServerProject`, the existing BCF API write methods, and native BCF archive writer/reader. No fetch response is substituted. An independently stateful, loopback-only HTTP peer commits effects, enforces its vocabulary/permission policy, and can drop a response after committing.

| Operation | Evidence | Boundary for the pending outbox |
|---|---|---|
| Topic create | Real HTTP POST; server allocates GUID and author/date | Current native write DTO has no caller-supplied topic GUID/correlation field. A successful receipt can retain the returned GUID; an ambiguous create cannot be matched by title alone. |
| Topic update | Real HTTP PUT retains topic GUID and existing human comments/viewpoints | Client does not expose conditional version headers through this method. Refresh/compare reviewed fields is required where the server cannot offer stronger concurrency. |
| Comment create | Real HTTP POST retains server GUID, author, text and viewpoint reference | A missing response can leave a real comment; no blind resend. Current comment write DTO has no client correlation identifier. |
| Viewpoint create/read | Caller GUID, IFC component identity, camera and clipping planes survive HTTP pull/archive roundtrip | Exact GUID lookup is available; conflict and payload correspondence must still be checked before treating a lookup as a receipt. |
| Vocabulary/permission refusal | Peer rejects unsupported status with 400 and revoked permission with 403, without effects | Use selected project's real extensions/authorization in preparation and recheck at dispatch. The peer's vocabulary is an example, not a universal BCF list. |
| Commit then lost response | Native request rejects while server has one committed effect; no automatic write retry observed | Persist dispatch intent first. Network rejection means uncertain, not absent. Read-only observation does not establish ownership of an uncorrelated create. |
| Repeated equal-title creates | Two explicit creates allocate two distinct GUIDs | Native create is not an idempotent batch mechanism. Saved batch mappings and durable receipts must prevent repeat dispatch. |

The roundtrip references an actual wall in the committed SketchUp `building-architecture.ifc` sample, parsed by the native parser. The viewpoint is a controlled coordination example, not a ground-truth measured clash. These tests establish client/controlled-peer behavior, not full buildingSMART or vendor conformance.

## Remaining acceptance

P11/P12 still require reviewed local drafts, finding/topic mappings, archive batch roundtrips, durable outbox intent/receipts, reload/crash ownership, conflict reconciliation, and connected UI recording. Existing Flow BCF write nodes must share these safeguards when used by assistant workflows; they have not acquired them from this test harness. Remote snapshots, OAuth grants, independent revision headers and vendor-specific correlation/idempotency capabilities require separate evidence. Unsupported capabilities must remain explicit rather than synthesized.

The peer can be started for recordings using the [testing guide](../contributing/testing.md#local-bcf-publication-peer). Its synthetic token never represents an external account, and shutdown discards all peer data.
