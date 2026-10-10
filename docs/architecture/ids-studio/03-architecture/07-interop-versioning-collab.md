# Interop, versioning, collaboration, and IDS test suites

## 1. Import / export matrix

| Format | Import | Export | Lossless? | Notes |
|---|---|---|---|---|
| IDS 1.0 XML | ✅ | ✅ | ✅ (canonical `fmt`) | The interchange format |
| IDS 0.9.7 | ✅ (upgrade report) | ❌ | — | Upgrade listing each change |
| `.idsz` bundle (zip: ids.xml + studio.json + fixtures + appendix) | ✅ | ✅ | ✅ incl. sidecar | Plain zip, open spec documented |
| XLSX / CSV | ✅ via mapping (AI-assisted once, then deterministic) | ✅ Studio layout with hidden `_id` columns | ✅ round-trip in Studio layout | Saved mappings; built-in mappings for common public templates (licence-checked) |
| YAML / JSON (human format) | ✅ | ✅ | ✅ | Compatible in spirit with ids-light-editor; schema published |
| HTML / PDF / DOCX "contract appendix" | ❌ | ✅ | n/a | Plain-language specs, tables, glossary, translations, revision and sign-off block, optional QR/link to the IDS |
| BCF (from failures) | — | ✅ (existing) | — | |
| bSDD import JSON (custom psets) | — | later | — | D6 |
| Markdown | ❌ | ✅ | n/a | For READMEs / wikis |

**Readable appendix renderer:**
- Template engine in `ids-interop`; the same plain-language strings as the UI.
- PDF is produced client-side (an existing ifc-lite document/report path if available, otherwise print-to-PDF from HTML; decide in IDS-099).
- DOCX via a docx builder library (MIT/Apache; chosen in the implementing issue).
- Multi-language: one column per language, or one document per language.

## 2. Revisions and sign-off (FR-G06)
- **Planned revision** = immutable snapshot `{ revId, parentRevId, parentHash, hash, label: draft|review|released, author, at, message }`. P-10 must define a canonical digest payload containing the XML, normative sidecar fields, parent revision ID/hash and integrity-sensitive revision metadata (label, author, timestamp, message). Exclude the digest field itself; fix field encoding/order in the contract and test mutations of each covered field.
- **Sign-off** = `{ revId, by, role, at, statement }`. Released revisions are read-only, and further edits branch to a new draft.
- Storage plan: IndexedDB library (local); synchronization belongs to P-10. A content hash alone does not authenticate history links. The planned chain can detect changes relative to a trusted head, but an attacker able to rewrite the whole local store can recompute it; deliberate tampering is detectable only against a trusted head/signature anchored outside that store. This guarantee remains unimplemented/unqualified until P-10 defines the anchor and passes integrity controls.
- The definition library migration imports today's localStorage entries (raw XML, max 100) as rev 1 drafts, then deletes the old store (supersede means delete).

## 3. Diff and merge (FR-G04, FR-G05)
- Algorithm in `02-document-model-and-ops.md` §6.
- UI: side-by-side outline with change markers; plain-language changelog; "accept theirs/ours" per conflict; export the changelog to the appendix.
- CLI: `ifc-lite ids diff a.ids b.ids [--json|--md]`, exit code 1 if different (CI use).

## 4. Comments and co-authoring (FR-G07, FR-G08)
- Comments in the sidecar, keyed by node Uuid; threads, resolve, mentions (names only; no email in analytics).
- Live co-authoring: map `StudioDocument` to a Y.Doc via `@ifc-lite/collab` (Yjs, awareness, IndexedDB, websocket provider) and `collab-server`.
- Each remote change is replayed as ops through the gate locally. Gate rejections from a remote peer (e.g. a different schema-table version) become diagnostics, not silent drops.
- Presence: who is editing which spec; soft locks per field.

