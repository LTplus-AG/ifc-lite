// SPDX-License-Identifier: MPL-2.0
//! Harness-only source cut sets and gates. Product execution does not call this.
use ifc_lite_core::{EntityScanner, SourceBundle};
use ifc_lite_geometry::GeometryRouter;
use ifc_lite_processing::{
    prepass::{resolve_prepass, PrepassSpans, ResolveOptions},
    AnalyticQuantitySources,
};
use ifc_lite_retained_native::oracle::openings::{self, OpeningExpectation};
use serde_json::Value;
use std::collections::BTreeMap;

pub fn expectations(
    bytes: &[u8],
    sources: &AnalyticQuantitySources,
) -> Result<BTreeMap<u32, Option<OpeningExpectation>>, String> {
    let source = SourceBundle::new(bytes.to_vec());
    let mut decoder = source.decoder();
    let mut scanner = EntityScanner::new(bytes);
    let mut spans = PrepassSpans::default();
    while let Some((id, name, start, end)) = scanner.next_entity() {
        spans.stash(name, id, start, end);
    }
    let prepass = resolve_prepass(&spans, &mut decoder, ResolveOptions::default());
    let router = GeometryRouter::with_scale(decoder.length_unit_scale());
    let mut result = BTreeMap::new();
    for (host, ids) in prepass.void_index {
        let mut cuts = Vec::new();
        for id in ids {
            let _opening = decoder
                .decode_by_id(id)
                .map_err(|e| format!("opening #{id}: {e}"))?;
            if router.opening_requires_subtraction(id, &mut decoder) {
                cuts.push(id);
            }
        }
        if !cuts.is_empty() {
            result.insert(host, openings::expected(sources, host, &cuts));
        }
    }
    Ok(result)
}
pub fn check(
    label: &str,
    actual: &super::metrics::Metrics,
    e: &OpeningExpectation,
    t: &Value,
    violations: &mut Vec<String>,
) -> Option<f64> {
    let kind = if e.curved { "curved" } else { "linear" };
    let rel = e
        .result_volume
        .map(|v| super::metrics::relative(actual.volume, v));
    if rel.is_some_and(|v| {
        !v.is_finite() || v > t["openingPrismVolumeRelative"][kind].as_f64().unwrap_or(0.)
    }) {
        violations.push(format!("{label}: opening prism volume deviation {rel:?}"));
    }
    let bounds = openings::volume_bounds_relative(actual.volume, e.volume_bounds);
    if !bounds.is_finite()
        || bounds
            > t["openingVolumeBoundsRelative"][kind]
                .as_f64()
                .unwrap_or(0.)
    {
        violations.push(format!(
            "{label}: opening volume outside nominal bounds {bounds}"
        ));
    }
    if let Some(host) = e.host_bbox {
        let extent = (0..3).map(|i| host[i + 3] - host[i]).fold(0., f64::max);
        let limit = t["openingResultBboxWithinHost"]["absolute"]
            .as_f64()
            .unwrap_or(0.)
            + extent
                * t["openingResultBboxWithinHost"]["extentFactor"]
                    .as_f64()
                    .unwrap_or(0.);
        let excess = openings::bbox_excess(&actual.bbox, &host);
        if !excess.is_finite() || excess > limit {
            violations.push(format!(
                "{label}: opening result outside host bbox {excess}"
            ));
        }
    }
    rel
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn m3_source_gates_detect_cut_errors_and_allow_shrunken_bbox() {
        let t: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/cli-retained/tolerances.json"
        ))
        .unwrap();
        // Hand box: host 4*2*3=24, cutter 1*2*1=2, remaining 22.
        let e = OpeningExpectation {
            nominal_host_volume: 24.,
            volume_bounds: [22., 24.],
            result_volume: Some(22.),
            host_bbox: Some([0., 0., 0., 4., 2., 3.]),
            curved: false,
        };
        let mut m = super::super::metrics::Metrics {
            volume: 22.,
            area: 0.,
            bbox: [0.1, 0., 0., 3.9, 2., 3.],
            defects: 0,
        };
        let mut violations = Vec::new();
        assert_eq!(check("box", &m, &e, &t, &mut violations), Some(0.));
        assert!(violations.is_empty());
        m.volume = 21.;
        m.bbox[0] = -1.;
        check("bad", &m, &e, &t, &mut violations);
        assert_eq!(violations.len(), 3); // prism, lower bound and containment all act.
    }
}
