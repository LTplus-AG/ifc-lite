// SPDX-License-Identifier: MPL-2.0
//! Atomic open-band outer skin; tolerances preregistered in tolerances.d/m4.json.
use super::{layer_mesh::*, publication::ShapePart, error::RetainedExecutionError};
use ifc_lite_geometry::program::transactions::{LayerCompletion, LayerInterface};

pub(super) fn curved(s: LayerInterface) -> bool { matches!(s, LayerInterface::Cylinder { .. }) }
pub(super) const ON_SURFACE_METRES: f64 = 1e-6;
pub(super) fn relative_tolerance(is_curved: bool) -> f64 { if is_curved { 2e-3 } else { 1e-6 } }
pub(super) fn on(s: LayerInterface, p: Point) -> bool { distance_normal(s,p).0.abs() <= ON_SURFACE_METRES }
fn distance_normal(s: LayerInterface, p: Point) -> (f64, Point) {
    match s {
        LayerInterface::Plane { normal, distance } => (dot(normal,p)-distance, normal),
        LayerInterface::Cylinder { center, axis, radius, outward } => {
            let d = sub(p,center);
            let radial: Point = std::array::from_fn(|i| d[i]-axis[i]*dot(d,axis));
            let rho = norm(radial);
            (rho-radius, radial.map(|v| outward*v/rho))
        }
    }
}
fn strip(mesh: &mut ShapePart, surface: LayerInterface, sign: f64) -> Result<f64, RetainedExecutionError> {
    if mesh.revision_local_faces.len() != mesh.indices.len()/3 { return Err(fail("face_partition")); }
    let mut faces = Vec::with_capacity(mesh.revision_local_faces.len());
    let mut indices = Vec::with_capacity(mesh.indices.len());
    let mut area = 0.;
    for (triangle, t) in mesh.indices.chunks_exact(3).enumerate() {
        work()?;
        let p = t.iter().map(|&i| point(mesh,i)).collect::<Vec<_>>();
        let n = cross(sub(p[1],p[0]),sub(p[2],p[0]));
        let length = norm(n);
        if length == 0. { return Err(fail("degenerate_triangle")); }
        if p.iter().all(|&v| on(surface,v)) {
            let center = std::array::from_fn(|i| (p[0][i]+p[1][i]+p[2][i])/3.);
            let direction = dot(n,distance_normal(surface,center).1)*sign/length;
            // cos(6 degrees), the spec's fixed cap-normal angle.
            if direction <= -0.9945218953682733 { return Err(fail("opposite_cap")); }
            if direction >= 0.9945218953682733 { area += length/2.; continue; }
        }
        indices.extend_from_slice(t);
        faces.push(mesh.revision_local_faces[triangle]);
    }
    mesh.indices = indices;
    mesh.revision_local_faces = faces;
    Ok(area)
}

pub(super) fn remove(parts: &mut [ShapePart], layers: &LayerCompletion) -> Result<f64, RetainedExecutionError> {
    if parts.len() != layers.tags.len() || parts.len() < 2 { return Err(fail("layer_manifest")); }
    let origin = point(&parts[0],parts[0].indices[0]);
    let before = volume(parts,origin);
    let mut seams = Vec::new();
    for k in 0..parts.len()-1 {
        let left = usize::from(layers.tags[k].index);
        if usize::from(layers.tags[k+1].index) != left+1 { continue; }
        let surface = *layers.interfaces.get(left).ok_or_else(|| fail("layer_interface"))?;
        let a = strip(&mut parts[k],surface,1.)?;
        let b = strip(&mut parts[k+1],surface,-1.)?;
        let tolerance = relative_tolerance(curved(surface));
        if (a-b).abs() > tolerance*a.max(b) { return Err(fail("cap_area")); }
        seams.push((k,surface));
    }
    // Only newly exposed interface rims may be open before conformity.
    for mesh in parts.iter() {
        for (a,b) in boundary(mesh)? {
            if !seams.iter().any(|(_,s)| on(*s,point(mesh,a)) && on(*s,point(mesh,b))) {
                return Err(fail("rim_off_surface"));
            }
        }
    }
    let mut displacement: f64 = 0.;
    for (k,surface) in seams {
        let (left,right) = parts.split_at_mut(k+1);
        displacement = displacement.max(super::layer_rims::conform(&mut left[k], &mut right[0],surface)?);
    }
    if parts.iter().any(|p| p.indices.is_empty()) { return Err(fail("empty_band")); }
    closed(parts)?;
    let after = volume(parts,origin);
    let tolerance = relative_tolerance(layers.interfaces.iter().any(|&s| curved(s)));
    if !after.is_finite() || (after-before).abs() > tolerance*before.abs() { return Err(fail("assembly_volume")); }
    Ok(displacement)
}

#[cfg(test)]
#[path = "layer_caps_tests.rs"]
mod tests;
