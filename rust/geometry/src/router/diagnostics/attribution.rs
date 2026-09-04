// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Who a CSG failure belongs to: the synthetic bucket for records with no
//! owner, and the one place that decides what counts as a failing PRODUCT.
//!
//! Split out of `router/diagnostics.rs` (module-size ratchet, #3821).

use crate::BoolFailure;
use rustc_hash::FxHashMap;

/// The `csg_failures` key used for records that belong to no single product:
/// the boolean processors' own logs (swept once per element by
/// [`GeometryRouter::drain_processor_failures`]) and
/// `PENDING_MAPPED_BOOL_FAILURES`. Zero is not a valid IFC express id, so it
/// cannot collide with a real product.
pub const UNATTRIBUTED_PRODUCT_ID: u32 = 0;

/// How many REAL products have at least one failure. The synthetic
/// [`UNATTRIBUTED_PRODUCT_ID`] bucket is excluded: it is not a product, and
/// counting it would report "1 product failed" for a model where the only
/// records came from an unattributed sweep. Its records still count towards
/// the failure TOTALS — they are real failures, only their owner is unknown.
///
/// One home, called from `aggregate_diagnostics` and from both pipelines'
/// legacy scalar (`ProcessingStats.products_with_failures`, the wasm console
/// summary), so the two cannot drift.
pub fn count_attributed_products(csg_failures: &FxHashMap<u32, Vec<BoolFailure>>) -> u64 {
    csg_failures
        .keys()
        .filter(|id| **id != UNATTRIBUTED_PRODUCT_ID)
        .count() as u64
}
