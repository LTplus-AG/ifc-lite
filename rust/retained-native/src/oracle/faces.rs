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

/// A maximal run of consecutive line sides of one profile loop whose segments lie
/// on one straight line, in loop order (#7955 ruling 3). The kernel may fold a
/// short side of such a run into its neighbour; nothing here decides whether it did.
#[derive(Clone, Debug, PartialEq)]
pub struct CollinearRun {
    pub keys: Vec<String>,
    /// #7955 ruling 19: a run of arc sides on one circle, not of collinear lines.
    pub arcs: bool,
    /// World width of each side (its swept segment length), metres.
    pub widths_m: Vec<f64>,
}
/// Endpoint offset (profile units, relative to the longer segment) below which two
/// consecutive line segments count as collinear. Authored collinear runs repeat
/// one coordinate exactly (dental_clinic #40805→#40806 on y = 1.507365711283794).
const COLLINEAR_OFFSET_RELATIVE: f64 = 1e-12;

/// Two arc sides on one circle: the same centre and radius, to rounding of the radius.
fn cocircular(a: &Edge, b: &Edge) -> bool {
    let (Edge::Arc { c: ca, u: ua, .. }, Edge::Arc { c: cb, u: ub, .. }) = (a, b) else { return false };
    let (ra, rb) = (ua[0].hypot(ua[1]), ub[0].hypot(ub[1]));
    let tolerance = COLLINEAR_OFFSET_RELATIVE * ra.max(rb);
    ra > 0. && (ra - rb).abs() <= tolerance && (ca[0] - cb[0]).hypot(ca[1] - cb[1]) <= tolerance
}
fn collinear(a: &Edge, b: &Edge) -> bool {
    if cocircular(a, b) { return true; }
    let (Edge::Line(a0, a1), Edge::Line(b0, b1)) = (a, b) else { return false };
    let length = |p: &[f64; 2], q: &[f64; 2]| ((q[0] - p[0]).powi(2) + (q[1] - p[1]).powi(2)).sqrt();
    let (reference, other) = if length(a0, a1) >= length(b0, b1) { ((a0, a1), [b0, b1]) } else { ((b0, b1), [a0, a1]) };
    let span = length(reference.0, reference.1);
    let d = [reference.1[0] - reference.0[0], reference.1[1] - reference.0[1]];
    span > 0. && other.iter().all(|p| {
        ((p[0] - reference.0[0]) * d[1] - (p[1] - reference.0[1]) * d[0]).abs() / span <= COLLINEAR_OFFSET_RELATIVE * span
    })
}

/// Every run of two or more collinear line sides of an uncut product's complete
/// authored extrusions. `None` exactly when [`uncut`] has no prediction.
pub fn collinear_runs(sources: &AnalyticQuantitySources, product: u32) -> Option<Vec<CollinearRun>> {
    uncut(sources, product)?;
    let mut runs = Vec::new();
    for instance in sources.extrusion_definitions.instances.get(&product).map_or(&[][..], Vec::as_slice) {
        let source = &sources.extrusion_definitions.sources.iter().find(|s| s.key == instance.source)?.source;
        let profile = source.profile.as_ref()?;
        let solid = multiply(&instance.world_from_source?, source.position_matrix.as_ref().unwrap_or(&IDENTITY));
        let s = scale(&multiply(&solid, profile.profile_position.as_ref().unwrap_or(&IDENTITY)))?;
        for (index, boundary) in profile.loops.iter().enumerate() {
            let edges = boundary.segments.iter().map(profile_edge).collect::<Option<Vec<_>>>()?;
            let n = edges.len();
            // A loop with no sides has no runs, and no break to start after.
            if n == 0 { continue; }
            let linked: Vec<bool> = (0..n).map(|i| n > 1 && collinear(&edges[i], &edges[(i + 1) % n])).collect();
            // Start after a break so a run crossing the loop's closing vertex stays whole. A loop
            // linked all round is one circle in arcs (964 #7374): the whole loop is the run.
            let start = (0..n).find(|&i| !linked[i]).unwrap_or(n - 1);
            let mut linked = linked;
            linked[start] = false;
            let mut run: Vec<usize> = Vec::new();
            for step in 1..=n {
                let i = (start + step) % n;
                run.push(i);
                if !linked[i] {
                    if run.len() > 1 {
                        runs.push(CollinearRun {
                            keys: run.iter().map(|&i| key(source.solid_id, 0, &format!("side({index},{i})"))).collect(),
                            arcs: matches!(edges[run[0]], Edge::Arc { .. }),
                            widths_m: run.iter().map(|&i| match edges[i] {
                                Edge::Line(a, b) => ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt() * s,
                                Edge::Arc { u, sweep, .. } => u[0].hypot(u[1]) * sweep.abs() * s,
                            }).collect(),
                        });
                    }
                    run.clear();
                }
            }
        }
    }
    runs.sort_by(|a, b| a.keys.cmp(&b.keys));
    runs.dedup();
    Some(runs)
}
