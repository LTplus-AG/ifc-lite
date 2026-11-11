// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The caps [`super::begin`] and [`super::begin_element`] snapshot, resolved in
//! one place so `crate::output_policy` keys exactly what the kernel enforces.

use super::{cap, element_cap, env_cap, env_element_cap};

/// The per-boolean cap [`super::begin`] snapshots (`u64::MAX` = unbounded): the
/// `IFC_LITE_CSG_BUDGET` override if set (`0` = unbounded), else [`cap`]. The
/// one resolution, shared with `crate::output_policy`.
pub fn effective_op_cap() -> u64 {
    let cap = match env_cap() {
        Some(v) => v, // env override wins (0 = unbounded)
        None => cap().unwrap_or(0),
    };
    if cap == 0 { u64::MAX } else { cap }
}

/// The per-element cap [`super::begin_element`] snapshots (`u64::MAX` = unbounded):
/// unbounded whenever the per-boolean profile is (server / offline export),
/// else the `IFC_LITE_CSG_ELEMENT_BUDGET` override or [`element_cap`].
pub fn effective_element_cap() -> u64 {
    let boolean_unbounded = match env_cap() {
        Some(v) => v == 0,
        None => cap().is_none(),
    };
    let elem_cap = if boolean_unbounded {
        0
    } else {
        match env_element_cap() {
            Some(v) => v, // override (0 = unbounded)
            None => element_cap().unwrap_or(0),
        }
    };
    if elem_cap == 0 { u64::MAX } else { elem_cap }
}

