// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! General 2D boolean operations over **contour sets** (issue #1863).
//!
//! [`bool2d`](crate::bool2d) solves one fixed problem: subtract void footprints
//! from a single [`Profile2D`](crate::profile::Profile2D) before extrusion. Its
//! results are collapsed to the largest output shape, which is right there (a
//! profile is one region) and wrong for anything else.
//!
//! This module is the general form: union / difference / intersection over
//! arbitrary ring sets, keeping **every** disjoint output shape with its holes.
//! It exists for analytic hidden-surface removal, whose core loop is
//!
//! ```text
//! visible   = outline(e) - occluders      // may split into many islands
//! occluders = occluders ∪ outline(e)
//! ```
//!
//! where collapsing to the largest shape would silently delete visible
//! geometry: a wall seen behind a column is two visible slivers, not one.
//!
//! ## Winding is the contract
//!
//! Every operation uses [`FillRule::NonZero`] and **respects the input ring
//! winding**: counter-clockwise rings add coverage, clockwise rings remove it.
//! That is the convention
//! [`mesh_outline_2d`](crate::projection_outline::mesh_outline_2d) emits, so an
//! outline's rings feed straight back in and its holes survive the round trip,
//! and it is what SVG `fill-rule="nonzero"` renders. A caller holding raw,
//! arbitrarily-wound contours (projected triangles, say) must normalise them
//! CCW first — see [`ensure_ccw`](crate::ensure_ccw). This layer will not
//! guess, because guessing is precisely what destroys holes.

use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::float::single::SingleFloatOverlay;

/// A closed ring: 2D points in order, WITHOUT a duplicated closing vertex.
pub type Ring2D = Vec<[f64; 2]>;

/// The result of a contour-set boolean: rings grouped into disjoint shapes.
///
/// Unlike [`Profile2D`](crate::profile::Profile2D) this holds any number of
/// shapes, so a difference that splits its subject into islands loses nothing.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ContourSet {
    /// Every boundary ring, laid out shape by shape.
    pub rings: Vec<Ring2D>,
    /// `shape_offsets[s]` is the index in [`rings`](Self::rings) of shape `s`'s
    /// OUTER ring; the rings from there to the next offset (or the end) are
    /// that shape's holes. Length == number of disjoint shapes.
    pub shape_offsets: Vec<usize>,
}

impl ContourSet {
    /// True when the set covers no area at all.
    pub fn is_empty(&self) -> bool {
        self.rings.is_empty()
    }

    /// Number of disjoint shapes.
    pub fn shape_count(&self) -> usize {
        self.shape_offsets.len()
    }

    /// Rings of shape `s` (outer boundary first, then its holes), or `None`
    /// when `s` is out of range.
    pub fn shape(&self, s: usize) -> Option<&[Ring2D]> {
        let start = *self.shape_offsets.get(s)?;
        let end = self
            .shape_offsets
            .get(s + 1)
            .copied()
            .unwrap_or(self.rings.len());
        self.rings.get(start..end)
    }

    /// Axis-aligned bounds `[min_x, min_y, max_x, max_y]`, `None` when empty.
    ///
    /// Cheap enough to be the first test in an occlusion loop: an accumulated
    /// occluder that does not overlap the next element's outline needs no
    /// boolean at all.
    pub fn bounds(&self) -> Option<[f64; 4]> {
        let mut b = [
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ];
        for p in self.rings.iter().flatten() {
            b[0] = b[0].min(p[0]);
            b[1] = b[1].min(p[1]);
            b[2] = b[2].max(p[0]);
            b[3] = b[3].max(p[1]);
        }
        (b[0] <= b[2]).then_some(b)
    }
}

/// Which boolean to apply in [`boolean_2d`].
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BooleanOp2D {
    /// `subject ∪ clip`.
    Union,
    /// `subject - clip`.
    Difference,
    /// `subject ∩ clip`.
    Intersection,
}

impl BooleanOp2D {
    /// Decode the 0/1/2 = union/difference/intersection convention used across
    /// the WASM boundary.
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(BooleanOp2D::Union),
            1 => Some(BooleanOp2D::Difference),
            2 => Some(BooleanOp2D::Intersection),
            _ => None,
        }
    }
}

