// SPDX-License-Identifier: MPL-2.0
//! Analytic source faces of one retained construction, read from the encoded
//! request the kernel evaluated (wire formats 1 and 2, evaluation metres).
//! Roles keep the authored profile order: `side(loop, segment)` indexes the
//! canonical profile lowering, even where the request reversed a loop;
//! `row(k)` indexes an authored face-set row (format 3).
use super::face_attribution::{unit, Extent, Region, Role, Segment, SourceFace, Support};
use super::face_curve::{Curve, MAX_DEGREE};
use ifc_lite_geometry::document::{PrismLoop, PrismRole, PrismSegment, RetainedRecipe, SweepPayload};

/// Why a construction has no source faces here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NoFaces {
    /// A derived cutter (halfspace, layer band): its provenance hook is M5/M6/M4's.
    Hook(u32),
    /// The request does not decode as the documented wire format.
    Malformed,
}

struct Reader<'a> { bytes: &'a [u8], at: usize }
impl Reader<'_> {
    fn take<const N: usize>(&mut self) -> Option<[u8; N]> {
        let end = self.at.checked_add(N)?;
        let value = self.bytes.get(self.at..end)?.try_into().ok()?;
        self.at = end;
        Some(value)
    }
    fn u32(&mut self) -> Option<u32> { self.take().map(u32::from_le_bytes) }
    fn f64(&mut self) -> Option<f64> { self.take().map(f64::from_le_bytes).filter(|v| v.is_finite()) }
    fn f64s<const N: usize>(&mut self) -> Option<[f64; N]> {
        let mut out = [0.; N];
        for value in &mut out { *value = self.f64()?; }
        Some(out)
    }
}

pub(crate) fn faces(recipe: &RetainedRecipe, payload: &SweepPayload) -> Result<(Vec<SourceFace>, Option<Region>), NoFaces> {
    let mut reader = Reader { bytes: &payload.bytes, at: 0 };
    let parsed = match recipe {
        RetainedRecipe::Extrusion(recipe) => {
            let profile = recipe.source.profile.as_ref().ok_or(NoFaces::Malformed)?;
            // The request reverses a loop iff its authored winding disagrees with outer-CCW/inner-CW.
            let reversed: Vec<_> = profile.loops.iter().enumerate()
                .map(|(i, l)| ((l.signed_area > 0.) != (i == 0), l.segments.len())).collect();
            prism_faces(&mut reader, &reversed)
        }
        RetainedRecipe::SweptDisk(_) => disk(&mut reader).map(|faces| (faces, None)),
        RetainedRecipe::FaceSet(_) => face_set(&mut reader).map(|faces| (faces, None)),
        RetainedRecipe::Prism(prism) if prism.role == PrismRole::HalfSpace => {
            // CUT-0's cutter frame places z=0 on the authored plane, +Z on
            // its material side. Only that base is an IFC source face: the
            // finite box's other five faces must NEVER acquire provenance.
            return Ok((vec![SourceFace { role: Role::HalfSpace, extent: Extent::Plane,
                support: Support::Plane { origin: [0.; 3], normal: [0., 0., -1.] } }], None));
        }
        // M6: the cut-plane base and the boundary's lateral faces are the PBHS's own
        // surfaces; the far cap is sized from host bounds and is never a source face.
        RetainedRecipe::Prism(prism) if prism.role == PrismRole::BoundedHalfSpace => {
            let reversed: Vec<_> = prism.loops.iter().map(|l| (reverses(l), l.segments.len())).collect();
            prism_faces(&mut reader, &reversed).map(|(faces, region)| {
                let faces = faces.into_iter().filter(|f| f.role != Role::Cap { end: true })
                    .map(|f| if f.role == (Role::Cap { end: false }) { SourceFace { role: Role::HalfSpace, ..f } } else { f })
                    .collect();
                (faces, region)
            })
        }
        // Layer-band prisms retain their own slice hook.
        other => return Err(NoFaces::Hook(other.solid_id())),
    };
    parsed.filter(|_| reader.at == payload.bytes.len()).ok_or(NoFaces::Malformed)
}

