# Viewer AI linked-records assistance (P16)

Assistant proposals for semantic queries, IFC-to-ontology mappings, record projections and extracted requirements, with source spans, endpoint grants and revision pins (issue #6920, charter #6812). The user-facing description is in the [assistant guide](../guide/viewer-assistant.md#linked-records-assistance); this page records the contracts and what proves them.

## Contracts

All four kinds are strict, versioned JSON (`apps/viewer/src/lib/semantic/assist/`): a complete object, optionally fenced, `"version": 1`, a short title and no unknown keys. Prose never reaches the parsers, and a refusal states why.

| Kind | Reviewed against | Executes or writes |
|---|---|---|
| `semantic.query` | `@ifc-lite/semantic` `inspectReadOnlyQuery`: SELECT or CONSTRUCT, no SERVICE, no unauthorised FROM, declared columns equal the outer projection, outer LIMIT 1 to 5000 | Only on **Run query**, only with the endpoint grant the user exercised in the Linked records panel |
| `semantic.mapping` | Live element count per class in the model associated with the proposal's revision, the profile (profile key, external IRI or unknown), the captured passages | Only **Save** of approved rows, into the `semanticReviews` library |
| `semantic.projection` | `previewProjection` of the existing projection service (record, product, class, unit, conflict policy, edit gate) | Only **Apply** of approved rows through `applyProjection` (one undo step); a stale plan is refused |
| `semantic.requirements` | Every span against the passages frozen into the conversation's evidence | Only **Save**, with each span's verification result |

`inspectReadOnlyQuery` shares its parse and read-only walk with `assertReadOnlyQuery`, so the lint cannot accept what the provider would refuse. The inner LIMIT of a subquery never satisfies the outer bound.

## Source spans

An attached text is cut into passages of at most 500 UTF-16 code units, paragraph by paragraph, never inside a surrogate pair. Each passage is an evidence row with its exact `start` and `end` offsets. A span names a source (`S1`..), offsets and a quote. It verifies only when the captured text at exactly those offsets equals the quote. Otherwise it is `mismatch` (the card shows what the source says there; a unique occurrence of the quote is offered only as a hint, never applied) or `not-captured` (the offsets lie outside every passage the assistant saw, or the source was not attached). Verification reads the evidence payload of the conversation, not the live text, so editing the text later cannot make an old answer look verified.

## Endpoint grants

The Linked records panel records the authority a load or **Query selected** exercised (endpoint, hostname, optional loopback origin, relay, credential) in session memory (`endpoint-grant.ts`). Changing the source, hostname, relay, credential or mode, restoring or importing a workspace, unchecking the loopback grant, or unmounting the panel revokes it, which also aborts a pending assistant query. The assistant evidence carries only `endpointGrant: "available" | "none"`. The review card shows the endpoint and grants but never the credential, and the credential is used only as the request `Authorization` header by the existing provider, which also enforces the hostname grant.

## Storage and bundle

`semanticReviews` is a registered content kind, so reload, backup and import work. Its eager decoder checks only the envelope and the review decisions; the proposal is stored as opaque JSON and the strict proposal decoders (`review-validate.ts`) run when the Linked records panel lists a review. A review that no longer passes is kept unchanged and counted as unreadable, never dropped. The English strings register through `registerEnglish` when the Linked records or Assistant chunk loads (their keys are typed in `en.ts`). Both keep P16 out of the eager bundle that the perf-ratchet gate measures.

## Revisions and independent records

A mapping or a query result carries a revision pin: the revision associations in force and each loaded model's source fingerprint. It is current only while the same revisions map to the same loaded sources; otherwise it is labelled historical and is not re-resolved silently. Linked records stay independent of IFC: nothing here writes the session's records, and projection writes only the declared property plus its provenance property set, as before.

## Proof

Deterministic tests (seeded generators, the authored pilot model, a recording transport; no network):

- `spans.test.ts`: offsets reproduce the text for eight seeded specifications, passages stay within 500 characters, no split surrogate, spans verify across passage breaks, and forged payload rows are dropped.
- `proposals.test.ts`: strict parsing per kind, structural span checks, the lint refusals.
- `semantic-assist.test.tsx`: no endpoint, relay or credential in assistant evidence, the credential only in the request header, a lint-failing proposal never reaches the transport, a foreign host is refused before any request, pinned revisions turn historical, mapping approvability, projection through the native service.
- `SemanticProposalReview.test.tsx` and `SemanticAssistControls.test.tsx`: the mounted cards, saving, backup round trip, and grant revocation for each way the panel can change.

Mutation checks that each break one of these tests: add the endpoint to the evidence, skip the query lint, accept a span without comparing the quote, ignore span issues when approving, drop the revision associations from the pin identity, keep the grant when the source changes, enable **Run query** without a grant, enable a blocked mapping.

## Not covered

No real provider answer or live endpoint was used; the screenshots use a seeded conversation. Requirements are extracted and saved, but nothing yet turns them into an IDS or validation run. Mappings are saved, not applied: applying them to a profile is a later step.
