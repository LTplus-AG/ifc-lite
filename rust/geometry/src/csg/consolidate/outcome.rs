// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::Mesh;

/// Stronger downstream preservation applies only to the adopted remote repair.
/// Ordinary consolidation keeps its established hygiene and emission contract.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ConsolidationBoundary {
    Established,
    CertifiedRemote,
}

impl ConsolidationBoundary {
    pub(crate) fn accepts(self, mesh: &Mesh) -> bool {
        self == Self::Established || crate::exact_topology::kernel_grid::is_closed(mesh)
    }
}

pub(crate) struct ConsolidationOutcome {
    pub(crate) mesh: Mesh,
    pub(crate) boundary: ConsolidationBoundary,
}

impl ConsolidationOutcome {
    pub(super) fn established(mesh: Mesh) -> Self {
        Self { mesh, boundary: ConsolidationBoundary::Established }
    }
    pub(super) fn certified_remote(mesh: Mesh) -> Self {
        Self { mesh, boundary: ConsolidationBoundary::CertifiedRemote }
    }
}
