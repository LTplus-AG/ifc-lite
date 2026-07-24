// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! WASM API: general 2D boolean operations over contour sets (issue #1863).
//!
//! Until now the only `i_overlay` capability crossing the boundary was the
//! fixed-purpose [`meshOutline2d`](super::mesh_outline). Downstream analytic
//! hidden-surface removal needs the general form, or it has to bolt a second
//! 2D geometry engine (with different winding and precision semantics) onto
//! the same pipeline:
//!
//! ```javascript
//! let occluders = new Contours2D(new Float64Array(), new Uint32Array()); // empty
//! for (const el of frontToBack) {
//!   const outline = Contours2D.fromMeshOutline(meshOutline2d(...));
//!   const visible = difference2d(outline, occluders);   // may split into islands
//!   const grown = union2d(occluders, outline);
//!   occluders.free();
//!   occluders = grown;
//!   emitSvgPath(visible);                                // fill-rule="nonzero"
//!   visible.free();
//!   outline.free();
//! }
//! ```
//!
//! Every handle returned here owns wasm memory: `free()` it, and note that the
//! operations return NEW handles rather than mutating their operands, so an
//! accumulating loop must free the handle it replaces (as above).
//!
//! Winding carries outer-vs-hole (CCW covers, CW subtracts) and the fill rule
//! is always NonZero, matching `meshOutline2d`'s output and SVG
//! `fill-rule="nonzero"`. See `ifc_lite_geometry::contour_bool2d` for the
//! full contract.

use super::mesh_outline::MeshOutlineJs;
use ifc_lite_geometry::{
    boolean_2d, resolve_2d, sanitize_contours, BooleanOp2D, ContourSet, Ring2D,
};
use wasm_bindgen::prelude::*;

/// A set of closed 2D rings, grouped into disjoint shapes.
///
/// Rings carry no duplicated closing vertex (connect the last point back to
/// the first). Winding is meaningful: a counter-clockwise ring covers area, a
/// clockwise one removes it, so an outer boundary and its holes are
/// distinguishable without any extra tagging — the property
/// `meshOutline2d`'s flattened contour list relies on too.
#[wasm_bindgen]
pub struct Contours2D {
    set: ContourSet,
}

#[wasm_bindgen]
impl Contours2D {
    /// Build a contour set from flat coordinates plus per-ring vertex counts.
    ///
    /// `coords` is `[x0, y0, x1, y1, …]` with every ring concatenated in order;
    /// `ringLengths[i]` is the VERTEX count (not the float count) of ring `i`.
    /// Throws when the counts do not add up to `coords.length / 2`.
    ///
    /// Shape grouping is a property of boolean *results*: a set built here is
    /// an unstructured ring soup, so `shapeCount` reports 0 until it has been
    /// through an operation (`resolve2d` alone is enough). Degenerate rings
    /// (under 3 vertices or carrying a non-finite coordinate) are dropped at
    /// construction, so `isEmpty`/`bounds()` report the same rings a later
    /// boolean would keep rather than exposing an unsanitised soup.
    #[wasm_bindgen(constructor)]
    pub fn new(coords: &[f64], ring_lengths: &[u32]) -> Result<Contours2D, JsValue> {
        if coords.len() % 2 != 0 {
            return Err(js_sys::Error::new("Contours2D: coords length must be even").into());
        }
        // Checked arithmetic: on wasm32 `usize` is 32-bit, so a crafted
        // `ringLengths` could otherwise overflow the vertex total (or its ×2)
        // past the length check and then panic slicing `coords` below.
        let expected = ring_lengths
            .iter()
            .try_fold(0usize, |acc, n| acc.checked_add(*n as usize))
            .and_then(|v| v.checked_mul(2))
            .ok_or_else(|| js_sys::Error::new("Contours2D: ringLengths overflow"))?;
        if expected != coords.len() {
            return Err(js_sys::Error::new(&format!(
                "Contours2D: ringLengths sum to {} vertices but coords hold {}",
                expected / 2,
                coords.len() / 2
            ))
            .into());
        }
        let mut rings: Vec<Ring2D> = Vec::with_capacity(ring_lengths.len());
        let mut at = 0usize;
        for n in ring_lengths {
            let n = *n as usize;
            let ring = coords[at * 2..(at + n) * 2]
                .chunks_exact(2)
                .map(|p| [p[0], p[1]])
                .collect();
            rings.push(ring);
            at += n;
        }
        Ok(Contours2D {
            set: ContourSet {
                rings: sanitize_contours(&rings),
                shape_offsets: Vec::new(),
            },
        })
    }

    /// Adopt the rings of a `meshOutline2d` result, widening its f32
    /// coordinates to the f64 the boolean engine works in.
    ///
    /// The outline's `axisMin`/`axisMax` are dropped — they describe the cut
    /// axis, which a 2D boolean has no notion of; keep them on the JS side if
    /// the caller still needs them for band classification.
    #[wasm_bindgen(js_name = fromMeshOutline)]
    pub fn from_mesh_outline(outline: &MeshOutlineJs) -> Contours2D {
        // `meshOutline2d` rings are already valid (>= 3 vertices, finite,
        // unclosed), so `sanitize` is a near no-op here — applied only to hold
        // the same raw-accessor invariant the constructor documents.
        Contours2D {
            set: ContourSet {
                rings: sanitize_contours(&outline.rings_f64()),
                shape_offsets: Vec::new(),
            },
        }
    }

