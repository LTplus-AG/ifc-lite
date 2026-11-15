// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Whether a sliver refinement is worth keeping.
//!
//! [`super::refine_high_aspect_slivers`] picks triangles by longest edge over
//! shortest and bisects the longest edge. The mesh census judges a triangle
//! by its longest edge over its ALTITUDE, and by that measure bisecting a
//! needle makes it worse: one half keeps the altitude on half the edge, the
//! other half is a flat cap with half the altitude on the whole edge. A thin
//! sheet is all needles (a 12 mm by 3 m face has none under 250:1), so the
//! pass spent its split budget multiplying them, on whichever edges came first
//! in vertex order. One host cut in two frames then came back with different
//! sliver counts, and both were higher than the unrefined cut's.
//!
//! A refinement is therefore kept only when the census measure says the mesh
//! got better. When it is not kept the mesh still takes the pass's vertex
//! canonicalisation, which closes sub-0.1 mm cracks and which the callers have
//! always had from it.

use super::{refine_high_aspect_slivers_impl, Region};
use crate::mesh::Mesh;
use crate::mesh_check::{triangle_shape, undirected_defect_count, TriangleShape};

/// What the census reads off a mesh for triangle shape, plus its unpaired
/// edges.
struct Quality {
    shape: TriangleShape,
    unpaired_edges: usize,
}

impl Quality {
    #[cfg(test)]
    fn of(mesh: &Mesh) -> Self {
        Self { shape: triangle_shape(mesh), unpaired_edges: undirected_defect_count(mesh) }
    }

    /// The verdict `mesh-census-compare.mjs` would give this mesh against
    /// `before`: not worse (no sliver gained, worst aspect within 1.5x), better
    /// on one of the two, and no edge left unpaired that was paired before.
    fn improves_on(&self, before: &Self) -> bool {
        let (now, was) = (self.shape, before.shape);
        let worse = now.slivers > was.slivers || now.max_aspect > 1.5 * was.max_aspect;
        let better = now.slivers < was.slivers || now.max_aspect < was.max_aspect;
        !worse && better && self.unpaired_edges <= before.unpaired_edges
    }
}

/// Whether `refined` improves on `plain` by [`Quality::improves_on`].
///
/// The edge ledgers are built only once the shapes allow it.
pub(crate) fn improves(refined: &Mesh, plain: &Mesh) -> bool {
    let (now, was) = (triangle_shape(refined), triangle_shape(plain));
    let shape_only = |shape| Quality { shape, unpaired_edges: 0 };
    shape_only(now).improves_on(&shape_only(was))
        && Quality { shape: now, unpaired_edges: undirected_defect_count(refined) }
            .improves_on(&Quality { shape: was, unpaired_edges: undirected_defect_count(plain) })
}

/// `mesh` rebuilt from the pass's canonical vertices with nothing bisected:
/// what the callers get when a refinement is not kept. `mesh` itself when no
/// sliver fires the pass.
pub(crate) fn canonicalised(mesh: &Mesh) -> Mesh {
    refine_high_aspect_slivers_impl(mesh, None, false).unwrap_or_else(|| mesh.clone())
}

/// `refined` when it improves on the canonicalised `mesh`, else that. Judged
/// against the canonicalised mesh, not the raw one: canonicalising alone drops
/// triangles that collapse, and a refinement must not take credit for them.
/// `refined` must be a refinement of `mesh` that changed it.
fn keep_if_better(mesh: &Mesh, refined: Mesh) -> Mesh {
    let plain = canonicalised(mesh);
    if improves(&refined, &plain) {
        refined
    } else {
        plain
    }
}

/// [`super::refine_high_aspect_slivers`] under the rule above, for a caller
/// that has no test of its own to put the result through.
pub(crate) fn refine_slivers_if_better(mesh: Mesh) -> Mesh {
    match refine_high_aspect_slivers_impl(&mesh, None, true) {
        Some(refined) => keep_if_better(&mesh, refined),
        None => mesh,
    }
}

/// The region-scoped pass driven to its fixed point, or `None` when no sliver
/// in the region fired. One call fixes up to its split budget; a cut can carry
/// more rim fans than that.
pub(crate) fn refine_within_to_fixpoint(mesh: &Mesh, boxes: Region<'_>) -> Option<Mesh> {
    let mut refined = refine_high_aspect_slivers_impl(mesh, Some(boxes), true)?;
    for _ in 0..5 {
        match refine_high_aspect_slivers_impl(&refined, Some(boxes), true) {
            Some(next) if next.indices.len() != refined.indices.len() => refined = next,
            _ => break,
        }
    }
    Some(refined)
}

#[cfg(test)]
#[path = "adopt_tests.rs"]
mod tests;