## 5. IDS test suites ✚ (FR-G09), "unit tests for information requirements"
**Why:** the IDS corpus itself is a test suite (IDS + IFC + expected verdict). We give every author the same discipline, so a spec is proven to pass on compliant data and fail on non-compliant data before sign-off. This is the strongest answer to "tools disagree / why did it pass?"

**Model:**
```ts
interface TestSuite { specId: Uuid; cases: TestCase[] }
interface TestCase {
  id: Uuid; name: string;
  fixture: { kind: 'synthetic'; recipe: FixtureRecipe } | { kind: 'snapshot'; ifcRef: string; entityRefs: string[] } | { kind: 'file'; path: string };
  expect: 'pass' | 'fail' | 'notApplicable';
  expectFailureOn?: Uuid[]; // requirement failures only; omitted for spec-cardinality failures
}
```

**Synthetic generation** (`@ifc-lite/ids-testgen`, using `@ifc-lite/create`):
- **Required/optional spec pass fixture:** the minimal IFC containing an applicable element satisfying all requirements, with the applicable count satisfying the spec cardinality. The entity is the first concrete entity; psets/properties get the required values; enumerations take the first value; ranges take the midpoint; patterns take a generated matching string (from the regex synthesiser in reverse, i.e. a string generator for XSD patterns); classification references and materials are created.
- **Required/optional spec requirement-failure fixtures:** mutate one requirement at a time (missing property, wrong value, wrong dataType, prohibited requirement present), while retaining applicability and a valid applicable count. Assert the intended requirement failure, not only the overall verdict. If the requirement cannot be independently violated under the applicability constraints, report that limitation rather than claiming a mutation control.
- **Prohibited spec fixtures:** pass with zero applicability matches; fail with at least one match, independently of requirements, which are ignored. Omit `expectFailureOn` for this spec-cardinality failure. CARD-003 can warn about ignored requirements without making the prohibited-spec fixture recipe untestable.
- **Zero-match fixture:** construct no applicability matches where feasible, then derive the expected verdict from spec cardinality: prohibited passes, required fails, and optional/unbounded uses the canonical validator's applicable-count result. Do not label every zero-match case `notApplicable`.
- Then *validate the fixtures with our own validator*. An unexpected verdict first reports a generator, oracle or unsupported-recipe mismatch; it does not establish a contradictory spec. SPEC-002/003 require independent evidence of contradictory requirements/applicability. A valid prohibited spec is not rejected because a requirement-mutation recipe is inapplicable.
- **Limits:** `@ifc-lite/create` emits IFC4. IFC2X3/IFC4X3 fixtures need writer support or a schema-conversion step (IDS-112). Some facets (partOf with complex relations) start as `unsupported` cases, clearly labelled.

**Snapshot fixtures:** "pin this element as a test case" extracts a minimal IFC subset (element + relevant relationships, psets, type, classification, material, spatial parents) from a real model, using the existing export/subset capability where available (IDS-113).

**Running:**
- UI: "Run tests" per spec/doc.
- CLI: `ifc-lite ids test doc.idsz` with JUnit XML output for CI.
- The appendix and bundle include the tests, so receivers can re-run them.

## 6. IDS 1.1 readiness (P-12)
- The internal model is a superset; 1.1 candidate features (extended partOf, translations, spec identifiers, tolerance, numeric simpleValue) sit behind a `ids11Preview` flag.
- The writer emits 1.0 strictly unless the target is 1.1. Lint VER-xxx warns when a 1.1-only feature is used in a 1.0 export.
- Track upstream milestones. When 1.1 is released: a target-version switch plus a `bulk.setIdsVersion` migration.

## 7. Embedding (FR-H04)
- `viewer-embed` + `embed-sdk` gain a Studio mode, using messages from `embed-protocol`:
  - `studio.load({ xml | idsz })`
  - `studio.getIds()`
  - events `studio.changed`, `studio.saved`, `studio.diagnostics`
- CDEs and platforms can embed Studio next to their model viewers. This is a distribution channel; see GTM.
