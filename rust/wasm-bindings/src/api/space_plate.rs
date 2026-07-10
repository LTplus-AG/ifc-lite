// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! WASM API: `SpacePlateHandle` — a **stateful** handle over the persistent
//! space-topology DCEL (`ifc_lite_geometry::space_dcel::SpacePlate`).
//!
//! Unlike the rest of this crate's coarse, stateless batch calls
//! (`processGeometryBatch` etc.), the interactive space editor needs to drive
//! per-frame edits against a topology that **lives across calls**. So this
//! exports an owning handle: build once from wall-axis segments, then call
//! `dragVertex` / `splitFace` / `mergeFaces` on the same object, each returning
//! only the faces it changed.
//!
//! ## Lifetime — call `.free()` explicitly
//!
//! wasm-bindgen gives the JS object a generated `.free()`. The `SpacePlate`
//! owns Rust-side `Vec`s on the shared dlmalloc heap; **do not** rely on JS GC
//! to reclaim it (the FinalizationRegistry fires nondeterministically, and a
//! long-lived handle that outlives its model is exactly the heap-corruption
//! footgun seen in the cache-load crash fix). The TS owner must `free()` the
//! handle when the sketch session ends.
//!
//! ## Wire format
//!
//! Segments cross the boundary as flat arrays to stay allocation-light:
//! `segCoords = [ax, ay, bx, by, …]` (4 f64 per segment) and one `i32` per
//! segment in `segSources` (`-1` = no source element). Edit ops return arrays
//! of `{ face, area, simple, outline }` via `serde-wasm-bindgen`; `outline` is
//! `[[x, y], …]` with no repeated closing vertex.

use ifc_lite_geometry::space_dcel::{
    BuildOptions, EditError, FaceId, FacePatch, HalfEdgeId, InputSegment, SpacePlate, VertexId,
};
use serde::Serialize;
use wasm_bindgen::prelude::*;

/// Hard DoS ceiling on arrangement input size. The T-junction resolve is ~O(n^2)
/// after the per-sweep-splits fix; these bounds keep even adversarial input to a
/// few seconds while sitting far above any real floor plan (hundreds of walls).
const MAX_INPUT_SEGMENTS: usize = 16384;
const MAX_INPUT_RECTS: usize = 4096;

/// One face returned to JS after a build or an edit.
#[derive(Serialize)]
struct FacePatchJs {
    face: u32,
    area: f64,
    simple: bool,
    /// CCW outline `[[x, y], …]`, no repeated closing vertex.
    outline: Vec<[f64; 2]>,
}

impl From<FacePatch> for FacePatchJs {
    fn from(p: FacePatch) -> Self {
        FacePatchJs { face: p.face.0, area: p.area, simple: p.simple, outline: p.outline }
    }
}

/// One bounding half-edge of a face, with the IFC element it came from
/// (`source = null` for a user-drawn partition). Raw material for
/// `IfcRelSpaceBoundary` at bake.
#[derive(Serialize)]
struct BoundaryJs {
    edge: u32,
    source: Option<u32>,
}

/// A persistent, editable floor-plate topology. See the module docs.
#[wasm_bindgen]
pub struct SpacePlateHandle {
    inner: SpacePlate,
}

#[wasm_bindgen]
impl SpacePlateHandle {
    /// Build a plate from flat wall-axis segments.
    ///
    /// `segCoords`: `[ax, ay, bx, by, …]` (length a multiple of 4).
    /// `segSources`: one `i32` per segment, `-1` for none.
    /// `segHalfThickness`: one `f64` per segment — half the wall's thickness in
    /// metres, carried onto the derived edges for `netOutline`. Pass an empty
    /// array (or all zeros) when thickness is unknown (centreline only).
    /// `snapTolerance` / `minArea`: pass `<= 0` to take the defaults.
    #[wasm_bindgen(constructor)]
    pub fn new(
        seg_coords: &[f64],
        seg_sources: &[i32],
        seg_half_thickness: &[f64],
        snap_tolerance: f64,
        min_area: f64,
    ) -> Result<SpacePlateHandle, JsValue> {
        if !seg_coords.len().is_multiple_of(4) {
            return Err(JsValue::from_str(
                "segCoords length must be a multiple of 4 (ax, ay, bx, by per segment)",
            ));
        }
        let n = seg_coords.len() / 4;
        if n > MAX_INPUT_SEGMENTS {
            return Err(JsValue::from_str(
                "too many wall segments for the space-plate arrangement",
            ));
        }
        if seg_sources.len() != n {
            return Err(JsValue::from_str(
                "segSources length must equal the segment count (segCoords.len / 4)",
            ));
        }
        if !seg_half_thickness.is_empty() && seg_half_thickness.len() != n {
            return Err(JsValue::from_str(
                "segHalfThickness must be empty or have one entry per segment",
            ));
        }
        let segments: Vec<InputSegment> = (0..n)
            .map(|i| {
                let o = i * 4;
                let src = seg_sources[i];
                let half = seg_half_thickness.get(i).copied().unwrap_or(0.0);
                InputSegment::new(
                    [seg_coords[o], seg_coords[o + 1]],
                    [seg_coords[o + 2], seg_coords[o + 3]],
                    if src < 0 { None } else { Some(src as u32) },
                )
                .with_half_thickness(half.max(0.0))
            })
            .collect();
        let defaults = BuildOptions::default();
        let opts = BuildOptions {
            snap_tolerance: if snap_tolerance > 0.0 { snap_tolerance } else { defaults.snap_tolerance },
            min_area: if min_area > 0.0 { min_area } else { defaults.min_area },
        };
        Ok(SpacePlateHandle { inner: SpacePlate::build(&segments, opts) })
    }

