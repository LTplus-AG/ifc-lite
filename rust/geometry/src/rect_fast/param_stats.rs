// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

static PARAM_FIRES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Count one parametric fast-path fire (the analytic cut was emitted).
pub fn param_record_fire() {
    crate::telemetry_transaction::record(|| {
        PARAM_FIRES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    });
}
/// Read + reset the parametric fast-path fire counter.
pub fn take_param_fires() -> u64 {
    PARAM_FIRES.swap(0, std::sync::atomic::Ordering::Relaxed)
}
