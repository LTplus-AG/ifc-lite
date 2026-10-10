# The model loop (our moat)

No standalone IDS editor can do this, and checkers can't do it at authoring time. Everything here runs in the browser against loaded (federated) models through the existing `IFCDataAccessor` bridge, which already handles units, type inheritance, classifications, materials, ancestors and **property overlays** (unsaved edits).

## 1. Applicability funnel (FR-D01)

**Definition:** for spec S with applicability facets `f1…fn` in display order, the funnel is `|E0|, |E0∩f1|, |E0∩f1∩f2|, …` where `E0` is all elements of the models whose schema matches `S.ifcVersions`.

**Algorithm:**
1. **Order:** keep the user's order and compute each displayed prefix against `E0` using only the facets in that prefix. Reordering evaluation within a prefix is allowed when it preserves that prefix's intersection; a later displayed facet must not prefilter an earlier stage. For example, if a property facet precedes `IfcWall`, its stage still counts matching doors. The final applicable set can reuse the validator's broadphase order, but final-set counts cannot be re-projected into prefix counts. Each intersection is a set of expressIds per model (`Uint32Array`, sorted).
2. **Index reuse:** the `ApplicabilityPropertyIndex` (inverted pset/property/value index) is built once per model set and overlay version, then reused across edits. Property facets with literal names hit the index. Pattern names fall back to scanning the current candidate set.
3. **Incremental:** cache stage results keyed by `(modelSetHash, facetSignature prefix)`. Editing facet k invalidates stages ≥ k only.
4. **Progressive:** for large sets use `yieldEveryMs`. Report `≥ n · counting` while scanning. For > 2M candidates, optionally sample (`maxEntities`) and show `~n ± ci`.
5. **Output:** `{ stages: [{facetId, count, perModel: Record<ModelId,count>}], applicable: Set refs (lazy) }`.

**Requirement preview (FR-D02):** for applicable elements, run the requirement facets with the validator's confirm path. Output pass/fail/NA per requirement facet + spec verdict per IDS cardinality semantics (the same code as validation, so preview ≡ result).

**3D (FR-D03):** clicking a stage dispatches `isolateEntities` / `setGhostExceptEntities` with global IDs resolved via `FederationRegistry`. "Dropped at stage k" = `stage(k-1) \ stage(k)` → isolate shows *why things are excluded*. Colour by verdict via `setPendingColorUpdates` (reuse the IDS colour system in `hooks/ids/*`).

**Budget:** p95 ≤ 300 ms for 100k elements on a mid-range laptop (NFR-02), measured by a benchmark in `tests/benchmark` with real models (AGENTS.md evidence rule).

## 2. Explain (FR-D04)
`explain(spec, element) → Trace`:
```ts
interface Trace {
  applicable: boolean;
  applicabilitySteps: Step[];   // per facet: matched?, actual value(s), source (occurrence|type|inherited), unit conversion
  requirementSteps: Step[];     // per requirement: pass/fail/NA, expected (plain language), actual, reason code
  verdict: 'pass' | 'fail' | 'notApplicable';
}
interface Step { facetId: Uuid; ok: boolean; expected: string; actual: ActualValue[]; reason: ReasonCode; note?: string }
```
- Reason codes reuse `FailureType` / `format-failure-reason.ts` and add authoring-specific ones: `CASE_MISMATCH`, `WHITESPACE`, `UNIT_SCALED`, `FOUND_ON_TYPE`, `WRONG_PSET_SAME_PROP`, `DATATYPE_MISMATCH`, `NOT_IN_ENUM_NEAR(x)`.
- "Near-miss" detection (case/whitespace/near-enum) feeds lint VAL-007 and the explain UI.
- Implemented as an instrumented evaluation of each facet, *not* a second evaluator: the facet functions gain an optional `tracer` parameter (zero cost when absent). Parity test: trace verdict ≡ validator verdict on the whole corpus.

## 3. Infer from selection (FR-D05): "Require what these have"

**Input:** selection `P` (positive examples, ≥1), optional explicit negatives `N`. Default `N` = elements of the same classes as `P` that are not selected (the contrast set), capped and sampled.

