// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Test-only differential oracle: a SECOND, independent ear-clipper.
//!
//! Both libraries give valid triangulations with the same boundary and area; only
//! the interior diagonals differ, and nothing downstream may depend on that choice.
//! `tests/triangulation_invariance.rs` measures whether anything does. Selected at
//! run time by `IFCLITE_TRIANGULATION_ALT` so one process can do both.
//!
//! Split out of `triangulation.rs` to keep it under the module-size ratchet.

/// `Some(indices)` when the oracle is armed, `None` to use the production path.
pub(super) fn maybe_earcut(data: &[f64], hole_indices: &[usize]) -> Option<Vec<usize>> {
    if std::env::var_os("IFCLITE_TRIANGULATION_ALT").is_none() {
        return None;
    }
    let mut out: Vec<usize> = Vec::new();
    let mut ec = earcut::Earcut::new();
    ec.earcut(
        data.chunks_exact(2).map(|c| [c[0], c[1]]),
        hole_indices,
        &mut out,
    );
    Some(out)
}