/// Drop rings that cannot contribute, so no input can panic or hang the
/// overlay: fewer than 3 vertices, or ANY non-finite coordinate (a NaN makes
/// i_overlay's segment ordering meaningless, so the whole ring goes rather than
/// the offending point — dropping single points would silently deform the
/// boundary instead). A trailing vertex equal to the first is stripped, so a
/// caller that closes its rings explicitly does not feed in a zero-length edge.
fn sanitize(rings: &[Ring2D]) -> Vec<Vec<[f64; 2]>> {
    rings
        .iter()
        .filter_map(|ring| {
            if ring.iter().any(|p| !p[0].is_finite() || !p[1].is_finite()) {
                return None;
            }
            let mut path = ring.clone();
            while path.len() >= 2 && path[path.len() - 1] == path[0] {
                path.pop();
            }
            (path.len() >= 3).then_some(path)
        })
        .collect()
}

/// Flatten i_overlay's `shapes -> contours -> points` output into a
/// [`ContourSet`], preserving the shape grouping (which
/// `mesh_outline_2d` throws away).
fn collect(shapes: Vec<Vec<Vec<[f64; 2]>>>) -> ContourSet {
    let mut out = ContourSet::default();
    for shape in shapes {
        // i_overlay emits each shape's outer boundary first; a shape whose
        // outer ring degenerated has nothing to contribute, holes included.
        match shape.first() {
            Some(outer) if outer.len() >= 3 => {}
            _ => continue,
        }
        out.shape_offsets.push(out.rings.len());
        for ring in shape {
            if ring.len() >= 3 {
                out.rings.push(ring);
            }
        }
    }
    out
}

/// Self-union: overlay against an empty clip so overlapping subject rings
/// dissolve into disjoint shapes without changing the covered area.
fn resolve(subject: &[Vec<[f64; 2]>]) -> ContourSet {
    let empty: Vec<Vec<[f64; 2]>> = Vec::new();
    collect(subject.overlay(&empty, OverlayRule::Union, FillRule::NonZero))
}

/// Apply a boolean operation to two contour sets.
///
/// Ring winding carries outer-vs-hole (see the module docs); the fill rule is
/// always NonZero. Never panics: degenerate rings are dropped and every empty
/// combination has a defined answer —
///
/// | subject | clip  | union | difference | intersection |
/// |---------|-------|-------|------------|--------------|
/// | empty   | any   | clip  | empty      | empty        |
/// | any     | empty | subj  | subj       | empty        |
///
/// where "clip"/"subj" mean that operand resolved into disjoint shapes.
pub fn boolean_2d(subject: &[Ring2D], clip: &[Ring2D], op: BooleanOp2D) -> ContourSet {
    let subject = sanitize(subject);
    let clip = sanitize(clip);
    match op {
        BooleanOp2D::Union => {
            if subject.is_empty() {
                return resolve(&clip);
            }
            if clip.is_empty() {
                return resolve(&subject);
            }
            collect(subject.overlay(&clip, OverlayRule::Union, FillRule::NonZero))
        }
        BooleanOp2D::Difference => {
            if subject.is_empty() {
                return ContourSet::default();
            }
            // Subtracting nothing is the identity, but the subject may still
            // self-overlap; resolve it so the result is always disjoint shapes.
            if clip.is_empty() {
                return resolve(&subject);
            }
            collect(subject.overlay(&clip, OverlayRule::Difference, FillRule::NonZero))
        }
        BooleanOp2D::Intersection => {
            if subject.is_empty() || clip.is_empty() {
                return ContourSet::default();
            }
            collect(subject.overlay(&clip, OverlayRule::Intersect, FillRule::NonZero))
        }
    }
}

/// Resolve a ring set into disjoint shapes without changing the area it covers
/// (a self-union). Canonicalises a hand-built contour set — or the flattened
/// rings of a [`MeshOutline`](crate::projection_outline::MeshOutline) — into
/// grouped outer/hole shapes.
pub fn resolve_2d(rings: &[Ring2D]) -> ContourSet {
    boolean_2d(rings, &[], BooleanOp2D::Union)
}

#[cfg(test)]
#[path = "contour_bool2d_tests.rs"]
mod tests;
