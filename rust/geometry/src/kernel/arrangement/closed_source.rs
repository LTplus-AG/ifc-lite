// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::Tri;

// Shared exact incidence is a necessary precondition for NEW opposed-solid
// ownership, not a simplicity proof. Historical ordinary rays stay unchanged.
pub(super) fn strict_closed(tris: &[Tri]) -> bool {
    crate::exact_topology::strict_closed(tris.iter().copied())
}

#[cfg(test)]
#[path = "closed_source_tests.rs"]
mod tests;
