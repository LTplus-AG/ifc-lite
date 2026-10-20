// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Result contract shared by batched subtraction entry points.

use super::{tris_to_mesh_without_plane_tags, Mesh, Tri};

/// What [subtract_many](super::subtract_many) made of a cutter group.
#[must_use]
#[derive(Debug, Clone)]
pub enum BatchSubtract {
    /// The arrangement conformed (or its lenient batch passed the volume
    /// oracle) and at least one cutter reaches the host solid. Empty when the
    /// cutters engulf the host.
    Cut(Mesh),
    /// The arrangement conformed but no cutter reaches the host solid: every
    /// host sub-triangle was kept and no cutter face was. The host is unchanged.
    Unchanged,
    /// No trustworthy arrangement: an unrecovered constraint remained and the
    /// lenient batch failed the volume oracle, or the oracle itself tripped the
    /// budget. The caller falls back to sequential per-cutter subtraction.
    Nonconforming,
}

impl BatchSubtract {
    /// `Cut` when the classifier changed the host, `Unchanged` otherwise.
    pub(super) fn classified(tris: &[Tri], changed: bool) -> Self {
        if changed {
            Self::Cut(tris_to_mesh_without_plane_tags(tris))
        } else {
            Self::Unchanged
        }
    }
}
