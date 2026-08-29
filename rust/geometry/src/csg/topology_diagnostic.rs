// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Step 1 of #3440: record (never gate) when a mesh `validate_mesh` already
//! accepted fails the directed-edge closure audit `validate_mesh` has no way
//! to observe. Split out of `csg/mod.rs` to keep the four call sites there a
//! one-line addition each (module-size ratchet).

use super::ClippingProcessor;
use crate::diagnostics::{BoolFailureReason, BoolOp};
use crate::mesh::Mesh;
use crate::router::voids::prism_cut::closure_checks::directed_closed;

impl ClippingProcessor {
    /// Run the shared closure audit on a mesh `validate_mesh` already
    /// accepted and, on a torn result, record [`BoolFailureReason::OpenTopology`].
    /// Does NOT change what the caller returns — the mesh already chosen is
    /// unaffected either way; this only adds a diagnostic record.
    pub(crate) fn record_topology_tear(&self, op: BoolOp, mesh: &Mesh) {
        if !mesh.is_empty() && !directed_closed(mesh) {
            self.record_failure(op, BoolFailureReason::OpenTopology);
        }
    }
}