pub(crate) fn is_face_set(recipe: &RetainedRecipe) -> bool { matches!(recipe, RetainedRecipe::FaceSet(_)) }

/// One plane per authored row, from the Newell normal of the row's triangles. A
/// row whose triangles all dropped keeps its slot so roles index authored rows;
/// no published triangle can reach it.
fn face_set(reader: &mut Reader<'_>) -> Option<Vec<SourceFace>> {
    let [format, vertices, triangles, row_count] = [reader.u32()?, reader.u32()?, reader.u32()?, reader.u32()?];
    let (vertices, triangles, row_count) = (vertices as usize, triangles as usize, row_count as usize);
    if format != 3 || row_count > reader.bytes.len() { return None; }
    let positions = (0..vertices).map(|_| reader.f64s::<3>()).collect::<Option<Vec<_>>>()?;
    let corners = (0..triangles).map(|_| Some([reader.u32()?, reader.u32()?, reader.u32()?])).collect::<Option<Vec<_>>>()?;
    let mut sums = vec![([0.; 3], [0.; 3], Vec::new(), Vec::new()); row_count];
    for (index, triangle) in corners.iter().enumerate() {
        let row = reader.u32()? as usize;
        let [a, b, c] = [positions.get(triangle[0] as usize)?, positions.get(triangle[1] as usize)?, positions.get(triangle[2] as usize)?];
        let (sum, origin, pieces, indices) = sums.get_mut(row)?;
        pieces.push([*a, *b, *c]);
        indices.push(index as u32);
        let n = cross3(std::array::from_fn(|i| b[i] - a[i]), std::array::from_fn(|i| c[i] - a[i]));
        if *sum == [0.; 3] { *origin = *a; }
        for i in 0..3 { sum[i] += n[i]; }
    }
    sums.into_iter().enumerate().map(|(row, (sum, origin, triangles, indices))| Some(SourceFace {
        role: Role::FaceSetRow { row: row as u32 }, extent: Extent::Row { triangles, indices },
        support: Support::Plane { origin, normal: unit(sum).unwrap_or([0., 0., 1.]) },
    })).collect()
}

