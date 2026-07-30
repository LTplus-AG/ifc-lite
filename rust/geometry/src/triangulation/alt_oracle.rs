// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Test-only differential oracle: a SECOND, independent ear-clipper.
//!
//! Both libraries give valid triangulations with the same boundary and area; only
//! the interior diagonals differ, and nothing downstream may depend on that
//! choice. `tests/triangulation_invariance.rs` measures whether anything does.
//!
//! Substituted at `safe_earcut`'s OWN `earcutr` call sites, never ahead of them, so
//! both triangulators receive the identical sanitised rings. Swapping earlier would
//! hand the oracle raw input and make the sweep partly measure `safe_earcut`'s
//! duplicate-stripping and hole classification rather than diagonal choice.
//!
//! Selection is an `AtomicBool`, not an env var: the library reads it per face on a
//! rayon-parallel hot path, and `std::env::set_var` is neither thread-safe nor safe
//! under edition 2024. The env var is honoured once, as an initialiser only.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Once;

static ALT: AtomicBool = AtomicBool::new(false);
static INIT: Once = Once::new();

/// Turn the oracle on or off for this process. Test-side driver.
pub fn set_alt_triangulator(on: bool) {
    INIT.call_once(|| {});
    ALT.store(on, Ordering::Relaxed);
}

fn armed() -> bool {
    INIT.call_once(|| {
        if std::env::var_os("IFCLITE_TRIANGULATION_ALT").is_some() {
            ALT.store(true, Ordering::Relaxed);
        }
    });
    ALT.load(Ordering::Relaxed)
}

/// `Some(indices)` when the oracle is armed, `None` to use the production path.
/// Signature mirrors `earcutr::earcut(data, hole_indices, 2)`.
pub(super) fn maybe_earcut(data: &[f64], hole_indices: &[usize]) -> Option<Vec<usize>> {
    if !armed() {
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