    /// FACE-BASED build: rooms are the gaps between wall footprint rectangles.
    /// `rectCoords` is flat `[x0, y0, x1, y1, x2, y2, x3, y3, …]` — 8 f64 per wall
    /// (its 4 plan-rectangle corners, CCW). A bounded arrangement face is a room
    /// only if its centroid is outside every rectangle (a gap, not a wall
    /// interior). The room outline IS the net (inner-face) area; `gapBoundary`
    /// gives the centre axis (½ thickness) and the gross outer face.
    #[wasm_bindgen(js_name = fromWallRects)]
    pub fn from_wall_rects(rect_coords: &[f64], snap_tolerance: f64, min_area: f64) -> Result<SpacePlateHandle, JsValue> {
        if !rect_coords.len().is_multiple_of(8) {
            return Err(JsValue::from_str(
                "rectCoords length must be a multiple of 8 (4 corners × x,y per wall)",
            ));
        }
        let rects: Vec<[[f64; 2]; 4]> = rect_coords
            .chunks_exact(8)
            .map(|c| [[c[0], c[1]], [c[2], c[3]], [c[4], c[5]], [c[6], c[7]]])
            .collect();
        if rects.len() > MAX_INPUT_RECTS {
            return Err(JsValue::from_str(
                "too many wall rects for the space-plate arrangement",
            ));
        }
        let defaults = BuildOptions::default();
        let opts = BuildOptions {
            snap_tolerance: if snap_tolerance > 0.0 { snap_tolerance } else { defaults.snap_tolerance },
            min_area: if min_area > 0.0 { min_area } else { defaults.min_area },
        };
        Ok(SpacePlateHandle { inner: SpacePlate::build_from_wall_rects(&rects, opts) })
    }

    /// Face-based gap-room boundary as flat `[x0, y0, …]`: each edge pushed
    /// OUTWARD (into the wall) by `factor × the source wall's half-thickness`.
    /// `0` → net (the gap / inner faces); `1` → centre axis (½ thickness, the
    /// editable node line on the wall mid); `2` → gross outer face.
    #[wasm_bindgen(js_name = gapBoundary)]
    pub fn gap_boundary(&self, face: u32, factor: f64) -> Vec<f64> {
        self.inner
            .gap_boundary(FaceId(face), factor)
            .into_iter()
            .flat_map(|p| [p[0], p[1]])
            .collect()
    }

    /// Number of live rooms.
    #[wasm_bindgen(getter, js_name = roomCount)]
    pub fn room_count(&self) -> usize {
        self.inner.room_count()
    }

    /// Deep-copy the plate for an undo/redo snapshot. The clone owns its own
    /// heap; the caller must `.free()` it like any handle.
    #[wasm_bindgen(js_name = duplicate)]
    pub fn duplicate(&self) -> SpacePlateHandle {
        SpacePlateHandle { inner: self.inner.clone() }
    }

    /// Face ids of every live room.
    #[wasm_bindgen(js_name = roomIds)]
    pub fn room_ids(&self) -> Vec<u32> {
        self.inner.rooms().map(|f| f.0).collect()
    }

    /// All live rooms as `{ face, area, simple, outline }` patches.
    #[wasm_bindgen(js_name = snapshot)]
    pub fn snapshot(&self) -> Result<JsValue, JsValue> {
        let rooms: Vec<FacePatchJs> =
            self.inner.room_patches().into_iter().map(Into::into).collect();
        to_js(&rooms)
    }

