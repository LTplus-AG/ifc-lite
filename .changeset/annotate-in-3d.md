---
"@ifc-lite/viewer": minor
---

Annotate-in-3D — drop pins on the scene with notes.

Press `P` (or pick the new `MapPin` button on the main toolbar),
click anywhere in the 3D scene, type a note. A pin lands at the
world point you clicked on, persists to localStorage, and re-anchors
itself as you orbit / pan. Pins are 14px amber dots with a
1-character glyph (numbered ≤ 9, dot beyond), drop shadow, idle-pulse
on first paint (respects `prefers-reduced-motion`), emerald selection
ring matching the existing constructive accent.

Flow:
  - `P` toggles the Annotate tool. Toolbar gains a `MapPin` button
    with an amber active-tone, distinct from the primary blue used
    for Select / Walk / Measure / Section.
  - Cursor switches to crosshair while annotating.
  - Click → raycast into the scene → on hit, an inline note input
    drops at the click site with a guiding "What's worth noting?"
    label and the entity context inline (e.g. `· IfcSlab #2036`).
    Misses are silent — annotations are anchored to surface points
    by design, not floating in space.
  - `Enter` saves, `⇧Enter` newline, `Esc` cancels. Outside-click
    saves a non-empty draft and silently cancels an empty one.
  - Click an existing pin → popover with note + relative time +
    pen / trash icons. Edit mode mirrors the drop-input treatment.
  - Tool stays active across drops so you can drop several pins
    in sequence.

Architecture:
  - New `annotationsSlice` — Map-keyed store (`begin/commit/cancel
    Draft`, `update`, `remove`, `select`, `clearAll`). Notes are
    clamped at 2000 chars, soft-warned at 200. Persists to
    `ifc-lite:annotations:v1` in localStorage and survives a fresh
    slice instantiation. Covered by 9 unit tests.
  - New DOM-billboard overlay (`AnnotationLayer`) sitting on top of
    the WebGPU canvas. A single rAF loop re-projects every pin's
    world position to screen via `cameraCallbacks.projectToScreen`,
    skipping `setState` when nothing changed (so the loop is cheap
    when the camera is still). Pointer-events: none on the wrapper
    so empty space passes through to canvas controls; pins +
    popover opt back into pointer events explicitly.
  - `AnnotationPin`, `AnnotationPopover`, `AnnotationDropInput` —
    composable components, all amber-accented, edge-clamped,
    backdrop-blurred where it matters.

Pins are NOT IFC entities — they live alongside the model as an
authoring overlay. Future PRs will wire BCF round-trip and
IfcAnnotation export, plus an annotations-list panel and category
tags.
