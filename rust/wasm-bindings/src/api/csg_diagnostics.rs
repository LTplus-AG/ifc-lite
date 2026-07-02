// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/// Cap on the number of worst-failing hosts surfaced as per-product detail in
/// the typed [`ifc_lite_geometry::GeometryDiagnostics`] (keeps the payload
/// bounded on pathological models). The aggregate scalars stay exact; this only
/// bounds the optional detail list.
const WORST_HOSTS_LIMIT: usize = 16;

/// Drain CSG / opening-classification / per-host diagnostics from the router and
/// emit them to the browser console. Returns the typed
/// [`ifc_lite_geometry::GeometryDiagnostics`] built from the same single drain
/// (the console output is a side-effect; the typed value is what callers consume).
///
/// Always emits the classifier summary at `console.debug`; emits the
/// failure summary at `console.warn` only when there's at least one
/// failure to report. Per-host detail is included for the worst-failing
/// products (capped to keep the log readable on large files).
pub(super) fn drain_and_log_csg_diagnostics(
    router: &ifc_lite_geometry::GeometryRouter,
    // Failures already drained per element by the canonical producer
    // (`ifc_lite_processing::element` empties the warm batch router after
    // every element so failures can't bleed between elements). Merged with
    // whatever still sits on the router (non-canonical paths).
    collected_failures: rustc_hash::FxHashMap<u32, Vec<ifc_lite_geometry::BoolFailure>>,
) -> ifc_lite_geometry::GeometryDiagnostics {
    let cls = router.take_classification_stats();
    let mut csg_failures = router.take_csg_failures();
    for (product_id, fails) in collected_failures {
        csg_failures.entry(product_id).or_default().extend(fails);
    }
    let host_diags = router.take_host_opening_diagnostics();

    let cls_total = cls.rectangular + cls.diagonal + cls.non_rectangular;
    let total_failures: usize = csg_failures.values().map(|v| v.len()).sum();

    // Only emit the headline at WARN level when the kernel actually
    // dropped a cut. Zero-failure parses shouldn't spam every embedded
    // viewer. The full diagnostics summary is still returned to JS so
    // callers can opt into deeper inspection.
    if total_failures > 0 {
        web_sys::console::warn_1(
            &format!(
                "[IFC-LITE] CSG diagnostics: {cls_total} openings classified, \
                 {total_failures} failures, {} hosts tracked",
                host_diags.len()
            )
            .into(),
        );
    }

    if cls_total > 0 {
        // info_1, not debug_1 — DevTools hides `debug` by default ("Verbose"
        // log level), so a debug-only summary effectively never reaches
        // users investigating a model. The classifier headline + per-host
        // roll-up are always emitted at `info` so they show up in the
        // default "All levels" view; the noisy detail (failure breakdown,
        // worst-failing list) stays at `warn` and only fires when there
        // is a failure to surface.
        web_sys::console::info_1(
            &format!(
                "[IFC-LITE] Opening classifier: rect={} diag={} non_rect={} \
                 floor_opening_guard_saved={} (total={cls_total})",
                cls.rectangular, cls.diagonal, cls.non_rectangular, cls.floor_opening_guard_saved
            )
            .into(),
        );
    }

    let products_with_failures = csg_failures.len();

    if total_failures > 0 || !host_diags.is_empty() {
        // Per-reason breakdown for the warn line.
        let mut by_reason: std::collections::HashMap<&'static str, usize> =
            std::collections::HashMap::new();
        for fails in csg_failures.values() {
            for f in fails {
                *by_reason.entry(f.reason.label()).or_insert(0) += 1;
            }
        }
        let mut breakdown: Vec<(&'static str, usize)> = by_reason.into_iter().collect();
        breakdown.sort_by(|a, b| b.1.cmp(&a.1));

        // Per-host-type aggregate: how many of each host type had openings,
        // how many had failures, and which kinds dominated.
        let mut by_host_type: std::collections::HashMap<
            String,
            (usize, usize, usize, usize, usize),
        > = std::collections::HashMap::new();
        for hd in host_diags.values() {
            let entry = by_host_type
                .entry(hd.host_type.clone())
                .or_insert((0, 0, 0, 0, 0));
            entry.0 += 1; // hosts
            entry.1 += hd.openings.len(); // openings
            for op in &hd.openings {
                match op.kind {
                    ifc_lite_geometry::OpeningKindDiag::Rectangular => entry.2 += 1,
                    ifc_lite_geometry::OpeningKindDiag::Diagonal => entry.3 += 1,
                    ifc_lite_geometry::OpeningKindDiag::NonRectangular => entry.4 += 1,
                }
            }
        }
        let mut host_type_lines: Vec<String> = by_host_type
            .iter()
            .map(|(t, c)| {
                format!(
                    "{t}: hosts={} openings={} (rect={} diag={} non_rect={})",
                    c.0, c.1, c.2, c.3, c.4
                )
            })
            .collect();
        host_type_lines.sort();

        // Worst-failing hosts: top 10 by csg_failure_count.
        let mut worst: Vec<(u32, &ifc_lite_geometry::HostOpeningDiagnostic)> =
            host_diags.iter().map(|(k, v)| (*k, v)).collect();
        worst.sort_by(|a, b| b.1.csg_failure_count.cmp(&a.1.csg_failure_count));
        let worst_lines: Vec<String> = worst
            .iter()
            .take(10)
            .filter(|(_, hd)| hd.csg_failure_count > 0)
            .map(|(pid, hd)| {
                let kinds: Vec<&str> = hd.openings.iter().map(|o| o.kind.as_str()).collect();
                format!(
                    "  #{pid} {} — {} openings [{}], {} CSG failure(s) ({})",
                    hd.host_type,
                    hd.openings.len(),
                    kinds.join(","),
                    hd.csg_failure_count,
                    hd.first_failure_label.as_deref().unwrap_or("?"),
                )
            })
            .collect();

        // Silent-no-op detection: hosts where `apply_void_context` ran
        // but the triangle count came out unchanged despite having
        // rectangular boxes to cut. Strong signal that the box geometry
        // didn't intersect the host (placement bug, transform issue,
        // wrong opening shape) — the AABB clip path doesn't record a
        // BoolFailure because the kernel never engages.
        let mut silent_noops: Vec<(u32, &ifc_lite_geometry::HostOpeningDiagnostic)> = host_diags
            .iter()
            .filter_map(|(pid, hd)| {
                let before = hd.tris_before?;
                let after = hd.tris_after?;
                if before == after && hd.rect_boxes_processed > 0 {
                    Some((*pid, hd))
                } else {
                    None
                }
            })
            .collect();
        silent_noops.sort_by(|a, b| b.1.rect_boxes_processed.cmp(&a.1.rect_boxes_processed));
        let silent_noop_total = silent_noops.len();
        let silent_noop_lines: Vec<String> = silent_noops
            .iter()
            .take(8)
            .map(|(pid, hd)| {
                let bounds = hd
                    .host_bounds
                    .map(|((x0, y0, z0), (x1, y1, z1))| {
                        format!(
                            "host bounds=({:.2},{:.2},{:.2})..({:.2},{:.2},{:.2})",
                            x0, y0, z0, x1, y1, z1
                        )
                    })
                    .unwrap_or_else(|| "host bounds=?".into());
                format!(
                    "  #{pid} {} — {} rect boxes, tris={}→{} (NO CHANGE), {}",
                    hd.host_type,
                    hd.rect_boxes_processed,
                    hd.tris_before.unwrap_or(0),
                    hd.tris_after.unwrap_or(0),
                    bounds,
                )
            })
            .collect();

        // Surface silent-no-ops at warn level whenever any are detected,
        // independent of CSG failure count. This is the highest-signal
        // diagnostic for a "0 failures but visually un-cut" model like
        // Smiley-West — the cut pipeline ran clean but the geometry
        // came out unchanged.
        if silent_noop_total > 0 {
            web_sys::console::warn_1(
                &format!(
                    "[IFC-LITE] Rectangular cut SILENT NO-OP on {silent_noop_total} hosts \
                     (rect boxes processed but mesh unchanged — likely opening box \
                     doesn't intersect host). Top {} (by box count):\n{}",
                    silent_noop_lines.len(),
                    silent_noop_lines.join("\n"),
                )
                .into(),
            );
        }

        if total_failures > 0 {
            web_sys::console::warn_1(
                &format!(
                    "[IFC-LITE] CSG fallbacks: {total_failures} failures across \
                     {products_with_failures} products. \
                     Breakdown: {breakdown:?}.\n\
                     By host type:\n  {}\n\
                     Worst-failing hosts (top 10):\n{}",
                    host_type_lines.join("\n  "),
                    if worst_lines.is_empty() {
                        "  (none)".into()
                    } else {
                        worst_lines.join("\n")
                    },
                )
                .into(),
            );
        } else {
            // No failures but we still have host data. info_1 (not debug)
            // so devs can confirm at a glance that the void-subtraction
            // path engaged for this model and which host types had
            // openings.
            web_sys::console::info_1(
                &format!(
                    "[IFC-LITE] Opening pipeline: 0 CSG failures. \
                     {} hosts with openings.\n  {}",
                    host_diags.len(),
                    host_type_lines.join("\n  "),
                )
                .into(),
            );
        }
    }

    // rect_fast (analytic rectangular-opening fast path) engagement for this
    // batch: fire-rate + why it deferred, so the optimization is VISIBLE in the
    // console. Absence of this line on a build that has it means nothing fired
    // AND nothing deferred (no rect-opening hosts in the batch); presence with
    // fired=0 + high host_not_box means the walls aren't clean axis-aligned
    // boxes (multi-layer / non-box) and correctly fell back to the exact kernel.
    let rf = router.take_rect_fast_stats();
    if rf.fired > 0
        || rf.defer_host_not_box > 0
        || rf.defer_not_through > 0
        || rf.defer_off_face > 0
        || rf.defer_near_edge > 0
    {
        web_sys::console::info_1(
            &format!(
                "[IFC-LITE] rect_fast: fired={} (cut {} openings) | deferred: \
                 host_not_box={} not_through={} off_face={} near_edge={}",
                rf.fired,
                rf.openings_cut,
                rf.defer_host_not_box,
                rf.defer_not_through,
                rf.defer_off_face,
                rf.defer_near_edge,
            )
            .into(),
        );
    }

    // The console logging above is the human-facing surface; this is the typed,
    // serializable contract the worker/event path consumes (built from the same
    // single drain — `rf`/`cls`/`csg_failures`/`host_diags` are not re-taken).
    ifc_lite_geometry::aggregate_diagnostics(cls, &csg_failures, &host_diags, rf, WORST_HOSTS_LIMIT)
}
