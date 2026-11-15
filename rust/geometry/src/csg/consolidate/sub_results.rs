// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The consolidations one consolidation runs on its own input, each run once.
//!
//! A consolidation that retains a fold or a thin cell compares its output
//! against the same input consolidated with that retention switched off, and
//! each of those does the same. With a fold and thin cells on one host the
//! comparisons meet: fold-free then cell-free and cell-free then fold-free
//! are the same call. Every call below the first takes the same mesh, unit
//! scale and use, and no prism host, so the three retention switches name it.
//! Keeping each result makes nine passes six on such a host (`ISSUE_129`
//! #61300 cut in its root frame) and changes no output.

use super::{ConsolidationUse, Mesh};
use crate::csg::ClippingProcessor;

/// Results keyed by `(preserve_supported, preserve_folds, preserve_connected)`.
/// At most eight per input, so a scan beats a map.
#[derive(Default)]
pub(super) struct SubResults(Vec<((bool, bool, bool), Mesh)>);

impl SubResults {
    /// `mesh` consolidated under the given switches: computed on the first
    /// request, cloned on a later one.
    pub(super) fn run(
        &mut self,
        mesh: &Mesh,
        length_unit_scale: f64,
        preserve_supported: bool,
        preserve_folds: bool,
        usage: ConsolidationUse,
        preserve_connected: bool,
    ) -> Mesh {
        let key = (preserve_supported, preserve_folds, preserve_connected);
        if let Some((_, known)) = self.0.iter().find(|(seen, _)| *seen == key) {
            return known.clone();
        }
        let result = ClippingProcessor::consolidate_with_outcome(
            mesh.clone(), length_unit_scale, preserve_supported, preserve_folds, usage, preserve_connected,
            None, self,
        )
        .mesh;
        self.0.push((key, result.clone()));
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::{arrangement::box_mesh, mesh_bridge::tris_to_mesh};

    /// A kept result is the result the direct call gives, under every switch
    /// setting, and each setting is computed once.
    #[test]
    fn a_kept_result_is_the_direct_result() {
        let cube = tris_to_mesh(&box_mesh([0.0; 3], [1.0; 3]));
        let mut subs = SubResults::default();
        for round in 0..2 {
            for bits in 0..8u8 {
                let (supported, folds, connected) = (bits & 1 != 0, bits & 2 != 0, bits & 4 != 0);
                let direct = ClippingProcessor::consolidate_with_use(
                    cube.clone(), 1.0, supported, folds, ConsolidationUse::ClosedOutput, connected);
                let kept = subs.run(&cube, 1.0, supported, folds, ConsolidationUse::ClosedOutput, connected);
                assert_eq!(kept.positions, direct.positions, "round {round} switches {bits:03b}");
                assert_eq!(kept.indices, direct.indices, "round {round} switches {bits:03b}");
            }
            assert_eq!(subs.0.len(), 8, "round {round}");
        }
    }
}
