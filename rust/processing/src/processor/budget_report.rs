// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The native run's work-budget refusal warning (#9268), beside
//! [`super::diagnostics::warn_if_dropped`]: the viewer, the TS CLI and the
//! wasm console all print one, and a native load must not be quieter.

use ifc_lite_geometry::GeometryDiagnostics;

/// One line per kept refusal detail, then `and N more` when the complete
/// count exceeds the details: the same lines the wasm console prints.
pub(super) fn budget_refusal_lines(d: &GeometryDiagnostics) -> Vec<String> {
    let mut lines: Vec<String> = d.budget_refusals.iter().map(|r| format!(
        "Work budget refusal: {} limit={} reached={} product=#{} {} GlobalId={} source=#{}",
        r.budget, r.limit, r.reached,
        r.product_id.map_or_else(|| "unknown".into(), |id| id.to_string()),
        r.product_type.as_deref().unwrap_or("unknown"),
        r.global_id.as_deref().unwrap_or("unavailable"), r.source_id,
    )).collect();
    let more = d.total_budget_refusals.saturating_sub(d.budget_refusals.len() as u64);
    if more > 0 {
        lines.push(format!("Work budget refusals: and {more} more"));
    }
    lines
}

/// Warn once per line when work budgets refused representations: those
/// elements are missing or incomplete in the output, and not as unsupported.
pub(super) fn warn_if_refused(d: &GeometryDiagnostics) {
    // The wasm engine prints these lines through its own console summary
    // (wasm-bindings csg_console); a constant check keeps this code out of it.
    if cfg!(target_arch = "wasm32") {
        return;
    }
    for line in budget_refusal_lines(d) {
        tracing::warn!(total_budget_refusals = d.total_budget_refusals, "{line} — missing or incomplete in the output");
    }
}

#[cfg(test)]
mod tests {
    use super::budget_refusal_lines;
    use ifc_lite_geometry::GeometryDiagnostics;

    #[test]
    fn issue_9268_native_summary_names_each_refusal_and_the_rest() {
        let mut d = GeometryDiagnostics::default();
        assert!(budget_refusal_lines(&d).is_empty(), "no refusals, no warning");
        d.total_budget_refusals = 3;
        d.budget_refusals = vec![serde_json::from_value(serde_json::json!({
            "budget": "logical mapped attempts", "limit": 3, "reached": 4, "sourceId": 8,
            "productId": 25, "productType": "IfcWall", "GlobalId": null,
        })).unwrap()];
        assert_eq!(budget_refusal_lines(&d), [
            "Work budget refusal: logical mapped attempts limit=3 reached=4 product=#25 IfcWall GlobalId=unavailable source=#8",
            "Work budget refusals: and 2 more",
        ]);
    }
}