    /// Absolute area (m²) of a face.
    #[wasm_bindgen(js_name = faceArea)]
    pub fn face_area(&self, face: u32) -> f64 {
        self.inner.face_area(FaceId(face))
    }

    /// Flat outline `[x0, y0, x1, y1, …]` of a face (no repeated closing vertex).
    #[wasm_bindgen(js_name = faceOutline)]
    pub fn face_outline(&self, face: u32) -> Vec<f64> {
        self.inner
            .face_outline(FaceId(face))
            .into_iter()
            .flat_map(|p| [p[0], p[1]])
            .collect()
    }

    /// The face outline offset to a wall boundary, as flat `[x0, y0, …]`: each
    /// edge is moved by its own wall's half-thickness — inward when `inset`
    /// (the net / inner face), outward otherwise (the gross / outer face).
    /// Shared room↔room edges are pinned when pushing outward. Falls back to the
    /// centreline outline when no offset applies — so it's always a sane ring.
    /// (For a `center` boundary just use `faceOutline`.)
    #[wasm_bindgen(js_name = netOutline)]
    pub fn net_outline(&self, face: u32, inset: bool) -> Vec<f64> {
        self.inner
            .net_outline(FaceId(face), inset)
            .into_iter()
            .flat_map(|p| [p[0], p[1]])
            .collect()
    }

    /// Nearest live vertex id to `(x, y)` within `tol`, or `undefined`.
    #[wasm_bindgen(js_name = findVertexNear)]
    pub fn find_vertex_near(&self, x: f64, y: f64, tol: f64) -> Option<u32> {
        self.inner.find_vertex_near(x, y, tol).map(|v| v.0)
    }

    /// The room on the far side of a half-edge (its twin's face), or
    /// `undefined`. O(1) — the "who's across this wall" query.
    #[wasm_bindgen(js_name = neighborAcross)]
    pub fn neighbor_across(&self, edge: u32) -> Option<u32> {
        self.inner.neighbor_across(HalfEdgeId(edge)).map(|f| f.0)
    }

    /// Bounding half-edges of a face paired with their source element —
    /// `[{ edge, source }, …]` — for `IfcRelSpaceBoundary` at bake.
    #[wasm_bindgen(js_name = boundingElements)]
    pub fn bounding_elements(&self, face: u32) -> Result<JsValue, JsValue> {
        let v: Vec<BoundaryJs> = self
            .inner
            .bounding_elements(FaceId(face))
            .into_iter()
            .map(|(e, source)| BoundaryJs { edge: e.0, source })
            .collect();
        to_js(&v)
    }

    /// Set a face's floor / ceiling planes (the vertical dimension that turns a
    /// 2D face into a prismatic space at bake).
    #[wasm_bindgen(js_name = setFaceHeight)]
    pub fn set_face_height(&mut self, face: u32, floor_z: f64, ceiling_z: f64, non_planar: bool) {
        self.inner.set_face_height(FaceId(face), floor_z, ceiling_z, non_planar);
    }

    /// Move a vertex; returns the rooms it changed. A shared wall is one edge
    /// whose endpoints are shared vertices, so one drag updates both rooms.
    #[wasm_bindgen(js_name = dragVertex)]
    pub fn drag_vertex(&mut self, v: u32, x: f64, y: f64) -> Result<JsValue, JsValue> {
        let patches = self.inner.drag_vertex(VertexId(v), x, y).map_err(edit_err)?;
        patches_to_js(patches)
    }

    /// Subdivide a face with a partition between two of its vertices. `source`
    /// `-1` marks a brand-new partition (materialised as a fresh wall at bake).
    /// Returns the kept face and the new face.
    #[wasm_bindgen(js_name = splitFace)]
    pub fn split_face(&mut self, face: u32, va: u32, vb: u32, source: i32) -> Result<JsValue, JsValue> {
        let src = if source < 0 { None } else { Some(source as u32) };
        let patches = self
            .inner
            .split_face(FaceId(face), VertexId(va), VertexId(vb), src)
            .map_err(edit_err)?;
        patches_to_js(patches)
    }

    /// Insert a new vertex at `(x, y)` on edge `edge`, subdividing it (no new
    /// face). Returns the new vertex id — use it as a `splitFace` endpoint to
    /// cut between points that weren't existing corners. Project `(x, y)` onto
    /// the edge to keep areas unchanged.
    #[wasm_bindgen(js_name = splitEdge)]
    pub fn split_edge(&mut self, edge: u32, x: f64, y: f64) -> Result<u32, JsValue> {
        self.inner.split_edge(HalfEdgeId(edge), x, y).map(|v| v.0).map_err(edit_err)
    }