    /// Total number of boundary rings across every shape.
    #[wasm_bindgen(getter, js_name = ringCount)]
    pub fn ring_count(&self) -> usize {
        self.set.rings.len()
    }

    /// Number of disjoint shapes, or 0 for a set that has not been through an
    /// operation yet (see the constructor).
    #[wasm_bindgen(getter, js_name = shapeCount)]
    pub fn shape_count(&self) -> usize {
        self.set.shape_count()
    }

    /// True when the set holds no rings. Degenerate rings are dropped at
    /// construction and never emitted by an operation, so this also means the
    /// set covers no area.
    #[wasm_bindgen(getter, js_name = isEmpty)]
    pub fn is_empty(&self) -> bool {
        self.set.is_empty()
    }

    /// Ring index at which each shape starts. Entry `s` is shape `s`'s OUTER
    /// ring; the rings up to the next entry (or `ringCount`) are its holes.
    #[wasm_bindgen(js_name = shapeOffsets)]
    pub fn shape_offsets(&self) -> js_sys::Uint32Array {
        let v: Vec<u32> = self
            .set
            .shape_offsets
            .iter()
            .map(|o| *o as u32)
            .collect();
        js_sys::Uint32Array::from(&v[..])
    }

    /// Ring `index` as a flat `[x0, y0, x1, y1, …]` array, or `undefined` when
    /// out of range.
    pub fn ring(&self, index: usize) -> Option<js_sys::Float64Array> {
        let ring = self.set.rings.get(index)?;
        let mut flat = Vec::with_capacity(ring.len() * 2);
        for p in ring {
            flat.push(p[0]);
            flat.push(p[1]);
        }
        Some(js_sys::Float64Array::from(&flat[..]))
    }

    /// Every ring's coordinates concatenated. Paired with `ringLengths()` this
    /// reconstructs the set through the constructor, and reads a whole result
    /// back in one boundary crossing instead of one per ring. It round-trips the
    /// constructor's *sanitised* rings — degenerate rings and explicit closing
    /// vertices are dropped at construction, so those are not echoed back.
    pub fn coords(&self) -> js_sys::Float64Array {
        let total: usize = self.set.rings.iter().map(|r| r.len() * 2).sum();
        let mut flat = Vec::with_capacity(total);
        for ring in &self.set.rings {
            for p in ring {
                flat.push(p[0]);
                flat.push(p[1]);
            }
        }
        js_sys::Float64Array::from(&flat[..])
    }

    /// Vertex count of each ring, in the same order as `coords()`.
    #[wasm_bindgen(js_name = ringLengths)]
    pub fn ring_lengths(&self) -> js_sys::Uint32Array {
        let v: Vec<u32> = self.set.rings.iter().map(|r| r.len() as u32).collect();
        js_sys::Uint32Array::from(&v[..])
    }

    /// Axis-aligned bounds as `[minX, minY, maxX, maxY]`, or `undefined` when
    /// empty. Cheap enough to gate the boolean itself: an accumulated occluder
    /// whose bounds miss the next element needs no difference at all.
    pub fn bounds(&self) -> Option<js_sys::Float64Array> {
        self.set
            .bounds()
            .map(|b| js_sys::Float64Array::from(&b[..]))
    }
}

/// `a ∪ b`.
#[wasm_bindgen(js_name = union2d)]
pub fn union_2d(a: &Contours2D, b: &Contours2D) -> Contours2D {
    Contours2D {
        set: boolean_2d(&a.set.rings, &b.set.rings, BooleanOp2D::Union),
    }
}

/// `a - b`, keeping EVERY disjoint remnant.
///
/// This is the operation the existing `subtract_2d` could not stand in for: it
/// returns one shape per island, where `subtract_2d` collapses to the largest
/// (correct for a single extrusion profile, silent geometry loss anywhere else).
///
/// `b` may hold any number of rings; they subtract as their union, so there is
/// no separate "difference against many" entry point.
#[wasm_bindgen(js_name = difference2d)]
pub fn difference_2d(a: &Contours2D, b: &Contours2D) -> Contours2D {
    Contours2D {
        set: boolean_2d(&a.set.rings, &b.set.rings, BooleanOp2D::Difference),
    }
}

/// `a ∩ b`.
#[wasm_bindgen(js_name = intersection2d)]
pub fn intersection_2d(a: &Contours2D, b: &Contours2D) -> Contours2D {
    Contours2D {
        set: boolean_2d(&a.set.rings, &b.set.rings, BooleanOp2D::Intersection),
    }
}

/// Resolve a ring soup into disjoint outer/hole shapes without changing the
/// area it covers (a self-union). Use it to give a hand-built set — or a
/// `meshOutline2d` result — the shape grouping the operations produce.
#[wasm_bindgen(js_name = resolve2d)]
pub fn resolve_2d_js(a: &Contours2D) -> Contours2D {
    Contours2D {
        set: resolve_2d(&a.set.rings),
    }
}
