# ifc-lite asset inventory (what we already own)

Snapshot of `LTplus-AG/ifc-lite`, October 2026. Paths are relative to the repo root.

## Verdict
Most IDS tools have to build their IDS engine from scratch; we already own a conformance-tested one. **The missing piece is the authoring product** (`docs/guide/viewer-assistant.md`: "The viewer has no IDS editor"), plus a handful of engine gaps.

## 1. IDS engine — `packages/ids` (`@ifc-lite/ids`, TypeScript)

| Capability | Where | State |
|---|---|---|
| Parser (IDS 1.0; accepts 0.9.7 `<dataType>` child) | `src/parser/xml-parser.ts`, `parse-restriction.ts` | ✅ |
| Validator: broadphase on first filterable facet → inverted pset/value index → boolean confirm; `maxEntities`, `onProgress`, `yieldEveryMs`, `includePassingEntities` | `src/validation/validator.ts`, `property-index.ts` | ✅ Ideal for live previews |
| Facets: entity (predefined type, IFC2X3 type mapping), attribute, property (dataType), classification, material, partOf | `src/facets/*` | ✅ |
| Constraints: simple, pattern (XSD→JS regex, ReDoS guard), enumeration, bounds, length, digits; XSD casting/datetime; EXPRESS base mapping | `src/constraints/*` | ✅ |
| Data accessor bridge: units/SI, classification walk, type-inherited psets, materials, ancestors, **property overlays (unsaved edits)**, visibility | `src/bridge/*` (`@ifc-lite/ids/bridge`) | ✅ Mirrors ifctester semantics |
| Conformance corpus: 334 buildingSMART cases (187 pass / 120 fail / 27 invalid) | `src/__corpus__/buildingsmart-ids/`, `corpus.test.ts` | ✅ 307/307 pass+fail agree. ⚠️ **Audit detects only 6/27 invalid**; 21 listed in `AUDIT_UNDETECTED` (may only shrink) |
| ifctester parity set | `src/__corpus__/ifctester-parity-6117/`, `scripts/test-ids-corpus.mjs` | ✅ |
| Document auditor: XSD rules in TS, structural, coherence, IFC-schema checks | `src/audit/{xsd,structural,coherence,ifc-schema}` | ✅ / ⚠️ coverage gap above |
| Translations en/de/fr + `describe-constraint.ts` (human-readable facets) | `src/translation/*` | ✅ Basis for plain-language rendering. Add **it** (Swiss market) |
| Report types shared with rules | `src/report-types.ts`, `report-guards.ts` | ✅ |

## 2. Writer / conversion — `packages/rules/src/ids`
- `writeIdsXml(IDSDocument)`: every facet, dataType, cardinality, instructions, simple/pattern/enumeration/bounds. **Refuses** length/digit restrictions and conjunctive restriction facets (`unwritable()` → throw). Oracle: every pass/fail corpus case written and read back gives the same verdicts (`ids-export-oracle.test.ts`).
- `idsToRuleSet` / `ruleSetToIds`: two-way conversion with explicit refusals.
- ⚠️ The writer lives in `rules`, not `ids`. For authoring it belongs in `@ifc-lite/ids` (ADR-005).

## 3. Schema knowledge
- **`packages/data/src/ifc-schema/`**: generated from the IDS-Audit-tool SchemaInfo. Per-version tables (IFC2X3, IFC4, IFC4X3, IFC4X3_ADD2):
  - entities with parent, abstract flag, `predefinedTypes`, attributes, `typeEntity`;
  - psets with `applicableEntities`, and properties with kind, dataType and enumeration values;
  - partOf relations, attributes, data types with XSD backing.
  - Totals: 771/932/1008 entities; 1,485 psets / 7,624 properties overall.
  - API: `findEntity`, `getPropertySets`, `findPropertySet`, `getInheritanceChain`, `isEntitySubtypeOf`, `expandTypeNamesToDescendants`, `getAttributes`, `getDataTypes`, `getAttributeXsdTypes`, `RESERVED_PSET_PREFIXES` …
  - ⚠️ Qto tables exist only for IFC4X3 (115). IFC2X3/IFC4 have none.
- `packages/codegen`: full EXPRESS registry per schema (typed attributes, enums, selects), `schema-hierarchy`.
- Viewer duplicates: `apps/viewer/src/lib/ifc4-pset-definitions.ts`, `ifc4-qto-definitions.ts`. Candidates for supersede-and-delete once the Studio uses `@ifc-lite/data`.

## 4. bSDD
- SDK client `packages/sdk/src/namespaces/bsdd.ts`: `fetchClassInfo`, `fetchClassByUri`, `searchRelatedClasses`, `search`, `getPropertySets`, `getQuantitySets`, `getEntityAttributes`. LRU/TTL cache, configurable `apiBase`. Types include allowedValues, units, dataType, propertySet.
- Viewer: `services/bsdd.ts` via the `/api/bsdd` proxy (Vite dev proxy + Vercel rewrite); `components/viewer/properties/BsddCard.tsx` (add a bSDD property in one click).
- `packages/semantic/src/bsdd.ts` (`profileFromBsdd`). MCP `bsdd_search|class|property_sets|match`. CLI `ifc-lite bsdd`.
- ⚠️ **Not wired to IDS at all.**

