# UX specification

## 1. Placement in the viewer
- **New panel `idsStudio`** (group `check`, region `side` by default, can be docked to `bottom` for grid mode), registered via `lib/panels/registry.ts`. It **supersedes** today's `check-authoring/IdsSpecificationEditor.tsx` and the IDS draft review: those flows open Studio with a proposal instead (supersede means delete).
- The **Validation panel** (results) stays the place where reports live. "Edit this IDS" on a loaded IDS opens it in Studio; "Run" in Studio publishes a report there.
- **Layout preset "IDS Studio"**: Studio (left, 420 px), 3D viewport (center), Assistant (right, collapsible), Grid (bottom, collapsible).

## 2. Studio anatomy

```
┌ IDS Studio ─ "Client EIR – Phase 3" ▾ ─ rev 12 (draft) ─ [Run] [Export ▾] [⋯] ┐
│ ⌕ Filter specs…                     IFC4 ▾   ⚠ 3  ⛔ 0  ✓ 41/44 previewed     │
├──────────────────────────────────────────────────────────────────────────────┤
│ OUTLINE                              │ INSPECTOR                              │
│ ▾ ● Walls – fire rating      812→212 │ Property requirement                   │
│   ▾ Applies to                       │ "External walls must state a fire      │
│     ◆ Entity  IfcWall           812  │  rating of EI60 or EI90."              │
│     ◆ Property IsExternal=TRUE  212  │ ─────────────────────────────────────  │
│   ▾ Requires                         │ Property set  [Pset_WallCommon   ▾] ✓  │
│     ◆ R FireRating ∈ {EI60,EI90} 187✓│ Property      [FireRating        ▾] ✓  │
│       25✗                            │ Data type     IfcLabel (from schema)   │
│ ▸ ● Doors – acoustic          96→96  │ Value         ( ) any  (•) one of      │
│ ▸ ⚠ Slabs – load class         0→0   │   [EI60 ×] [EI90 ×] [+ from model ▾]   │
│ ▸ ● Spaces – area             144    │ Cardinality   (•) Required ( ) Optional│
│ + Add specification   ⌘K             │               ( ) Prohibited  ⓘ        │
│                                      │ Instructions  [ … ]                    │
│                                      │ Source        EIR.pdf p.14 ¶3  ↗       │
│                                      │ ⚠ IDSL-VAL-007 Case-sensitive match;   │
│                                      │   12 elements have 'ei60'. [Fix ▾]     │
└──────────────────────────────────────┴────────────────────────────────────────┘
```

- **Outline row**: status dot (●ok ⚠warn ⛔error ○not previewed), cardinality badge (R/O/P), plain-language label, live counts (`applicable→passing`). Hover = funnel tooltip. Click a count = isolate in 3D.
- **Spec header** shows the funnel as a horizontal bar: each applicability facet narrows the count. Each stage is clickable (isolate the elements dropped at that stage = "why are these excluded?").
- **Inspector** = plain-language sentence on top (editable via the assistant: "rephrase"), then technical fields, value editor, cardinality with ⓘ explaining IDS semantics, instructions, source link, diagnostics for this node, comments.
- **XML tab** (inspector toggle): read-only, synced, highlights the selected node's XML.

## 3. Grid mode (power users, Excel natives)
Columns:

| Spec | Section | Facet | Entity/Pset | Name | Value kind | Value | Cardinality | dataType | Instructions | Count | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|

- One row per facet. Spec rows are group headers.
- Multi-cell paste from Excel creates facets through the same ops, with the gate applied. Rejected cells turn red with candidates in the tooltip.
- Fill-down, find/replace (regex), column filters, freeze. Virtualised (react-virtual) for 5k+ rows.

## 4. Key flows

### F1 — New IDS from scratch (no model)
1. `+ New IDS` → choose IFC version(s), title, author (prefilled), purpose.
2. `+ Add specification` → quick-add palette: type "external walls fire rating". Options are a template match, the assistant ("Draft with AI"), or an empty spec.
3. Pick an entity (hierarchy picker, abstract classes greyed with "matches nothing in IDS 1.0; expand to subtypes?").
4. Add a requirement → pset picker filtered to psets applicable to IfcWall → property → value editor.
5. Diagnostics stay green. Export → XML (audited) or the readable PDF.

