// SPDX-License-Identifier: MPL-2.0
//! Independent f64 half-space clipping; no kernel mesh or retrace repair code.
use super::math::*;
use ifc_lite_geometry::analytic::AnalyticCurveSegment;
use ifc_lite_processing::AnalyticQuantitySources;
type Point = [f64; 3];
#[derive(Clone, Debug)]
pub struct Convex { faces: Vec<Vec<Point>> }
#[derive(Clone, Copy)]
struct Plane { n: Point, d: f64 }
impl Plane { fn distance(self, p: Point) -> f64 { dot(self.n, p) - self.d } }
fn add(a: Point, b: Point) -> Point { std::array::from_fn(|i| a[i] + b[i]) }
fn mean(points: &[Point]) -> Point {
    points.iter().fold([0.; 3], |a, b| add(a, b.map(|v| v / points.len() as f64)))
}
fn plane(face: &[Point]) -> Option<Plane> {
    let n = unit(cross(sub(face[1], face[0]), sub(face[2], face[0])))?;
    Some(Plane { n, d: dot(n, face[0]) })
}
impl Convex {
    /// Input vertices are already translated to a common host-relative frame.
    pub fn extrusion(vertices: &[Point], direction: Point) -> Option<Self> {
        if vertices.len() < 3 || vertices.len() > 4096
            || vertices.iter().flatten().chain(direction.iter()).any(|v| !v.is_finite()) { return None; }
        let cap = plane(vertices)?;
        if vertices.iter().any(|p| cap.distance(*p).abs() > 1e-10) { return None; }
        let top: Vec<_> = vertices.iter().map(|v| add(*v, direction)).collect();
        let center = add(mean(vertices), direction.map(|v| v / 2.));
        let mut faces = vec![vertices.to_vec(), top.clone()];
        for i in 0..vertices.len() {
            let j = (i + 1) % vertices.len();
            faces.push(vec![vertices[i], vertices[j], top[j], top[i]]);
        }
        for face in &mut faces {
            if plane(face)?.distance(center) > 0. { face.reverse(); }
            let h = plane(face)?;
            if vertices.iter().chain(&top).any(|p| h.distance(*p) > 1e-10) { return None; }
        }
        let result = Self { faces };
        (result.volume() > 0.).then_some(result)
    }
    pub fn volume(&self) -> f64 {
        let all: Vec<_> = self.faces.iter().flatten().copied().collect();
        if all.is_empty() { return 0.; }
        let origin = mean(&all);
        self.faces.iter().map(|f| (1..f.len()-1).map(|i| {
            dot(sub(f[0], origin), cross(sub(f[i], origin), sub(f[i+1], origin))) / 6.
        }).sum::<f64>()).sum::<f64>().abs()
    }
    pub fn bbox(&self) -> [f64; 6] {
        let mut result = [f64::INFINITY, f64::INFINITY, f64::INFINITY,
            f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
        for p in self.faces.iter().flatten() { extend_bbox(&mut result, *p); }
        result
    }
    pub fn intersect(&self, other: &Self) -> Option<Self> {
        let mut result = self.clone();
        for face in &other.faces { result.clip(plane(face)?)?; }
        Some(result)
    }
    fn clip(&mut self, h: Plane) -> Option<()> {
        let mut faces = Vec::new();
        let mut cap = Vec::new();
        for face in &self.faces {
            let mut kept = Vec::new();
            for i in 0..face.len() {
                let a = face[i]; let b = face[(i+1)%face.len()];
                let da = h.distance(a); let db = h.distance(b);
                if da <= 0. { kept.push(a); }
                if (da > 0.) != (db > 0.) {
                    let p = add(a, sub(b, a).map(|v| v * (da / (da-db))));
                    kept.push(p);
                    if !cap.iter().any(|q| dot(sub(p, *q), sub(p, *q)) < 1e-24) { cap.push(p); }
                }
            }
            kept.dedup();
            if kept.len() >= 3 { faces.push(kept); }
        }
        if cap.len() >= 3 {
            let center = mean(&cap);
            let x = unit(sub(cap[0], center))?;
            let y = cross(h.n, x);
            cap.sort_by(|a, b| {
                let a = sub(*a, center); let b = sub(*b, center);
                dot(a,y).atan2(dot(a,x)).total_cmp(&dot(b,y).atan2(dot(b,x)))
            });
            faces.push(cap);
        }
        self.faces = faces;
        Some(())
    }
}
/// Inclusion/exclusion handles overlapping cutters in arbitrary orientations.
pub fn difference_volume(host: &Convex, cutters: &[Convex]) -> Option<f64> {
    if cutters.len() > 8 { return None; }
    let mut volume = 0.;
    for mask in 0usize..(1 << cutters.len()) {
        let mut intersection = host.clone();
        for (i, cutter) in cutters.iter().enumerate() {
            if mask & (1<<i) != 0 { intersection = intersection.intersect(cutter)?; }
        }
        volume += if mask.count_ones() % 2 == 0 { 1. } else { -1. } * intersection.volume();
    }
    volume.is_finite().then_some(volume)
}
/// Ordinary convex line extrusion from the shared placement-only source view.
pub fn source(sources: &AnalyticQuantitySources, id: u32, origin: Point) -> Option<Convex> {
    let instances = sources.extrusion_definitions.instances.get(&id)?;
    if instances.len() != 1 { return None; }
    let i = &instances[0];
    let s = &sources.extrusion_definitions.sources.iter().find(|s| s.key == i.source)?.source;
    let profile = s.profile.as_ref()?;
    if profile.loops.len() != 1 { return None; }
    let mut frame = super::prism::profile_frame(sources, i)?;
    for k in 0..3 { frame[12+k] -= origin[k]; }
    let points: Option<Vec<_>> = profile.loops[0].segments.iter().map(|segment| {
        if let AnalyticCurveSegment::Line { start, .. } = segment { Some(transform(&frame, *start)) } else { None }
    }).collect();
    let solid = multiply(&i.world_from_source?, s.position_matrix.as_ref().unwrap_or(&IDENTITY));
    Convex::extrusion(&points?, vector(&solid, s.axis_unit_vector?.map(|v| v * s.depth.unwrap_or(0.))))
}
