---
"@ifc-lite/viewer": minor
---

Raw STEP tab — drill into `#N` references and a tighter dev-leaning
visual treatment.

**Reference drill-through**
  - Each `#N` token in the Raw STEP card is now a clickable chip.
    Click → drills into the target entity and shows its positional
    arguments inline; the breadcrumb at the top of the card tracks
    the path back to the 3D-selected entity.
  - **Auto-skip wrappers** — when the click target itself has only
    a single positional arg and that arg is also a `#N`, the card
    follows the chain in one click and lands on the first
    "meaningful" entity. Capped at 16 hops to defend against
    cyclic STEP graphs. So a real-world case like
    `IfcRelDefinesByProperties → IfcPropertySet` steps cleanly,
    and pure pass-through wrappers don't waste user clicks.
  - Drill state resets when the 3D selection changes — drilling
    stays scoped to a single click. Each breadcrumb segment is
    clickable to jump back to that depth.
  - Editing a `#N` ref still works via the pen icon — clicking the
    chip itself navigates instead of entering edit mode, but the
    hover-revealed pen still flips to inline-edit so a user can
    re-type the reference target.
  - Tombstoned entities short-circuit the auto-follow so the drill
    doesn't render a deleted entity's body.

**True STEP literals on display**
  - Tokens are read directly from the source bytes via a new
    `extractRawStepTokens` helper, so refs render as `#42`, enums
    stay `.AREA.`, and strings keep their on-disk quoted form. The
    EntityExtractor's parsed JS shape strips reference prefixes
    (it parses `#42` into the integer `42`), so the previous
    formatter had no way to recover the distinction — `OwnerHistory`
    would render as `18` instead of `#18`. Fixed.
  - Overlay overrides serialize back through `serializeStepToken`
    for parity with the unmodified base tokens.

**Overlay-aware row display**
  - Edits to positional attributes now reflect immediately in the
    row body. Previously the card re-extracted from the source
    buffer and ignored the overlay map, so the displayed value
    snapped back to the original after Save (only the purple
    overlay-override dot updated correctly).

**Dev-leaning tab styling**
  - Raw STEP tab restyled — replaces the "Raw" plain-text label
    with a `</>` bracket glyph, shrinks the trigger to icon-only
    width via `flex: 0 0 auto`. Frees up width so Properties /
    Quantities / bSDD keep their text visible at the default
    panel size, and signals "developer view" with a terminal-green
    accent on hover / active state.

**Add-Column UI removed**
  - The original `AddColumnDialog` + context-menu "Add column
    here…" + EditToolbar "Column" button — premature for the
    current workflow (single hard-coded element type with no
    geometry preview). Removed cleanly:
    `AddColumnDialog.tsx` (deleted), the `addColumnDialog` slice
    state, the constructive `MenuItem` tone (only used by that
    item), and the context-menu / toolbar entry points.
  - Kept: the `addColumn` slice action and the
    `bim.store.addColumn` SDK surface — those still drive scripts
    and programmatic flows, just no UI affordance for now.

**Tombstoned mesh actually disappears**
  - Delete entity now pairs the overlay tombstone with
    `hideEntity(globalId)` so the rendered mesh is hidden from the
    GPU buffers (and stops being pickable). Undo of `DELETE_ENTITY`
    pairs `restoreFromTombstone` with `showEntity` so the entity
    returns to the scene; redo re-hides. Symmetrical round-trip.
