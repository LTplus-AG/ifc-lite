// SPDX-License-Identifier: MPL-2.0
//! Analytic source faces of one retained construction, read from the encoded
//! request the kernel evaluated (wire formats 1 and 2, evaluation metres).
//! Roles keep the authored profile order: `side(loop, segment)` indexes the
//! canonical profile lowering, even where the request reversed a loop.
use super::face_attribution::{unit, Extent, Region, Role, Segment, SourceFace, Support};
use super::face_curve::{Curve, MAX_DEGREE};
use ifc_lite_geometry::document::{RetainedRecipe, SweepPayload};

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
            prism(&mut reader, &reversed)
        }
        RetainedRecipe::SweptDisk(_) => disk(&mut reader).map(|faces| (faces, None)),
        // Derived cutters (halfspace and layer-band prisms) and future recipes.
        other => return Err(NoFaces::Hook(other.solid_id())),
    };
    parsed.filter(|_| reader.at == payload.bytes.len()).ok_or(NoFaces::Malformed)
}

fn prism(reader: &mut Reader<'_>, reversed: &[(bool, usize)]) -> Option<(Vec<SourceFace>, Option<Region>)> {
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
