// SPDX-License-Identifier: MPL-2.0
//! Preserve the boundary of a wall body whose authored interior the recess misses.
use super::super::{aligned_bodies::shell, world_host_bounds, CutterKind, VoidContext};
use super::Cut;
use crate::mesh_check::EdgeLedger;
use crate::program::openings::execute::Execution;
use crate::Mesh;

/// The untouched sibling and its place in the original assembly.
pub(super) struct PreservedBody {
    mesh: Mesh,
    cut_first: bool,
    before: usize,
    bounds: ((f32, f32, f32), (f32, f32, f32)),
}

impl PreservedBody {
    pub(super) fn rejoin(
        self,
        cut: Mesh,
        execution: &Execution,
        ctx: &VoidContext,
        id: u32,
    ) -> Mesh {
        let mut result = Mesh::new();
        let (first, second) = if self.cut_first {
            (cut, self.mesh)
        } else {
            (self.mesh, cut)
        };
        result.merge(&first);
        result.merge(&second);
        execution.record_host_cut_effect(
            id,
            self.before,
            result.triangle_count(),
            ctx.rect_opening_count(),
            self.bounds,
        );
        result
    }
}

pub(super) fn try_cut(
    execution: &Execution,
    mesh: &Mesh,
    ctx: &VoidContext,
    id: u32,
) -> Option<Cut> {
    let [CutterKind::DiagonalRectangular(_, frame)] = ctx.openings.as_slice() else {
        return None;
    };
    let bodies = frame.aligned_bodies.as_ref()?;
    // An unsubdivided cuboid has twelve triangles. Only the original
    // one-item or two-item stream can qualify for this partition.
    if !matches!(mesh.indices.len(), 36 | 72) {
        return None;
    }
    let ranges = EdgeLedger::closed_shell_ranges(mesh)?;
    if ranges.len() == 1 && bodies.affected == [false; 2] {
        // A single styled item with no sibling being cut already uses its
        // ordinary solitary-body path. There is no assembly to partition.
        return None;
    }
    let mut seen = [false; 2];
    let mut selected = Vec::with_capacity(ranges.len());
    for range in &ranges {
        let matches =
            [0, 1].map(|i| bodies.hosts[i].matches_shell(mesh, &mesh.indices[range.clone()]));
        let owner = match matches {
            [true, false] => 0,
            [false, true] => 1,
            _ => return None,
        };
        if std::mem::replace(&mut seen[owner], true) {
            return None;
        }
        selected.push(bodies.affected[owner]);
    }
    if !selected.iter().any(|&hit| hit) {
        let before = mesh.triangle_count();
        execution.record_host_cut_effect(
            id,
            before,
            before,
            ctx.rect_opening_count(),
            world_host_bounds(mesh),
        );
        return Some(Cut::Whole {
            mesh: mesh.clone(),
            residual: None,
        });
    }
    // A manifold-gated cut can unite touching solids and remove both contact faces.
    // A positive intersection must go through that gate.
    if cfg!(feature = "csg_manifold_gate") {
        return None;
    }
    let [first, second] = ranges.as_slice() else {
        return None;
    };
    let (active, untouched) = match selected.as_slice() {
        [true, false] => (first, second),
        [false, true] => (second, first),
        _ => return None,
    };
    Some(Cut::OneBody {
        mesh: shell(mesh, &mesh.indices[active.clone()]),
        sibling: PreservedBody {
            mesh: shell(mesh, &mesh.indices[untouched.clone()]),
            cut_first: selected[0],
            before: mesh.triangle_count(),
            bounds: world_host_bounds(mesh),
        },
    })
}
