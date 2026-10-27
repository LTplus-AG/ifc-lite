// SPDX-License-Identifier: MPL-2.0
//! M3 source authority. Exact/display meshes are never inputs to these oracles.
use super::{
    clipping::{clipped_area, convex_planes},
    prism::{self, Basis},
    quantities,
};
use ifc_lite_processing::AnalyticQuantitySources;

/// A source-derived post-cut expectation. Missing prism/bbox means unsupported,
/// never zero. Nominal bounds remain available for nonparallel/oblique prisms.
#[derive(Clone, Debug)]
pub struct OpeningExpectation {
    pub nominal_host_volume: f64,
    pub volume_bounds: [f64; 2],
    pub result_volume: Option<f64>,
    pub host_bbox: Option<[f64; 6]>,
    pub curved: bool,
}
/// The caller supplies the canonical, filtered cut set, not mesh-CSG groupings.
/// Nominal quantities apply only to complete extrusion bodies (no CSG operands).
pub fn expected(
    sources: &AnalyticQuantitySources,
    host: u32,
    cutters: &[u32],
) -> Option<OpeningExpectation> {
    let (host_volume, host_bbox) = nominal(sources, host)?;
    let cutter_volume = cutters
        .iter()
        .try_fold(0., |v, id| Some(v + nominal(sources, *id)?.0))?;
    if !host_volume.is_finite() || !cutter_volume.is_finite() {
        return None;
    }
    Some(OpeningExpectation {
        nominal_host_volume: host_volume,
        volume_bounds: [(host_volume - cutter_volume).max(0.), host_volume],
        result_volume: prism_result_volume(sources, host, cutters),
        curved: host_bbox.is_none(),
        host_bbox,
    })
}
fn nominal(sources: &AnalyticQuantitySources, id: u32) -> Option<(f64, Option<[f64; 6]>)> {
    let parts = sources.extrusion_definitions.instances.get(&id)?.len();
    if parts == 0 {
        return None;
    }
    quantities::expected(sources, id, parts)
}
/// Inclusion-exclusion over at most eight convex cutter values in each height
/// band. All right-extrusion axes must be parallel in WORLD space, including
/// opposing directions. The shared plane is host-relative to preserve georef.
pub fn prism_result_volume(
    sources: &AnalyticQuantitySources,
    host: u32,
    cutters: &[u32],
) -> Option<f64> {
    let first = sources
        .extrusion_definitions
        .instances
        .get(&host)?
        .first()?;
    let basis = Basis::new(&prism::profile_frame(sources, first)?)?;
    let hosts = prism::prisms(sources, host, &basis)?;
    let mut cuts = Vec::new();
    for id in cutters {
        for p in prism::prisms(sources, *id, &basis)? {
            if cuts.len() == 8 || p.loops.len() != 1 || !p.loops[0].0 {
                return None;
            }
            let planes = convex_planes(&p.loops[0].1)?;
            cuts.push((p, planes));
        }
    }
    let mut result = 0.;
    let mut work = 10_000_000usize;
    for host in hosts {
        let mut bands = vec![host.low, host.high];
        for (c, _) in &cuts {
            for z in [c.low, c.high] {
                if z > host.low && z < host.high {
                    bands.push(z);
                }
            }
        }
        bands.sort_by(f64::total_cmp);
        bands.dedup();
        let host_area = host
            .loops
            .iter()
            .map(|(outer, edges)| {
                (if *outer { 1. } else { -1. })
                    * edges.iter().map(|e| e.integral()).sum::<f64>().abs()
            })
            .sum::<f64>();
        for band in bands.windows(2) {
            let middle = (band[0] + band[1]) / 2.;
            let active: Vec<_> = cuts
                .iter()
                .filter(|(c, _)| c.low < middle && c.high > middle)
                .collect();
            let mut removed = 0.;
            for mask in 1usize..(1 << active.len()) {
                let mut planes = Vec::new();
                for (i, (_, ps)) in active.iter().enumerate() {
                    if mask & (1 << i) != 0 {
                        planes.extend_from_slice(ps);
                    }
                }
                let mut area = 0.;
                for (outer, edges) in &host.loops {
                    area +=
                        (if *outer { 1. } else { -1. }) * clipped_area(edges, &planes, &mut work)?;
                }
                let sign = if mask.count_ones().is_multiple_of(2) {
                    -1.
                } else {
                    1.
                };
                removed += sign * area;
            }
            result += (band[1] - band[0]) * (host_area - removed);
        }
    }
    (result.is_finite() && result >= -1e-9).then_some(result.max(0.))
}
/// Positive protrusion distance; shrinking bounds are allowed. Nonfinite or
/// inverted result bounds fail closed rather than passing comparison with NaN.
pub fn bbox_excess(result: &[f64; 6], host: &[f64; 6]) -> f64 {
    if result.iter().chain(host).any(|x| !x.is_finite())
        || (0..3).any(|i| result[i] > result[i + 3] || host[i] > host[i + 3])
    {
        return f64::INFINITY;
    }
    (0..3)
        .map(|i| (host[i] - result[i]).max(result[i + 3] - host[i + 3]))
        .fold(0., f64::max)
}
/// Relative distance outside nominal bounds, scaled by the HOST volume so a
/// zero lower bound does not erase a meaningful error or divide by zero.
pub fn volume_bounds_relative(actual: f64, bounds: [f64; 2]) -> f64 {
    if !actual.is_finite()
        || bounds.iter().any(|x| !x.is_finite())
        || bounds[0] < 0.
        || bounds[1] < bounds[0]
    {
        return f64::INFINITY;
    }
    let excess = (bounds[0] - actual).max(actual - bounds[1]).max(0.);
    if excess == 0. {
        0.
    } else if bounds[1] == 0. {
        f64::INFINITY
    } else {
        excess / bounds[1]
    }
}
