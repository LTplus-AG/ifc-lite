/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use super::TinHandler;
use crate::{xml::Result, LandXmlCapabilityDiagnostic};

impl TinHandler<'_> {
    /// Reserve source-coordinate records before allocating semantic output.
    /// Definition points, SourceData lists and overlay vertices all count: a
    /// document must not bypass `max_points` merely by moving coordinates out
    /// of `Definition/Pnts`.
    pub(super) fn reserve_points(&mut self, added: usize) -> Result<()> {
        self.points_seen.reserve(added)
    }

    /// Charge a retained element path. A foreign-namespace record keeps its
    /// full joined ancestor path (up to `max_depth` x `max_name_bytes`, ~16 KB),
    /// so without a budget 44 KB of input retained 32 MB of paths (#7675,
    /// EDGE-LXPARSE-4).
    pub(super) fn reserve_source_path(&mut self, bytes: usize) -> Result<()> {
        self.source_path_bytes.reserve(bytes)
    }

    /// Spend `added` work: one cancellation poll and the `work` budget.
    pub(super) fn check_cancel_and_work(&mut self, added: usize) -> Result<()> {
        self.meter.charge(added)
    }

    /// Account for every retained source reference before allocating its
    /// strings. Faces, roadway associations, and cross-section reference
    /// attributes all share the same adversarial-input budget.
    pub(super) fn reserve_references(&mut self, added: usize) -> Result<()> {
        self.references.reserve(added)
    }

    /// Diagnostics are source output too: do not let a malformed grade line
    /// create an unbounded allocation while reporting every missing value.
    pub(super) fn record_capability_diagnostic(
        &mut self,
        diagnostic: LandXmlCapabilityDiagnostic,
    ) -> Result<()> {
        self.capability_diagnostics_seen.reserve(1)?;
        self.capability_diagnostics.push(diagnostic);
        Ok(())
    }
}
