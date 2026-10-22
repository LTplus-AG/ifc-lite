// SPDX-License-Identifier: MPL-2.0
//! A finite half-space operand around one rebased part; all booleans use the exact kernel.

use ifc_lite_geometry::{kernel::{arrangement::{boolean_with_conformity, BoolOp, Tri}, budget}, math::v3};
use ifc_lite_processing::MeshData;

pub(super) fn triangles(part: &MeshData) -> Result<Vec<Tri>, String> {
    if !part.positions.len().is_multiple_of(3) || !part.indices.len().is_multiple_of(3)
        || part.positions.iter().any(|value| !value.is_finite()) {
        return Err(format!("invalid section mesh #{}", part.express_id));
    }
    let mut out = Vec::with_capacity(part.indices.len() / 3);
    for indices in part.indices.chunks_exact(3) {
        let mut tri = [[0.0; 3]; 3];
        for (p, index) in tri.iter_mut().zip(indices) {
            let start = (*index as usize).checked_mul(3).ok_or("section index overflow")?;
            let vertex = part.positions.get(start..start + 3).ok_or("section index out of bounds")?;
            *p = [vertex[0] as f64, vertex[1] as f64, vertex[2] as f64];
        }
        out.push(tri);
    }
    // IFC winding can face inward. The kernel requires outward solids.
    orient_outward(&mut out);
    Ok(out)
}

pub(super) fn orient_outward(triangles: &mut [Tri]) {
    let volume6: f64 = triangles.iter().map(|t| v3::dot(t[0], v3::cross(t[1], t[2]))).sum();
    if closed(triangles) && volume6 < 0.0 { for t in triangles { t.swap(1, 2); } }
}

pub(super) fn closed(triangles: &[Tri]) -> bool {
    let faces = triangles.iter().map(|triangle| (triangle.to_vec(), "section")).collect::<Vec<_>>();
    crate::geom::is_watertight(&faces, 1e-6)
}

pub(super) fn cut(triangles: &[Tri], n: [f64; 3], d: f64) -> Result<Vec<Tri>, String> {
    if !closed(triangles) {
        // Surface models and per-face material fragments are open in the source.
        // Use the canonical triangle/plane clipper and keep them open, rather
        // than asking a volume boolean to invent an inside for a sheet.
        let input = ifc_lite_geometry::kernel::mesh_bridge::tris_to_mesh(triangles);
        let plane = ifc_lite_geometry::csg::Plane::new(
            ifc_lite_geometry::Point3::from(v3::scale(n, d)),
            ifc_lite_geometry::Vector3::from(v3::scale(n, -1.0)),
        );
        let output = ifc_lite_geometry::ClippingProcessor::new().clip_mesh(&input, &plane)
            .map_err(|error| error.to_string())?;
        let mut out = Vec::new();
        for indices in output.indices.chunks_exact(3) {
            out.push([indices[0], indices[1], indices[2]].map(|i| {
                let i = i as usize * 3;
                [output.positions[i] as f64, output.positions[i+1] as f64, output.positions[i+2] as f64]
            }));
        }
        return Ok(out);
    }
    // An orthonormal basis around the kept normal; the other five box faces
    // lie strictly beyond every input vertex, so only the section face cuts.
    let axis = if n[0].abs() < 0.8 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] };
    let u = v3::normalize(v3::cross(n, axis), 0.0).ok_or("invalid section basis")?;
    let v = v3::cross(n, u);
    let mut low = [f64::INFINITY; 3];
    let mut high = [f64::NEG_INFINITY; 3];
    for p in triangles.iter().flatten() {
        for (axis, basis) in [u, v, n].iter().enumerate() {
            let value = v3::dot(*basis, *p);
            low[axis] = low[axis].min(value);
            high[axis] = high[axis].max(value);
        }
    }
    let margin = (0..3).map(|axis| high[axis] - low[axis]).fold(1.0, f64::max);
    for (lo, hi) in low.iter_mut().zip(&mut high) { *lo -= margin; *hi += margin; }
    high[2] = d;
    let mut points = [[0.0; 3]; 8];
    for (i, point) in points.iter_mut().enumerate() {
        *point = v3::add(v3::add(v3::scale(u, if i & 1 == 0 { low[0] } else { high[0] }),
            v3::scale(v, if i & 2 == 0 { low[1] } else { high[1] })),
            v3::scale(n, if i & 4 == 0 { low[2] } else { high[2] }));
    }
    let faces = [[0,2,3],[0,3,1],[4,5,7],[4,7,6],[0,1,5],[0,5,4],
        [2,6,7],[2,7,3],[0,4,6],[0,6,2],[1,3,7],[1,7,5]];
    let operand: Vec<Tri> = faces.iter().map(|face| face.map(|i| points[i])).collect();
    budget::begin();
    let (out, conforming) = boolean_with_conformity(triangles, &operand, BoolOp::Intersection);
    if budget::tripped() || !conforming { return Err("exact section intersection was refused".into()); }
    if !out.is_empty() && !closed(&out) { return Err("exact section intersection did not preserve solid closure".into()); }
    let tolerance = 1e-7 * margin;
    if out.iter().flatten().any(|p| v3::dot(n, *p) > d + tolerance) {
        return Err("section intersection extends outside the kept half-space".into());
    }
    Ok(out)
}
