// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/// Cap on the number of worst-failing hosts surfaced as per-product detail in
/// the typed [`ifc_lite_geometry::GeometryDiagnostics`] (keeps the payload
/// bounded on pathological models). The aggregate scalars stay exact; this only
/// bounds the optional detail list.
const WORST_HOSTS_LIMIT: usize = 16;

use super::csg_console::{console_summary, Level};
use super::gpu_meshes::batch_host::{info, warn};

/// Products refused by the owned producer publish no meshes. Report the batch
/// count without attributing a cause; refusal can occur at any producer check.
/// Refused products are not counted as produced elements.
pub(super) fn warn_refused_products(refused: u64) {
    if refused > 0 {
        warn(&format!(
            "[IFC-LITE] geometry batch: {refused} product(s) refused by the canonical \
             producer; they publish no meshes"
        ));
    }
}

/// Drain CSG / opening-classification / per-host diagnostics from the router,
/// build the typed [`ifc_lite_geometry::GeometryDiagnostics`] from that single
/// drain, and print its console summary (`super::csg_console`). The typed value
/// is what callers consume; the console is formatted from it alone.
pub(super) fn drain_and_log_csg_diagnostics(
    router: &ifc_lite_geometry::GeometryRouter,
    // Failures already drained per element by the canonical producer
    // (`ifc_lite_processing::element` empties the warm batch router after
    // every element so failures can't bleed between elements). Merged with
    // whatever still sits on the router (non-canonical paths).
    collected_failures: rustc_hash::FxHashMap<u32, Vec<ifc_lite_geometry::BoolFailure>>,
) -> ifc_lite_geometry::GeometryDiagnostics {
    let diagnostics = drain_diagnostics(router, collected_failures);
    for (level, line) in console_summary(&diagnostics) {
        match level {
            Level::Info => info(&line),
            Level::Warn => warn(&line),
        }
    }
    diagnostics
}

/// One destructive drain of the router, aggregated. The router accessors
/// `mem::take`, so nothing here may be taken twice.
fn drain_diagnostics(
    router: &ifc_lite_geometry::GeometryRouter,
    collected_failures: rustc_hash::FxHashMap<u32, Vec<ifc_lite_geometry::BoolFailure>>,
) -> ifc_lite_geometry::GeometryDiagnostics {
    let drain = ifc_lite_processing::execution::RouterDrain::take(router);
    let mut csg_failures = router.take_csg_failures();
    for (product_id, fails) in collected_failures {
        csg_failures.entry(product_id).or_default().extend(fails);
    }
    ifc_lite_geometry::aggregate_diagnostics(
        drain.classification,
        &csg_failures,
        &drain.hosts,
        drain.rect_fast,
        WORST_HOSTS_LIMIT,
        drain.oversized_refs,
        &router.take_unsupported_items(),
    )
}
