// SPDX-License-Identifier: MPL-2.0
//! M11-F source authority for persistent face keys and their areas (#7955).
//! Keys and areas come from the canonical analytic source walk only: profile
//! loops/segments in authored order, the authored depth and direction, and the
//! instance frames. Retained requests, payloads and meshes are never inputs.
use super::clipping::Edge;
use super::math::{cross, dot, transform, vector, multiply, IDENTITY};
use ifc_lite_geometry::analytic::{AnalyticCurveSegment, AnalyticStatus, ProfileLoopKind};
use ifc_lite_processing::{AnalyticQuantitySources, ExtrusionInstance};
use std::collections::BTreeMap;

/// One expected source face: its area in world square metres, and whether a
/// tessellation of it is chordal (an arc, a circle, a disk or an arc-bounded cap).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FaceArea { pub area_m2: f64, pub curved: bool }
pub type FaceAreas = BTreeMap<String, FaceArea>;

pub(super) fn key(item: u32, via: u32, role: &str) -> String {
    if via == 0 { format!("#{item}:{role}") } else { format!("#{item}>#{via}:{role}") }
}
pub(super) fn add(areas: &mut FaceAreas, key: String, area_m2: f64, curved: bool) {
    let face = areas.entry(key).or_insert(FaceArea { area_m2: 0., curved });
    face.area_m2 += area_m2;
    face.curved |= curved;
}
/// Uniform scale of a proper similarity frame, else `None` (no prediction).
pub(super) fn scale(frame: &[f64; 16]) -> Option<f64> {
    let columns = [0, 1, 2].map(|c| vector(frame, std::array::from_fn(|i| f64::from(u8::from(i == c)))));
    let s = dot(columns[0], columns[0]).sqrt();
    let orthogonal = (0..3).all(|i| (0..3).all(|j| {
        let expected = if i == j { s * s } else { 0. };
        (dot(columns[i], columns[j]) - expected).abs() <= 1e-9 * s * s
    }));
    (orthogonal && s.is_finite() && s > 0. && dot(cross(columns[0], columns[1]), columns[2]) > 0.).then_some(s)
}
pub(super) fn profile_edge(segment: &AnalyticCurveSegment) -> Option<Edge> {
    match *segment {
        AnalyticCurveSegment::Line { start, end } => Some(Edge::Line([start[0], start[1]], [end[0], end[1]])),
        AnalyticCurveSegment::Arc { center, normal, x_axis, radius, start_angle, sweep_angle } => {
            let y = cross(normal, x_axis);
            (normal[0] == 0. && normal[1] == 0.).then_some(Edge::Arc { c: [center[0], center[1]],
                u: [x_axis[0] * radius, x_axis[1] * radius], v: [y[0] * radius, y[1] * radius],
                a: start_angle, sweep: sweep_angle })
        }
    }
}

/// `∫ |T(θ) × E| dθ` over one swept profile curve, by composite Simpson (smooth integrand).
fn side_area(frame: &[f64; 16], edge: &Edge, extrusion: [f64; 3]) -> f64 {
    match *edge {
        Edge::Line(a, b) => {
            let chord = vector(frame, [b[0] - a[0], b[1] - a[1], 0.]);
            let c = cross(chord, extrusion);
            dot(c, c).sqrt()
        }
        Edge::Arc { u, v, a, sweep, .. } => {
            let n = 4096;
            let f = |t: f64| {
                let (s, co) = (a + t * sweep).sin_cos();
                let tangent = vector(frame, [(-u[0] * s + v[0] * co) * sweep, (-u[1] * s + v[1] * co) * sweep, 0.]);
                let c = cross(tangent, extrusion);
                dot(c, c).sqrt()
            };
            (0..=n).map(|i| f(i as f64 / n as f64) * if i == 0 || i == n { 1. } else if i % 2 == 1 { 4. } else { 2. })
                .sum::<f64>() / (3. * n as f64)
        }
    }
}

/// Every face of an UNCUT product whose bodies are complete authored extrusions
/// or line-directrix swept disks. `None` means "no source prediction", never zero.
pub fn uncut(sources: &AnalyticQuantitySources, product: u32) -> Option<FaceAreas> {
    let mut areas = FaceAreas::new();
    let extrusions = sources.extrusion_definitions.instances.get(&product).map_or(&[][..], Vec::as_slice);
    let disks = sources.swept_disk_definitions.instances.get(&product).map_or(&[][..], Vec::as_slice);
    if extrusions.is_empty() && disks.is_empty() { return None; }
    for instance in extrusions { extrusion(sources, instance, &mut areas)?; }
    for instance in disks { disk(sources, instance, &mut areas)?; }
    Some(areas)
}
fn extrusion(sources: &AnalyticQuantitySources, instance: &ExtrusionInstance, areas: &mut FaceAreas) -> Option<()> {
    if instance.source_modified || instance.status != AnalyticStatus::Complete { return None; }
    let source = &sources.extrusion_definitions.sources.iter().find(|s| s.key == instance.source)?.source;
    let profile = source.profile.as_ref()?;
    let solid = multiply(&instance.world_from_source?, source.position_matrix.as_ref().unwrap_or(&IDENTITY));
    let frame = multiply(&solid, profile.profile_position.as_ref().unwrap_or(&IDENTITY));
    let s = scale(&frame)?;
    let depth = source.depth?;
    let extrusion = vector(&solid, source.axis_unit_vector?.map(|a| a * depth));
    let (mut net, mut arcs) = (0., false);
    for (index, boundary) in profile.loops.iter().enumerate() {
        let edges = boundary.segments.iter().map(profile_edge).collect::<Option<Vec<_>>>()?;
        for (segment, edge) in edges.iter().enumerate() {
            let curved = matches!(edge, Edge::Arc { .. });
            arcs |= curved;
            add(areas, key(source.solid_id, 0, &format!("side({index},{segment})")), side_area(&frame, edge, extrusion), curved);
        }
        let area = edges.iter().map(Edge::integral).sum::<f64>().abs();
        net += if boundary.kind == ProfileLoopKind::Outer { area } else { -area };
    }
    for role in ["cap(start)", "cap(end)"] { add(areas, key(source.solid_id, 0, role), net * s * s, arcs); }
    Some(())
}
fn disk(sources: &AnalyticQuantitySources, instance: &ExtrusionInstance, areas: &mut FaceAreas) -> Option<()> {
    if instance.source_modified || instance.status != AnalyticStatus::Complete { return None; }
    let source = sources.swept_disk_definitions.sources.iter().find(|s| s.key == instance.source)?;
    let frame = instance.world_from_source?;
    let s = scale(&frame)?;
    let [AnalyticCurveSegment::Line { start, end }] = source.directrix.as_slice() else { return None };
    let (a, b) = (transform(&frame, *start), transform(&frame, *end));
    let length = dot(super::math::sub(b, a), super::math::sub(b, a)).sqrt();
    let raw = dot(super::math::sub(*end, *start), super::math::sub(*end, *start)).sqrt();
    // Unit-speed line parameters only: the solid trim must span the whole directrix.
    if source.inner_radius.is_some() || source.start_param.zip(source.end_param)
        .is_some_and(|(t0, t1)| ((t1 - t0).abs() - raw).abs() > 1e-9 * raw) { return None; }
    let r = source.radius * s;
    add(areas, key(instance.solid_id, 0, "disk(wall)"), std::f64::consts::TAU * r * length, true);
    for role in ["disk(start)", "disk(end)"] { add(areas, key(instance.solid_id, 0, role), std::f64::consts::PI * r * r, true); }
    Some(())
}