## 5. Viewer (apps/viewer)
- React 19, Zustand 5 (~80 slices), Vite, Tailwind 4, Radix, CodeMirror, react-virtual, resizable panels, ECharts, WebGPU renderer (`packages/renderer`).
- Panel registry `lib/panels/registry.ts` + `renderPanelBody.tsx`. Adding a panel needs an id, registry entry, body case, i18n catalogue, teardown file and tests.
- Validation panel (`components/viewer/validation/ValidationPanel.tsx`) with IDS / Information rules / Manual tabs. IDS results UI: `IDSPanel*`, `IDSCorrectionDialog` (bulk fix), `IDSExportDialog` (BCF), report export. State: `store/slices/idsSlice.ts`. Worker: `workers/idsValidation.worker.ts`. Headless: `lib/validation/run-ids-check.ts`.
- Definition library `lib/validation/definition-library.ts` (localStorage, max 100, raw XML) → to be upgraded to revisions.
- Existing AI drafting: `lib/check-authoring/*` (`IdsProposal` ≤50 specs, unit declarations, `dry-run.ts`), UI `components/viewer/check-authoring/*` (`IdsSpecificationEditor.tsx` edits only name, cardinality and simple values).
  - The assistant answers with JSON proposals and does **not** use tool calling today. Proposal kinds include `ids.specifications` and `rules.proposal`.
  - Recorded-response CI harness: `lib/assistant/ai-eval-replay.test.ts` + `tests/ai-eval/recordings`.
- Rules editor (`RuleSetEditor*`, `RuleBlockEditor`, `SubjectPicker`) is the closest mature structured-editor pattern.
- Selection footgun (`apps/viewer/AGENTS.md`): highlight is driven only by `selectedEntityIds` / `setSelectedEntityId(globalId)`.
- Visibility: `isolateEntities`, `setGhostExceptEntities`, `setClassFilter`; colour: `setPendingColorUpdates`; federation: `FederationRegistry` / `resolveEntityRef`.
- LLM: `lib/llm/*` (Anthropic + OpenAI BYOK, free models via proxy, prompt cache, usage quota, receipts, repair loop); `packages/ai` (provider-independent request core); server `api/chat.ts`.
- Privacy: PostHog scrub. Never log pset or property names, file names or free text.

## 6. Query / data
- `packages/query`: fluent `IfcQuery`, IfcOpenShell selector syntax, DuckDB SQL, `pset-lookup.ts`.
- `entityIndex.byType` O(1) type lookup. MCP `count_entities`, `query_entities`, `properties_unique`.

## 7. Other reusable packages
- `packages/bcf` (`createBCFFromIDSReport`, cameras), `bcf-api` (OpenCDE).
- `packages/mutations` (change sets, CSV match, bulk attribute actions) → fix-in-place.
- `packages/create` (`IfcCreator`: IFC4 STEP from scratch, elements, psets, quantities, materials) → **synthetic IDS test fixtures**.
- `packages/collab` (Yjs CRDT, undo manager, awareness, IndexedDB, websocket) + `collab-server` → co-authoring.
- `apps/viewer-embed`, `packages/embed-sdk`, `embed-protocol` → embeddable Studio.
- `packages/mcp` (`ids_validate`, `ids_explain`, `model_audit`), `packages/cli` (`ids`, `delivery`, `bsdd`), `packages/sdk` (`bim.ids.*`).

## 8. Conventions that shape the plan (from AGENTS.md)
- Repository default: a PR closes a `ready` issue and sweeps need a charter. The recorded D8 exception for this campaign uses approved backlog IDs in PR bodies; maintainer escape-label admission still applies. One defect class per PR and stacks above ~1,500 changed lines remain.
- User-visible claims need evidence: a real model from a real authoring tool, an oracle run or a screenshot.
- No `as any` / `@ts-ignore` / silent `catch {}`; production modules ≤ ~400 lines (enforced).
- New features ship tests; MPL-2.0 header on new source files in the extension scope defined by `scripts/lib/license-header.mjs` (Markdown is outside that header gate); changesets + `pnpm api-surface:update` for published API.
- Docs updated in the same PR; snippets typechecked; generated doc regions.
- Supersede means delete. No legacy fallback paths.
- Exact IFC EXPRESS names everywhere; never invent aliases.
- Public repo: no client, customer, prospect or partner organisation names, commercial relationships or private strategy in code, docs, commits or PRs. Published technology/framework references are distinct from commercial counterparties (AGENTS.md).

## 9. Engine gaps the plan must close
| Gap | Backlog |
|---|---|
| Writer refuses length/digit/conjunctive restrictions | IDS-001, IDS-002 |
| Writer lives in `rules` | IDS-003 |
| Audit detects 6/27 invalid cases | IDS-004…IDS-008 |
| No Qto tables for IFC2X3/IFC4 | IDS-009 |
| No stable node IDs in `IDSDocument` (needed for ops, diff, comments, provenance) | IDS-016 |
| Audit ignores conjunctive restriction siblings | IDS-010 |
| No `it` locale | IDS-011 |
| No `ifc-lite ids audit`, no MCP `ids_audit` / `ids_write` | IDS-115, IDS-118 |
| Assistant has no tool-calling loop | IDS-075…IDS-085 |
