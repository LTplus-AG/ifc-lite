// SPDX-License-Identifier: MPL-2.0
//! M3 source authority. Exact/display meshes are never inputs to these oracles.
use super::{
    clipping::{clipped_area, convex_planes},
    math::{cross, sub, unit},
    prism::{self, Basis},
    quantities, section_net,
    sections::ExtrudedHost,
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
    // Parallel prisms integrate exactly; any other extrusion cutters go through section_net.
    let (result_volume, cut_arcs) = match prism_result_volume(sources, host, cutters) {
        Some(volume) => (Some(volume), false),
        None => section_result_volume(sources, host, cutters).map_or((None, false), |(v, arcs)| (Some(v), arcs)),
    };
    Some(OpeningExpectation {
        nominal_host_volume: host_volume,
        volume_bounds: [(host_volume - cutter_volume).max(0.), host_volume],
        result_volume,
        curved: host_bbox.is_none() || cut_arcs,
        host_bbox,
    })
}
/// Each unmodified host extrusion minus every cutter, and whether a cutter's arc was polygonised.
fn section_result_volume(sources: &AnalyticQuantitySources, host: u32, cutters: &[u32]) -> Option<(f64, bool)> {
    let definitions = &sources.extrusion_definitions;
    let mut cuts = Vec::new();
    let mut arcs = false;
    for id in cutters {
        for instance in definitions.instances.get(id)? {
            if instance.source_modified { return None; }
            let (pieces, curved) = section_net::extrusion_cutters(&ExtrudedHost::from_sources(sources, instance)?)?;
            cuts.push(pieces);
            arcs |= curved;
        }
    }
    let mut volume = 0.;
    for instance in definitions.instances.get(&host)? {
        if instance.source_modified { return None; }
        volume += section_net::net_volume(&ExtrudedHost::from_sources(sources, instance)?, &[], &cuts)?;
    }
    Some((volume, arcs))
}
fn nominal(sources: &AnalyticQuantitySources, id: u32) -> Option<(f64, Option<[f64; 6]>)> {
    let parts = sources.extrusion_definitions.instances.get(&id)?.len();
    if parts == 0 {
        return None;
    }
    quantities::expected(sources, id, parts)
}
/// [`expected`] for a host whose cutters are closed convex face sets, or extrusions beside them.
/// A non-convex or open set is not modelled: the caller keeps its counted gap (#7955).
pub fn expected_with_face_set_cutters(bundle: &std::sync::Arc<ifc_lite_core::SourceBundle>, sources: &AnalyticQuantitySources, host: u32, cutters: &[u32]) -> Option<OpeningExpectation> {
    let (host_volume, host_bbox) = nominal(sources, host)?;
    let mut cuts = Vec::new();
    let mut cutter_volume = 0.;
    let mut arcs = false;
    for &id in cutters {
        if sources.extrusion_definitions.instances.contains_key(&id) {
            cutter_volume += nominal(sources, id)?.0;
            for instance in &sources.extrusion_definitions.instances[&id] {
                if instance.source_modified { return None; }
                let (pieces, curved) = section_net::extrusion_cutters(&ExtrudedHost::from_sources(sources, instance)?)?;
                cuts.push(pieces);
                arcs |= curved;
            }
        } else {
            let (pieces, volume) = convex_face_set_cutters(bundle, sources, id)?;
            cuts.extend(pieces.into_iter().map(|cut| vec![cut]));
            cutter_volume += volume;
        }
    }
    let mut volume = 0.;
    for instance in sources.extrusion_definitions.instances.get(&host)? {
        if instance.source_modified { return None; }
        volume += section_net::net_volume(&ExtrudedHost::from_sources(sources, instance)?, &[], &cuts)?;
    }
    Some(OpeningExpectation { nominal_host_volume: host_volume, volume_bounds: [(host_volume - cutter_volume).max(0.), host_volume],
        result_volume: Some(volume), curved: host_bbox.is_none() || arcs, host_bbox })
}
/// Each Body item as the halfspaces of its authored rows, with their divergence-theorem volume.
fn convex_face_set_cutters(bundle: &std::sync::Arc<ifc_lite_core::SourceBundle>, sources: &AnalyticQuantitySources, id: u32) -> Option<(Vec<section_net::ConvexCut>, f64)> {
    use ifc_lite_geometry::{placement::resolve_object_placement, representation::{product_shape, rep_items, Select}, Matrix4, Point3};
    let mut decoder = bundle.decoder();
    let element = decoder.decode_by_id(id).ok()?;
    let shape = product_shape(&element, &mut decoder).ok()??;
    let scale = sources.extrusion_definitions.length_unit_scale;
    let mut world = resolve_object_placement(&element, &mut decoder).ok()?.unwrap_or_else(Matrix4::identity);
    for i in 0..3 { for j in 0..4 { world[(i, j)] *= scale; } }
    let (mut cuts, mut total) = (Vec::new(), 0.);
    for representation in shape.select(&element, Select::Meshed) {
        for item in rep_items(representation, &mut decoder).ok()? {
            if !matches!(item.ifc_type, ifc_lite_core::IfcType::IfcPolygonalFaceSet | ifc_lite_core::IfcType::IfcTriangulatedFaceSet) { return None; }
            let set = super::face_sets::authored(&item, &mut decoder, scale)?;
            if set.open_edges != 0 || set.rows.iter().any(|row| row.outer != row.points.len()) { return None; }
            // `world` scales raw file units; a row point is metres from the raw first point.
            let at = |p: [f64; 3]| { let q = world.transform_point(&Point3::new(p[0] / scale + set.first[0], p[1] / scale + set.first[1], p[2] / scale + set.first[2])); [q.x, q.y, q.z] };
            let points: Vec<[f64; 3]> = set.rows.iter().flat_map(|row| row.points.iter().map(|p| at(*p))).collect();
            let mut cut = Vec::new();
            let mut volume = 0.;
            let planes: Vec<([f64; 3], [f64; 3])> = set.rows.iter().filter_map(|row| {
                let ring: Vec<[f64; 3]> = row.points.iter().map(|p| at(*p)).collect();
                let (a, b, c) = (ring[0], ring[1], *ring.get(2)?);
                let n = cross(sub(b, a), sub(c, a));
                unit(n).map(|n| (a, n))
            }).collect();
            if planes.len() != set.rows.len() { return None; }
            for (row, (origin, normal)) in set.rows.iter().zip(planes) {
                let side = |p: &[f64; 3]| normal[0] * (p[0] - origin[0]) + normal[1] * (p[1] - origin[1]) + normal[2] * (p[2] - origin[2]);
                let (low, high) = points.iter().fold((0f64, 0f64), |(l, h), p| (l.min(side(p)), h.max(side(p))));
                if low < -1e-9 && high > 1e-9 { return None; }
                let outward = if high > 1e-9 { normal.map(|v| -v) } else { normal };
                let c = outward[0] * origin[0] + outward[1] * origin[1] + outward[2] * origin[2];
                cut.push((outward, c));
                volume += row.area_m2? * c / 3.;
            }
            cuts.push(cut);
            total += volume;
        }
    }
    (!cuts.is_empty()).then_some((cuts, total))
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
    cut_prisms_volume(hosts, cuts)
}

pub(super) fn cut_prisms_volume(hosts: Vec<prism::Prism>, cuts: Vec<(prism::Prism, Vec<super::clipping::HalfPlane>)>) -> Option<f64> {
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
