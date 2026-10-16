// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.


//! Recovery convergence is a full pass with no missing edge, not net mesh equality.
use crate::kernel::{budget, interner::{Interner, Vid}, retriangulate::Mesh2d,
    retriangulate_recover::enforce_constraint};

pub(super) fn recover(mesh: &mut Mesh2d, interner: &Interner, segments: &[(Vid, Vid)]) -> bool {
    for _pass in 0..4 {
        if budget::tripped() { break; }
        let mut attempted = false;
        for &(s, t) in segments {
            if budget::tripped() { break; }
            // Eager OR: every original constraint is visited in its old order.
            attempted |= enforce_constraint(mesh, interner, s, t);
        }
        if !attempted { return true; }
    }
    // Includes a net-unchanged cycle: the caller must use the existing audit.
    false
}
