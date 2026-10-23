// SPDX-License-Identifier: MPL-2.0
use super::{Cut, Execution, Mesh, VoidContext};

pub(super) fn try_cut(
    execution: &Execution, host: &Mesh, context: &VoidContext, element_id: u32,
) -> Option<Cut> {
    let cut = context.bool2d.as_ref()?;
    // Staged composition retains provisional-child acceptance and telemetry.
    execution.try_staged_bool2d(host, cut, element_id)
        .map(|mesh| Cut { mesh, residual: None })
}
