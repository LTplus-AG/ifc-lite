---
"@ifc-lite/viewer": minor
---

Add Element tool — instant 3D appearance, off-surface placement, 3D ghost preview.

Three UX-blocker fixes that turn the Add Element tool into a real
authoring surface (previously every drop emitted STEP into the overlay
but the user saw nothing in the 3D scene until export+reparse).

  - **Instant 3D appearance.** Every `add*` action now also builds a
    renderer-frame mesh for the new element and injects it via the
    same `appendGeometryBatch` action `duplicateEntity` uses. Walls,
    beams, and members are oriented thickness-extruded boxes;
    columns, doors, and windows are axis-aligned boxes;
    slabs / roofs / plates / spaces are polygon extrusions (with fan
    triangulation good enough for typical room shapes). Storey
    elevation is read from the spatial hierarchy so multi-storey
    placements drop on the right floor. The new mesh is tagged with
    the federation-aware globalId so picking + selection work
    immediately and the property panel opens on the new entity.
  - **Off-surface placement.** A new
    `raycastStoreyFloor()` helper unprojects the cursor to a ray and
    intersects the storey floor plane (renderer Y =
    `storeyElevation`). The hover preview and click handler both
    fall back to it when the scene raycast misses, so columns can
    drop onto empty floor outside the existing geometry. Snap-to-
    surface still wins whenever there is a mesh under the cursor.
  - **3D ghost preview.** The SVG overlay now projects the about-to-
    commit element's 8 corners (or polygon ring) to screen and
    renders the silhouette via a convex-hull outline. Single-click
    types (column / door / window) show the ghost on hover before
    any clicks; two-click types (wall / beam / member) show it once
    the start point is placed. The ghost reads live per-type form
    params, so adjusting Width / Height / Thickness updates it in
    real time.

Also includes a panel polish: when the active type is `space` an
**Auto Spaces** section appears with snap tolerance, min area,
height, naming pattern, and IfcSpaceTypeEnum settings + Preview /
Generate buttons that drive the wall-graph face finder.
