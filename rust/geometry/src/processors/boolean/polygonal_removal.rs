// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Removal bound for a coordinate-moving roof cutter repair (#3925).

use crate::{Mesh, router::voids::geom::mesh_signed_volume};

/// The union cannot remove more than the sum of its individual removals.
/// Overlap makes this an upper bound, not an estimate of the correct answer.
/// A diagnostically invalid trial disables coordinate-moving repair.
pub(super) struct RemovalBound {
    host_volume: f64,
    maximum_removed: f64,
    valid: bool,
}

impl RemovalBound {
    pub(super) fn new(host: &Mesh) -> Self {
        let host_volume = mesh_signed_volume(host).abs();
        Self { host_volume, maximum_removed: 0.0, valid: host_volume.is_finite() && host_volume > 0.0 }
    }

    pub(super) fn observe(&mut self, trial: &Mesh) {
        let removed = self.host_volume - mesh_signed_volume(trial).abs();
        self.valid &= removed.is_finite() && removed >= 0.0;
        self.maximum_removed += removed;
    }

    pub(super) fn invalidate(&mut self) {
        self.valid = false;
    }

    pub(super) fn is_valid(&self) -> bool {
        self.valid && self.maximum_removed.is_finite()
    }

    pub(super) fn allows(&self, candidate: &Mesh) -> bool {
        let removed = self.host_volume - mesh_signed_volume(candidate).abs();
        self.is_valid() && removed.is_finite()
            && removed >= 0.0 && removed <= self.maximum_removed
    }
}

#[cfg(test)]
#[path = "polygonal_removal_tests.rs"]
mod tests;
