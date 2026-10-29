// SPDX-License-Identifier: MPL-2.0
//! Source-surface incidence (#7955 M11-F, spec §3.3). A regularized Boolean
//! result satisfies ∂(A∘B) ⊆ ∂A ∪ ∂B, so every output triangle lies on one
//! operand source face. Pure f64 geometry: no kernel, SDK, repair or guessing;
//! only curve foot points charge the product budget.
use super::face_coincidence::coincident;
use super::face_curve::Curve;
use ifc_lite_geometry::resource::ProgramStop;

/// Preregistered in tests/fixtures/cli-retained/tolerances.d/m11-f.json.
pub(crate) const INCIDENCE_PLANAR_M: f64 = 1e-6;
pub(crate) const INCIDENCE_CURVED_EXTRA_M: f64 = 1e-6;
pub(crate) const NORMAL_RADIANS: f64 = 0.0873;
/// Below this area per squared longest edge a triangle has no facet normal.
pub(crate) const DEGENERATE_AREA_RATIO: f64 = 1e-6;

/// Unbounded geometric support of one source face, in its operand's evaluation frame.
#[derive(Debug, Clone)]
pub(crate) enum Support {
    /// Unit outward normal.
    Plane { origin: [f64; 3], normal: [f64; 3] },
    /// A circle in the evaluation XY plane swept along the unit `generator`;
    /// `outward` is +1 when the outward normal points away from the axis.
    Cylinder { center: [f64; 2], radius: f64, generator: [f64; 3], outward: f64 },
    /// Every point at `radius` from a curve: a swept-disk wall, outward away from it.
    Tube { curve: Curve, radius: f64 },
}
/// One profile boundary curve in the evaluation XY plane, in request (outer
/// counter-clockwise, inner clockwise) order, so material is always on the left.
#[derive(Debug, Clone)]
pub(crate) enum Segment {
    Line { a: [f64; 2], b: [f64; 2] },
    /// Point at `t`: `center + radius (x cos t + nz perp(x) sin t)`, t from `start` by `sweep`.
    Arc { center: [f64; 2], radius: f64, x: [f64; 2], nz: f64, start: f64, sweep: f64 },
}
/// Bounded extent of a face, used only to choose between coincident supports.
#[derive(Debug, Clone)]
pub(crate) enum Extent { Side { segment: Segment }, Cap, Disk { center: [f64; 3], radius: f64 }, Wall }
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Role { Cap { end: bool }, Side { boundary: u32, segment: u32 }, DiskWall, DiskCap { end: bool } }
impl std::fmt::Display for Role {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let end = |end: bool| if end { "end" } else { "start" };
        match *self {
            Self::Cap { end: e } => write!(f, "cap({})", end(e)),
            Self::Side { boundary, segment } => write!(f, "side({boundary},{segment})"),
            Self::DiskWall => f.write_str("disk(wall)"),
            Self::DiskCap { end: e } => write!(f, "disk({})", end(e)),
        }
    }
}
#[derive(Debug, Clone)]
pub(crate) struct SourceFace { pub role: Role, pub support: Support, pub extent: Extent }
/// A prism's profile region (caps) and sweep, or nothing for a disk.
#[derive(Debug, Clone)]
pub(crate) struct Region { pub loops: Vec<Vec<Segment>>, pub generator: [f64; 3], pub depth: f64 }
/// One construction leaf of a part's Boolean lineage, in left-first order.
#[derive(Debug, Clone)]
pub(crate) struct Operand {
    pub item: u32,
    pub via: u32,
    /// Column-major part object frame -> this leaf's evaluation frame.
    pub from_part: [f64; 16],
    /// -1 where the leaf's material was subtracted or mirrored: its faces appear reversed.
    pub sign: f64,
    /// Largest stretch of `from_part` (1 when rigid): part-frame tolerances in the leaf frame.
    pub stretch: f64,
    pub faces: Vec<SourceFace>,
    pub region: Option<Region>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Unproven { Unattributed { entity: Option<u32> }, Ambiguous { entity: Option<u32> } }
/// Why a triangle has no candidates: no proof, or the product budget stopped the search.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Halt { Unproven(Unproven), Stopped(ProgramStop) }
impl From<Unproven> for Halt { fn from(u: Unproven) -> Self { Self::Unproven(u) } }
impl From<ProgramStop> for Halt { fn from(s: ProgramStop) -> Self { Self::Stopped(s) } }
/// Per triangle: (operand, face) chosen from the candidates.
pub(crate) type Choice = (usize, usize);

type V = [f64; 3];
fn sub(a: V, b: V) -> V { [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
fn dot(a: V, b: V) -> f64 { a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
fn cross(a: V, b: V) -> V { [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] }
pub(crate) fn unit(a: V) -> Option<V> {
    let n = dot(a, a).sqrt();
    (n.is_finite() && n > 0.).then(|| a.map(|v| v / n))
}
fn transform(m: &[f64; 16], p: V) -> V {
    std::array::from_fn(|i| m[i] * p[0] + m[i + 4] * p[1] + m[i + 8] * p[2] + m[i + 12])
}
fn angle(a: V, b: V) -> f64 { dot(a, b).clamp(-1., 1.).acos() }

impl Region {
    /// `p = q + s generator` with `q` on the profile plane.
    fn project(&self, p: V) -> ([f64; 2], f64) {
        let g = self.generator;
        let s = p[2] / g[2];
        ([p[0] - s * g[0], p[1] - s * g[1]], s)
    }
    fn contains(&self, q: [f64; 2], tol: f64) -> bool {
        let winding: f64 = self.loops.iter().flatten().map(|segment| segment.winding(q)).sum();
        (winding / std::f64::consts::TAU).round() >= 1.
            || self.loops.iter().flatten().any(|segment| segment.distance(q) <= tol)
    }
}
impl Segment {
    fn arc_point(center: [f64; 2], radius: f64, x: [f64; 2], nz: f64, t: f64) -> [f64; 2] {
        let (sin, cos) = t.sin_cos();
        [center[0] + radius * (x[0] * cos - nz * x[1] * sin), center[1] + radius * (x[1] * cos + nz * x[0] * sin)]
    }
    /// Signed sweep from the arc start to `q`'s direction, in `[0, 2π)`.
    fn offset(&self, q: [f64; 2]) -> f64 {
        let Self::Arc { center, x, nz, start, sweep, .. } = *self else { return 0. };
        let d = [q[0] - center[0], q[1] - center[1]];
        let t = (nz * (x[0] * d[1] - x[1] * d[0])).atan2(x[0] * d[0] + x[1] * d[1]);
        ((t - start) * sweep.signum()).rem_euclid(std::f64::consts::TAU)
    }
    fn distance(&self, q: [f64; 2]) -> f64 {
        match *self {
            Self::Line { a, b } => {
                let (e, d) = ([b[0] - a[0], b[1] - a[1]], [q[0] - a[0], q[1] - a[1]]);
                let u = ((d[0] * e[0] + d[1] * e[1]) / (e[0] * e[0] + e[1] * e[1])).clamp(0., 1.);
                (d[0] - u * e[0]).hypot(d[1] - u * e[1])
            }
            Self::Arc { center, radius, x, nz, start, sweep } => {
                if self.offset(q) <= sweep.abs() { return ((q[0] - center[0]).hypot(q[1] - center[1]) - radius).abs(); }
                [start, start + sweep].map(|t| Self::arc_point(center, radius, x, nz, t))
                    .map(|p| (q[0] - p[0]).hypot(q[1] - p[1])).into_iter().fold(f64::INFINITY, f64::min)
            }
        }
    }
    /// Subtended angle of this boundary piece at `q`; the loop total is 2π·winding.
    fn winding(&self, q: [f64; 2]) -> f64 {
        let chord = |a: [f64; 2], b: [f64; 2]| {
            let (u, v) = ([a[0] - q[0], a[1] - q[1]], [b[0] - q[0], b[1] - q[1]]);
            (u[0] * v[1] - u[1] * v[0]).atan2(u[0] * v[0] + u[1] * v[1])
        };
        match *self {
            Self::Line { a, b } => chord(a, b),
            Self::Arc { center, radius, x, nz, start, sweep } => {
                let [a, b, m] = [start, start + sweep, start + sweep / 2.].map(|t| Self::arc_point(center, radius, x, nz, t));
                let side = |p: [f64; 2]| (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
                let full = sweep.abs() >= std::f64::consts::TAU - 1e-12;
                let inside = (q[0] - center[0]).hypot(q[1] - center[1]) < radius
                    && (full || side(q) * side(m) > 0.);
                let turn = if inside { std::f64::consts::TAU * (nz * sweep).signum() } else { 0. };
                if full { turn } else { chord(a, b) + turn }
            }
        }
    }
}

impl Operand {
    fn contains(&self, face: &SourceFace, p: V, tol: f64) -> bool {
        match (&face.extent, &self.region) {
            (Extent::Wall, _) => true,
            (Extent::Disk { center, radius }, _) => dot(sub(p, *center), sub(p, *center)).sqrt() <= radius + tol,
            (Extent::Cap, Some(region)) => region.contains(region.project(p).0, tol),
            (Extent::Side { segment }, Some(region)) => {
                let (q, s) = region.project(p);
                if s < -tol || s > region.depth + tol { return false; }
                match *segment {
                    Segment::Line { a, b } => {
                        let e = [b[0] - a[0], b[1] - a[1]];
                        let length = e[0].hypot(e[1]);
                        let u = ((q[0] - a[0]) * e[0] + (q[1] - a[1]) * e[1]) / length;
                        u >= -tol && u <= length + tol
                    }
                    Segment::Arc { radius, sweep, .. } => {
                        let offset = segment.offset(q);
                        offset <= sweep.abs() + tol / radius || offset >= std::f64::consts::TAU - tol / radius
                    }
                }
            }
            _ => false,
        }
    }
    /// Vertex and centroid incidence plus oriented facet-normal agreement.
    fn incident(&self, face: &SourceFace, corners: &[V; 3], normal: Option<V>, chord: f64) -> Result<bool, ProgramStop> {
        let centroid = std::array::from_fn(|i| (corners[0][i] + corners[1][i] + corners[2][i]) / 3.);
        let tolerance = self.stretch * match face.support { Support::Plane { .. } => INCIDENCE_PLANAR_M, _ => chord + INCIDENCE_CURVED_EXTRA_M };
        for corner in corners {
            if face.support.probe(*corner)?.0 > tolerance { return Ok(false); }
        }
        let (distance, outward) = face.support.probe(centroid)?;
        Ok(distance <= tolerance
            && normal.is_none_or(|n| outward.is_some_and(|o| angle(n, o.map(|v| v * self.sign)) <= NORMAL_RADIANS)))
    }
}
impl Support {
    fn radial(center: [f64; 2], g: V, p: V) -> [f64; 2] {
        let s = p[2] / g[2];
        [p[0] - s * g[0] - center[0], p[1] - s * g[1] - center[1]]
    }
    /// Distance of a plane or cylinder from `p`; a swept-disk wall needs [`Self::probe`].
    pub(crate) fn flat_distance(&self, p: V) -> Option<f64> {
        match self {
            Self::Plane { origin, normal } => Some(dot(sub(p, *origin), *normal).abs()),
            Self::Cylinder { center, radius, generator, .. } => {
                let r = Self::radial(*center, *generator, p);
                Some((r[0].hypot(r[1]) - radius).abs())
            }
            Self::Tube { .. } => None,
        }
    }
    /// Distance from `p` and the outward unit normal at its foot, from one foot point.
    fn probe(&self, p: V) -> Result<(f64, Option<V>), ProgramStop> {
        Ok(match self {
            Self::Plane { normal, .. } => (self.flat_distance(p).unwrap_or(f64::INFINITY), Some(*normal)),
            Self::Cylinder { center, generator, outward, .. } => {
                let r = Self::radial(*center, *generator, p);
                (self.flat_distance(p).unwrap_or(f64::INFINITY),
                    unit(cross([-r[1], r[0], 0.], *generator)).map(|n| n.map(|v| v * generator[2].signum() * outward)))
            }
            Self::Tube { curve, radius } => {
                let d = sub(p, curve.closest(p)?);
                ((dot(d, d).sqrt() - radius).abs(), unit(d))
            }
        })
    }
}
/// Facet-normal evidence: false for a triangle whose area is below the
/// preregistered ratio of its longest edge squared (a rounding-skewed sliver).
fn oriented(t: &[V; 3]) -> bool {
    let n = cross(sub(t[1], t[0]), sub(t[2], t[0]));
    let longest = [sub(t[1], t[0]), sub(t[2], t[1]), sub(t[0], t[2])].iter().map(|e| dot(*e, *e)).fold(0., f64::max);
    let area = dot(n, n).sqrt() / 2.;
    area.is_finite() && area > 0. && area >= DEGENERATE_AREA_RATIO * longest
}

/// Every source face one triangle lies on, each with whether its bounded extent
/// holds the centroid; `oriented` is false for a degenerate triangle, which has
/// no normal to test. None is `unattributed` (naming the part's host item).
/// Whether several candidates are one surface is decided per kernel face.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Candidates { pub matches: Vec<(Choice, bool)>, pub oriented: bool }
pub(crate) fn candidates(operands: &[Operand], part: &[V; 3], chord: f64) -> Result<Candidates, Halt> {
    let mut matches: Vec<(Choice, bool)> = Vec::new();
    let oriented = oriented(part);
    for (o, operand) in operands.iter().enumerate() {
        let corners = part.map(|p| transform(&operand.from_part, p));
        let normal = unit(cross(sub(corners[1], corners[0]), sub(corners[2], corners[0])));
        if oriented && normal.is_none() { continue; }
        let normal = normal.filter(|_| oriented);
        let centroid = std::array::from_fn(|i| (corners[0][i] + corners[1][i] + corners[2][i]) / 3.);
        for (f, face) in operand.faces.iter().enumerate() {
            if operand.incident(face, &corners, normal, chord)? {
                matches.push(((o, f), operand.contains(face, centroid, operand.stretch * (chord + INCIDENCE_CURVED_EXTRA_M))));
            }
        }
    }
    if matches.is_empty() { return Err(Unproven::Unattributed { entity: operands.first().map(|o| o.item) }.into()); }
    Ok(Candidates { matches, oriented })
}

/// One key per revision-local kernel face. Its candidates are the source faces
/// common to all its ORIENTED triangles (none: the kernel cross-check fails,
/// `ambiguous`); degenerate triangles must lie on the chosen face too, and a
/// face with no oriented triangle has no evidence (`unattributed`). Candidates
/// prefer faces whose bounded extent holds one of its triangles; those left
/// must all be one surface (else `ambiguous`), and go to the LEFT (host)
/// operand: operands are in left-first lineage order, and the left operand is
/// where a Boolean's surviving boundary comes from. A key may span several
/// kernel faces, never the reverse. Every refusal names the item it concerns.
pub(crate) fn resolve(operands: &[Operand], face: &[Candidates], chord: f64) -> Result<Choice, Unproven> {
    let item = |(o, _): Choice| Some(operands[o].item);
    let mut oriented = face.iter().filter(|c| c.oriented);
    let Some(first) = oriented.next() else {
        let seen = face.iter().flat_map(|c| c.matches.first()).next();
        return Err(Unproven::Unattributed { entity: seen.and_then(|&(c, _)| item(c)) });
    };
    let common: Vec<(Choice, bool)> = first.matches.iter().filter_map(|&(choice, inside)| {
        let mut held = inside;
        for other in oriented.clone() {
            held |= other.matches.iter().find(|(c, _)| *c == choice)?.1;
        }
        Some((choice, held))
    }).collect();
    let bounded = common.iter().any(|&(_, held)| held);
    let survivors: Vec<Choice> = common.into_iter().filter(|&(_, held)| held || !bounded).map(|(choice, _)| choice).collect();
    let choice = survivors.iter().copied().min()
        .ok_or(Unproven::Ambiguous { entity: first.matches.first().and_then(|&(c, _)| item(c)) })?;
    if survivors.iter().any(|&other| !coincident(operands, choice, other, chord))
        || face.iter().any(|c| !c.oriented && !c.matches.iter().any(|(m, _)| *m == choice)) {
        return Err(Unproven::Ambiguous { entity: item(choice) });
    }
    Ok(choice)
}
