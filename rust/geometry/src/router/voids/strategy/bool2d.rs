// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Bool2d (stage A, second): subtract the openings' footprints from the host's
//! 2D profile and re-extrude, generalising ParamRect to arbitrary extruded-host
//! profiles.

use super::{Cut, VoidContext};
use crate::program::openings::execute::Execution;
use crate::Mesh;

/// Tried after ParamRect so proven rect+rect outputs are unchanged;
/// ORIGIN-AWARE (it builds its own world frame from the parametrics and
/// reconciles against the real host mesh, whatever `mesh.origin`). The staged
/// composition keeps provisional-child acceptance and its telemetry. Any miss
/// falls through unchanged.
pub(super) fn try_cut(execution: &Execution, host: &Mesh, ctx: &VoidContext, element_id: u32) -> Option<Cut> {
    let cut = ctx.bool2d.as_ref()?;
    let mesh = execution.try_staged_bool2d(host, cut, element_id)?;
    Some(Cut { mesh, residual: None })
}
