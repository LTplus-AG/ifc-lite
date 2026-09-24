// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `memory_admission_log_level`: which startup log line the memory gate gets.

use super::{memory_admission_log_level, LogDecision};

/// #1547: unset/unparseable `IFC_MEM_BUDGET_MB` (auto-detection found no
/// readable memory ceiling) must warn, not silently stay quiet.
#[test]
fn unset_warns() {
    assert_eq!(memory_admission_log_level(None), LogDecision::Warn);
}

/// `IFC_MEM_BUDGET_MB=0` is a deliberate opt-out, not a degradation.
#[test]
fn explicit_zero_is_opt_out_info() {
    assert_eq!(memory_admission_log_level(Some(0)), LogDecision::Info);
}

/// A positive explicit budget is neither the info nor the warn "gate
/// off" case (main's `config.mem_budget_mb == 0` guard means this
/// variant is never actually reached at the call site, but the pure
/// function itself must be total and correct over its whole domain).
#[test]
fn positive_budget_is_active() {
    assert_eq!(memory_admission_log_level(Some(1)), LogDecision::Active);
    assert_eq!(memory_admission_log_level(Some(4096)), LogDecision::Active);
}
