// SPDX-License-Identifier: MPL-2.0
use super::{Cut, Execution, Mesh, VoidContext};
use super::super::{prism_cut, world_host_bounds};

pub(super) fn try_cut(
    execution: &Execution, host: &Mesh, context: &VoidContext, element_id: u32,
) -> Option<Cut> {
    if !prism_cut::enabled() { return None; }
    // Capture before the attempt, matching the original diagnostic timing.
    let bounds = world_host_bounds(host);
    let triangles_before = host.triangle_count();
    let (mesh, residual) = execution.try_prism_cut(host, context)?;
    if residual.is_none() {
        execution.record_host_cut_effect(
            element_id, triangles_before, mesh.triangle_count(),
            context.rect_opening_count(), bounds,
        );
    }
    // With a residual, the recursive pass records the final cut effect.
    Some(Cut { mesh, residual })
}