    /// Remove a shared wall, unioning the two rooms it separated. Returns the
    /// surviving room.
    #[wasm_bindgen(js_name = mergeFaces)]
    pub fn merge_faces(&mut self, edge: u32) -> Result<JsValue, JsValue> {
        let patches = self.inner.merge_faces(HalfEdgeId(edge)).map_err(edit_err)?;
        patches_to_js(patches)
    }

    /// Dissolve a degree-2 vertex, welding its two edges into one straight
    /// edge between the neighbours — the inverse of `splitEdge`, and the
    /// "delete this corner / node" affordance. Returns the rooms it changed.
    /// Rejects a wall junction (degree ≥ 3) or a weld that would duplicate an
    /// edge.
    #[wasm_bindgen(js_name = dissolveVertex)]
    pub fn dissolve_vertex(&mut self, v: u32) -> Result<JsValue, JsValue> {
        let patches = self.inner.dissolve_vertex(VertexId(v)).map_err(edit_err)?;
        patches_to_js(patches)
    }

    /// Author a new room from a flat ring `[x0, y0, x1, y1, …]` (no repeated
    /// closing vertex). `source` `-1` marks a user-drawn room. Winding is
    /// normalised to CCW; returns the new room patch. The room is its own
    /// connected component — it does not merge into existing topology.
    #[wasm_bindgen(js_name = addFace)]
    pub fn add_face(&mut self, coords: &[f64], source: i32) -> Result<JsValue, JsValue> {
        if !coords.len().is_multiple_of(2) {
            return Err(JsValue::from_str("coords length must be even (x, y per vertex)"));
        }
        let pts: Vec<[f64; 2]> = coords.chunks_exact(2).map(|c| [c[0], c[1]]).collect();
        let src = if source < 0 { None } else { Some(source as u32) };
        let patch = self.inner.add_face(&pts, src).map_err(edit_err)?;
        patches_to_js(vec![patch])
    }

    /// Remove a wall edge, choosing the right semantics from its two faces:
    /// two real rooms → union them; a bridge / spur / outer-only wall → delete
    /// it and auto-clean the orphaned inner lines and nodes it leaves; a real
    /// enclosing wall (room ↔ exterior) → rejected (`BordersExterior`). This is
    /// the "remove this wall and tidy up" affordance for the orphan cruft the
    /// non-destructive wall arrangement leaves behind. Returns the rooms it
    /// changed (empty if the edge bounded no room).
    #[wasm_bindgen(js_name = removeEdge)]
    pub fn remove_edge(&mut self, edge: u32) -> Result<JsValue, JsValue> {
        let patches = self.inner.remove_edge(HalfEdgeId(edge)).map_err(edit_err)?;
        patches_to_js(patches)
    }

    /// Sweep the whole plate clean: remove dangling spur walls, isolated nodes,
    /// and redundant collinear nodes — the "clean up orphans" / eraser action.
    /// Area-neutral and idempotent. Returns how many topology elements were
    /// pruned (0 = the plate was already clean); the caller re-renders via
    /// `snapshot` like any other edit.
    #[wasm_bindgen(js_name = prune)]
    pub fn prune(&mut self) -> usize {
        self.inner.prune_orphans()
    }
}

fn patches_to_js(patches: Vec<FacePatch>) -> Result<JsValue, JsValue> {
    let v: Vec<FacePatchJs> = patches.into_iter().map(Into::into).collect();
    to_js(&v)
}

fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(value).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Map a topology-edit rejection to a JS `Error` whose `name` is a STABLE code
/// (the `EditError` variant) and whose `message` is human prose. The TS side
/// switches on `err.name` rather than parsing the message string — see
/// `space-edit-error.ts`.
fn edit_err(e: EditError) -> JsValue {
    let (code, msg) = match e {
        EditError::StaleHandle => ("StaleHandle", "this element no longer exists (it was removed or merged)"),
        EditError::VerticesNotOnFace => ("VerticesNotOnFace", "both split points must lie on the same room"),
        EditError::DegenerateCut => ("DegenerateCut", "the two points are the same or already share a wall"),
        EditError::BordersExterior => ("BordersExterior", "this wall is the room's outer edge — removing it would open the room"),
        EditError::BridgeEdge => ("BridgeEdge", "this wall bridges the room to itself"),
        EditError::VertexNotDissolvable => ("VertexNotDissolvable", "this node joins three or more walls"),
        EditError::InvalidPolygon => ("InvalidPolygon", "a room needs a simple ring of 3+ points enclosing real area"),
    };
    let err = js_sys::Error::new(msg);
    err.set_name(code);
    err.into()
}
