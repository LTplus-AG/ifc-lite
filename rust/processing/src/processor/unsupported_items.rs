// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Fold one job's dropped-representation-item counts into the pass-wide
//! collector. Split out of `jobs.rs` (module-size ratchet).

use rustc_hash::FxHashMap;

pub(super) fn drain_unsupported_items(
    router: &ifc_lite_geometry::GeometryRouter,
    collector: &std::sync::Mutex<FxHashMap<String, u64>>,
) {
    let unsupported = router.take_unsupported_items();
    if unsupported.is_empty() {
        return;
    }
    if let Ok(mut acc) = collector.lock() {
        for (ifc_type, count) in unsupported {
            *acc.entry(ifc_type).or_insert(0) += count;
        }
    }
}

/// Native-path parity with the wasm console warning: a `tracing::warn!` when
/// this pass dropped at least one representation item, with a per-type
/// breakdown. No-op on a clean model.
pub(super) fn warn_if_dropped(unsupported_items: &FxHashMap<String, u64>) {
    if unsupported_items.is_empty() {
        return;
    }
    let total: u64 = unsupported_items.values().sum();
    let mut breakdown: Vec<(&String, &u64)> = unsupported_items.iter().collect();
    breakdown.sort_by(|a, b| b.1.cmp(a.1));
    let breakdown =
        breakdown.iter().map(|(ty, count)| format!("{ty}={count}")).collect::<Vec<_>>().join(" ");
    tracing::warn!(
        total_unsupported_items = total,
        %breakdown,
        "Representation items dropped (no processor, or the processor failed) — \
         these elements are missing or incomplete in the output"
    );
}
