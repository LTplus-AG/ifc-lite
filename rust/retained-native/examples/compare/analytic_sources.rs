// SPDX-License-Identifier: MPL-2.0
use ifc_lite_processing::{extract_analytic_quantity_sources, AnalyticQuantitySources};
use std::collections::{BTreeSet, HashSet};

const OVER_BUDGET: &str = "exceed total output budget";
fn over_budget(sources: &AnalyticQuantitySources) -> HashSet<u32> {
    [&sources.extrusion_definitions.diagnostics, &sources.swept_disk_definitions.diagnostics, &sources.swept_disk_descriptions.diagnostics]
        .into_iter().flatten().filter(|d| d.contains(OVER_BUDGET))
        // A budget line naming no product would hide an omission: fail loudly instead.
        .map(|d| d.strip_prefix("product #").and_then(|d| d.split(':').next()?.parse().ok())
            .unwrap_or_else(|| panic!("an output-budget diagnostic names no product: {d}"))).collect()
}
/// Every product's analytic sources. One walk has a whole-call output budget and omits
/// each product past it (#7955: Holter Tower's last 1.2k voided hosts, clipped and layered
/// products had no source at all), so the omitted products get walks of their own. A
/// product that alone exceeds the budget stays named in `diagnostics`.
pub fn analytic_sources(bytes: &[u8]) -> AnalyticQuantitySources {
    let mut all = extract_analytic_quantity_sources(bytes, None);
    let mut omitted = over_budget(&all);
    while !omitted.is_empty() {
        let next = extract_analytic_quantity_sources(bytes, Some(&omitted));
        let left = over_budget(&next);
        if left.len() >= omitted.len() { break; }
        all.extrusion_definitions.diagnostics.retain(|d| !d.contains(OVER_BUDGET));
        all.swept_disk_definitions.diagnostics.retain(|d| !d.contains(OVER_BUDGET));
        all.swept_disk_descriptions.diagnostics.retain(|d| !d.contains(OVER_BUDGET));
        merge(&mut all, next);
        omitted = left;
    }
    all
}
fn merge(all: &mut AnalyticQuantitySources, next: AnalyticQuantitySources) {
    let extrusions = &mut all.extrusion_definitions;
    let known: BTreeSet<_> = extrusions.sources.iter().map(|s| s.key.clone()).collect();
    extrusions.sources.extend(next.extrusion_definitions.sources.into_iter().filter(|s| !known.contains(&s.key)));
    extrusions.instances.extend(next.extrusion_definitions.instances);
    extrusions.diagnostics.extend(next.extrusion_definitions.diagnostics);
    let disks = &mut all.swept_disk_definitions;
    let known: BTreeSet<_> = disks.sources.iter().map(|s| s.key.clone()).collect();
    disks.sources.extend(next.swept_disk_definitions.sources.into_iter().filter(|s| !known.contains(&s.key)));
    disks.instances.extend(next.swept_disk_definitions.instances);
    disks.diagnostics.extend(next.swept_disk_definitions.diagnostics);
    all.swept_disk_descriptions.elements.extend(next.swept_disk_descriptions.elements);
    all.swept_disk_descriptions.diagnostics.extend(next.swept_disk_descriptions.diagnostics);
}
