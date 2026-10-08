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
- **Revision** = immutable snapshot `{ revId, parentRevId, hash(sha256 of canonical XML + sidecar-normative fields), label: draft|review|released, author, at, message }`.
- **Sign-off** = `{ revId, by, role, at, statement }`. Released revisions are read-only, and further edits branch to a new draft.
- Storage: IndexedDB library (local). With the collaboration server: synced. The hash chain makes tampering evident.
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
  expectFailureOn?: Uuid[]; // which requirement facets should fail
}
```

**Synthetic generation** (`@ifc-lite/ids-testgen`, using `@ifc-lite/create`):
- **Pass fixture:** the minimal IFC containing one element satisfying all applicability facets and all requirements. The entity is the first concrete entity; psets/properties get the required values; enumerations take the first value; ranges take the midpoint; patterns take a generated matching string (from the regex synthesiser in reverse, i.e. a string generator for XSD patterns); classification references and materials are created.
- **Fail fixtures:** one per requirement facet, mutating exactly that requirement (missing property, wrong value, wrong dataType, prohibited present).
- **Not-applicable fixture:** violates the first applicability facet.
- Then *validate the fixtures with our own validator*. If the expected verdict doesn't hold, the spec is **untestable or contradictory**, which is a lint finding in itself (SPEC-002/003) ✚.
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
