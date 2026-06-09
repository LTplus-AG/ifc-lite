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
    /// `snapTolerance` / `minArea`: pass `<= 0` to take the defaults.
    #[wasm_bindgen(constructor)]
    pub fn new(
        seg_coords: &[f64],
        seg_sources: &[i32],
        snap_tolerance: f64,
        min_area: f64,
    ) -> Result<SpacePlateHandle, JsValue> {
        if !seg_coords.len().is_multiple_of(4) {
            return Err(JsValue::from_str(
                "segCoords length must be a multiple of 4 (ax, ay, bx, by per segment)",
            ));
        }
        let n = seg_coords.len() / 4;
        if seg_sources.len() != n {
            return Err(JsValue::from_str(
                "segSources length must equal the segment count (segCoords.len / 4)",
            ));
        }
        let segments: Vec<InputSegment> = (0..n)
            .map(|i| {
                let o = i * 4;
                let src = seg_sources[i];
                InputSegment::new(
                    [seg_coords[o], seg_coords[o + 1]],
                    [seg_coords[o + 2], seg_coords[o + 3]],
                    if src < 0 { None } else { Some(src as u32) },
                )
            })
            .collect();
        let defaults = BuildOptions::default();
        let opts = BuildOptions {
            snap_tolerance: if snap_tolerance > 0.0 { snap_tolerance } else { defaults.snap_tolerance },
            min_area: if min_area > 0.0 { min_area } else { defaults.min_area },
        };
        Ok(SpacePlateHandle { inner: SpacePlate::build(&segments, opts) })
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
}

fn patches_to_js(patches: Vec<FacePatch>) -> Result<JsValue, JsValue> {
    let v: Vec<FacePatchJs> = patches.into_iter().map(Into::into).collect();
    to_js(&v)
}

fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(value).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Map a topology-edit rejection to a JS `Error` with a stable, readable code.
fn edit_err(e: EditError) -> JsValue {
    let msg = match e {
        EditError::StaleHandle => "StaleHandle: id is tombstoned or out of range",
        EditError::VerticesNotOnFace => "VerticesNotOnFace: both split vertices must lie on the face",
        EditError::DegenerateCut => "DegenerateCut: split endpoints are equal or already adjacent",
        EditError::BordersExterior => "BordersExterior: edge borders the exterior — nothing to merge",
        EditError::BridgeEdge => "BridgeEdge: edge is a bridge — removing it would split connectivity",
    };
    JsValue::from_str(msg)
}