### F2 — Grounded authoring with a reference model
- A model is loaded, so every spec shows counts. The user adds `IsExternal = TRUE` and sees 812 → 212.
- Clicking 212 isolates those walls in 3D.
- The value picker shows `FireRating` values found in the model: `EI60 (140) · EI90 (47) · ei60 (12) · — missing (13)`.
- Lint `IDSL-VAL-007` notes the case mismatch. One click offers either a pattern `[Ee][Ii](60|90)` or keeping it strict.

### F3 — Require what these have (infer from selection)
1. Select 15 doors in 3D → right-click → **Require what these have**.
2. A Studio side sheet proposes:
   - Applicability: `IfcDoor`, `PredefinedType=DOOR`, contrast-learned `Pset_DoorCommon.IsExternal=FALSE` ("distinguishes your selection from 81 other doors").
   - Requirements: `FireRating ∈ {EI30}` (15/15), `AcousticRating` exists (15/15), `Width 0.9–1.0 m` (bounds, 15/15).
3. Each candidate has a checkbox, a confidence value and a preview count. Accept → op batch.

### F4 — AI draft from a document
1. Drop `EIR.pdf` on the Assistant → "Draft IDS".
2. Progress stream: "Reading 42 pages … found 63 requirement statements … 51 expressible in IDS … resolving names …"
3. Proposal view: specs grouped by source section. Each has the source quote, plain-language text, live counts, and diagnostics (should be none). The **Unresolved (12)** tab lists statements with a category and reason.
4. The user accepts per spec, or edits first, then accepts. The ops land in the document with provenance `ai:<run-id>` and source spans.

### F5 — Explain a failure
- From Validation results or a 3D right-click → **Explain against spec…**
- A trace view shows each facet with ✓/✗, the actual value and unit, and why. Example: "Property FireRating found on the *type* (IfcDoorType 'D-01'), value 'EI 30' — does not match 'EI30' (whitespace)."
- Actions: fix value, relax spec (pattern), open BCF.

### F6 — Test suite & sign-off
1. Spec ⋯ → **Generate tests** → creates a minimal passing IFC and one failing IFC per requirement facet (synthetic), plus optional "pin current selection as fixture".
2. Run tests → green. Revision → **Request sign-off** → reviewer approves → rev 13 released (hash).
3. Export bundle: IDS + PDF appendix + test fixtures zip.

### F7 — Diff two versions
Library → select rev 12 and rev 13 → **Compare**. Side-by-side outline with changed facets highlighted, plus a plain-language changelog ("Doors: FireRating now required (was optional); +2 specs; −1 spec"). The changelog can be exported to the PDF appendix.

## 5. Plain-language rendering rules
- Template per facet × section × cardinality, from `src/translation` (extended), e.g.:
  - Applicability entity: "Applies to **walls** (IfcWall) of type **SOLIDWALL**"
  - Requirement property, required, enumeration: "must have **Fire rating** (Pset_WallCommon) set to **EI60** or **EI90**"
  - Prohibited: "must **not** have …"
  - Optional: "if **Fire rating** is provided, it must be …" (IDS 1.0 optional semantics, with ⓘ)
- Patterns are rendered as an explanation ("text starting with 'EG-' followed by 3 digits") when the regex explainer is confident, otherwise shown verbatim with a "test it" box.
- Units: values are stored in SI. Display uses the project unit when a model is loaded ("2.4 m (2400 mm in this model)").

## 6. Diagnostics UX
- Severity icons: ⛔ error (blocks export), ⚠ warning, ⓘ info.
- Each diagnostic shows its code, message, location, "why this matters" (expandable), and quick-fix buttons (each an op batch with a preview).
- "Suppress for this spec…" requires a reason, which is stored in the sidecar.

## 7. Keyboard
- `⌘K` palette (all ops); `N` new spec; `A`/`R` add applicability/requirement facet on the selected spec.
- `↑↓` outline, `→←` expand/collapse; `⌘Z/⇧⌘Z`; `⌘E` export; `⌘/` toggle XML; `⌘I` isolate the selected spec's applicable elements; `⌘J` assistant.

## 8. Empty, loading and error states
- No model: counts read "—" with the tooltip "Load a model to preview"; the coverage lens is disabled.
- Large model: progressive counts ("≥ 12,000 · counting…") using `yieldEveryMs`.
- bSDD offline: a picker banner says so and shows cached results only.
- AI unavailable: the assistant entry points explain how to add a key or use the free tier.