fn prism_faces(reader: &mut Reader<'_>, reversed: &[(bool, usize)]) -> Option<(Vec<SourceFace>, Option<Region>)> {
    let [format, loop_count, _, _] = [reader.u32()?, reader.u32()?, reader.u32()?, reader.u32()?];
    let [gx, gy, gz, depth] = reader.f64s::<4>()?;
    if format != 1 || loop_count as usize != reversed.len() || gz == 0. { return None; }
    let g = unit([gx, gy, gz])?;
    let z = g[2].signum();
    let mut faces = vec![
        SourceFace { role: Role::Cap { end: false }, extent: Extent::Cap,
            support: Support::Plane { origin: [0.; 3], normal: [0., 0., -z] } },
        SourceFace { role: Role::Cap { end: true }, extent: Extent::Cap,
            support: Support::Plane { origin: g.map(|v| v * depth), normal: [0., 0., z] } },
    ];
    let mut loops = Vec::with_capacity(reversed.len());
    for (index, &(flipped, authored)) in reversed.iter().enumerate() {
        let (_role, count) = (reader.u32()?, reader.u32()? as usize);
        if count != authored { return None; }
        let mut segments = Vec::with_capacity(count);
        for i in 0..count {
            let (kind, _) = (reader.u32()?, reader.u32()?);
            let v = reader.f64s::<12>()?;
            let (segment, support) = match kind {
                1 => {
                    let (a, b) = ([v[0], v[1]], [v[3], v[4]]);
                    // Material is on the left: the outward normal is to the right of travel.
                    let n = unit(cross3([b[0] - a[0], b[1] - a[1], 0.], g))?.map(|c| c * z);
                    (Segment::Line { a, b }, Support::Plane { origin: [a[0], a[1], 0.], normal: n })
                }
                2 | 3 => {
                    let (center, radius, nz) = ([v[0], v[1]], v[9], v[5]);
                    let outward = (nz * v[11]).signum();
                    (Segment::Arc { center, radius, x: [v[6], v[7]], nz, start: v[10], sweep: v[11] },
                        Support::Cylinder { center, radius, generator: g, outward })
                }
                _ => return None,
            };
            let segment_index = if flipped { count - 1 - i } else { i };
            faces.push(SourceFace { role: Role::Side { boundary: index as u32, segment: segment_index as u32 },
                extent: Extent::Side { segment: segment.clone() }, support });
            segments.push(segment);
        }
        loops.push(segments);
    }
    // Sides in authored order; caps first.
    faces[2..].sort_by_key(|face| match face.role { Role::Side { boundary, segment } => (boundary, segment), _ => (0, 0) });
    Some((faces, Some(Region { loops, generator: g, depth })))
}
/// The encoder reverses a loop whose authored winding disagrees with outer-CCW/inner-CW.
fn reverses(boundary: &PrismLoop) -> bool {
    let twice_area: f64 = boundary.segments.iter().map(|segment| match *segment {
        PrismSegment::Line { start, end } => start[0] * end[1] - end[0] * start[1],
        PrismSegment::Arc { center: [cx, cy], radius: r, start_angle: a, sweep_angle } => {
            let b = a + sweep_angle;
            r * (cx * (b.sin() - a.sin()) - cy * (b.cos() - a.cos())) + r * r * sweep_angle
        }
        PrismSegment::Circle { radius, .. } => radius * radius * std::f64::consts::TAU,
    }).sum();
    (twice_area > 0.) != boundary.outer
}
fn cross3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn disk(reader: &mut Reader<'_>) -> Option<Vec<SourceFace>> {
    let header = [reader.u32()?, reader.u32()?, reader.u32()?, reader.u32()?];
    let [radius, inner] = reader.f64s::<2>()?;
    let [kind, _, degree, controls, knots, _] =
        [reader.u32()?, reader.u32()?, reader.u32()?, reader.u32()?, reader.u32()?, reader.u32()?];
    if header != [2, 1, 1, 0] || inner != 0. || kind != 4 || degree == 0 || degree as usize > MAX_DEGREE
        || controls as usize > reader.bytes.len() / 32 || knots as usize > reader.bytes.len() / 16 { return None; }
    let range = reader.f64s::<2>()?;
    let points = (0..controls).map(|_| reader.f64s::<4>().map(|[x, y, z, w]| [x * w, y * w, z * w, w]))
        .collect::<Option<Vec<_>>>()?;
    let mut expanded = Vec::new();
    for _ in 0..knots {
        let (knot, multiplicity, _) = (reader.f64()?, reader.u32()?, reader.u32()?);
        if multiplicity as usize > degree as usize + 1
            || expanded.len() + multiplicity as usize > controls as usize + degree as usize + 1 { return None; }
        expanded.extend(std::iter::repeat_n(knot, multiplicity as usize));
    }
    let curve = Curve::new(degree as usize, points, expanded, range)?;
    let [start, end] = range.map(|t| (curve.point(t), curve.tangent(t)));
    let cap = |end: bool, (center, tangent): ([f64; 3], [f64; 3])| SourceFace {
        role: Role::DiskCap { end }, extent: Extent::Disk { center, radius },
        support: Support::Plane { origin: center, normal: tangent.map(|v| if end { v } else { -v }) },
    };
    Some(vec![SourceFace { role: Role::DiskWall, extent: Extent::Wall, support: Support::Tube { curve, radius } },
        cap(false, (start.0, start.1?)), cap(true, (end.0, end.1?))])
}
