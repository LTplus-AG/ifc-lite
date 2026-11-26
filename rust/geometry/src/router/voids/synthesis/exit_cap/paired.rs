// SPDX-License-Identifier: MPL-2.0

use super::{Cap, CutterFrame, ExitCaps};
use crate::router::voids::prism_cut::paired_cap::paired_exact_jambs;
use crate::Mesh;

/// A paired source face already floors a flush recess, so preserve the
/// authored cap in the exact cutter instead of pulling it into the recess.
pub(super) fn retain_floor(mut caps: ExitCaps, host: &Mesh, frame: &CutterFrame) -> ExitCaps {
    let jambs = [matches!(caps.min, Cap::Jamb), matches!(caps.max, Cap::Jamb)];
    if jambs[0] || jambs[1] {
        let axes = [
            frame.frame.cross_a.into(),
            frame.frame.cross_b.into(),
            frame.frame.depth.into(),
        ];
        let paired = paired_exact_jambs(
            host,
            axes,
            frame.lo.coords.into(),
            frame.hi.coords.into(),
            jambs,
        );
        if paired[0] {
            caps.min = Cap::Free;
        }
        if paired[1] {
            caps.max = Cap::Free;
        }
    }
    caps
}