**Step A, applicability:**
1. **Entity:** if P's classes are all the same, use that class. Otherwise use the enumeration of the classes; if they share a parent and cover most of its concrete subtypes present in the model, offer the parent's concrete-subtype expansion (never the abstract parent, per lint ENT-001).
2. **PredefinedType:** if constant across P and not constant across the class, propose it.
3. **Discriminators (contrast learning):** find facets that separate P from N. Candidates are (pset, property, value) and (attribute, value), plus classification, material and containment (partOf storey/building). Score each candidate by precision/recall on P vs N (information gain). Propose the best single facet if it reaches ≥95% precision and ≥95% recall, otherwise the best conjunction of ≤2. Example: "IsExternal = FALSE distinguishes your 15 doors from 81 others."
4. If nothing separates them, offer applicability = class (+PDT) only, with an honest note.

**Step B, requirements** (what P has in common):
- For each (pset, property) present on ≥ θ (default 100%, slider) of P:
  - Values constant → `equals`.
  - ≤ 8 distinct string values → `oneOf`.
  - Numeric → `range` [min, max] of P, rounded to sensible precision in model units, displayed in SI. Also offers "≥ min only".
  - Strings with a common structure → `pattern`, via a small pattern synthesiser over token classes (prefix/digits/separators, e.g. `EG-\d{3}`) that is checked against P (must match all) and against N (report how many it matches).
  - Present but heterogeneous → existence-only requirement.
- Attributes (`Name`, `ObjectType`, `Tag`, `Description`) get the same treatment, filtered to meaningful ones.
- Classification references and material names likewise.
- **Ranking:** a candidate's coverage of P (must be ≥ θ) × its *informativeness* (properties that N mostly lacks rank higher: they are "what makes these good") × standardness (standard psets first).

**Step C, output:** an `InferenceResult` with candidate facets, each with stats (`P: 15/15`, `N: 12/81`) and preview counts. Accept → `bulk.fromInference` op. Also exposed to the agent as a tool (`model.infer`), so "write an IDS that matches how *this* model does doors" works.

**Edge cases:**
- Federated selection across models: infer per model and intersect.
- IFC2X3 type/occurrence: use bridge semantics.
- Huge selections: sample P to 5k elements and report it.

## 4. Coverage lens (FR-D06)
- For all loaded models compute `coverage(e) = sum_S 1[e ∈ applicable(S)]`, keyed by model + expressId. Keep each spec's final applicability set from the funnel cache and count one membership per spec; an element matching two specs has coverage 2. On a spec edit, subtract its old memberships and add its new memberships. The union of the final sets answers only whether coverage is nonzero; it cannot supply the count.
- Lens colours: 0 = red ("ungoverned"), 1 = light, ≥2 = darker; overlapping specs with conflicting requirements = purple (lint SPEC-006 evidence).
- Panel: "Ungoverned by class" table (e.g. `IfcFlowSegment 4,210`, `IfcCovering 980`), each row offering "Draft requirements for these" (to infer, or to the agent with context).
- Registers as an ifc-lite **lens** (reusing `packages/lens`), so it shows up next to existing lenses.

## 5. Value suggestions (FR-D07)
- `distinctValues(entitySet, pset, prop) → [{value, count}]` (reuses `properties_unique` logic), shown in pickers and value editors ("from model"), capped at 200 with search.
- Unit-aware for numeric values: shows a histogram and suggests a range.

## 6. Fix-in-place (FR-D08)
- From explain/failure: "Set FireRating to EI60 on these 25" → `packages/mutations` change set, with preview, undo, and export of corrected IFC (existing export path).
- Reuses `IDSCorrectionDialog` semantics. Supersede: the dialog becomes Studio's fix flow, and the old path is removed.

## 7. Worker protocol
```
main → worker: setModels(modelSetHash) | setDoc(docHash, specs delta) | preview(specIds, opts) | explain(specId, ref) | infer(selection, opts) | coverage() | distinct(...)
worker → main: progress(specId, stage, partialCount) | previewResult(...) | ...
```
- **Planned P-05 session lifecycle:** extend the existing `idsValidation.worker.ts` client/protocol rather than add a second worker path. The current `runValidationInWorker` creates and terminates one worker per validation request; it does not implement this stateful protocol. The proposed Studio owner keeps one session for the current model/document context, initializes it with the loaded models' existing source envelopes and overlay snapshots plus the document, and waits for initialization acknowledgments before dependent commands. Hashes identify the snapshots; hashes alone do not populate worker state.
- Model/document/overlay changes invalidate the affected state and advance the generation before more commands run. Cancelled or obsolete command results are discarded. Closing the Studio session or unloading its model context terminates the owned worker and releases retained state. P-05 must qualify initialization, replacement, cancellation, stale-result rejection and teardown before claiming session support or performance.
