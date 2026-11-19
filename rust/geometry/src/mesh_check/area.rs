// SPDX-License-Identifier: MPL-2.0
use crate::mesh::Mesh;

/// Total triangle area in the mesh's local frame. Invalid geometry has no measurement.
pub(crate) fn surface_area(mesh: &Mesh) -> Option<f64> {
    let point = |i: u32| -> Option<[f64; 3]> {
        let start = (i as usize).checked_mul(3)?;
        let p = mesh.positions.get(start..)?.get(..3)?;
        Some([f64::from(p[0]), f64::from(p[1]), f64::from(p[2])])
    };
    let area = mesh.indices.chunks_exact(3).try_fold(0.0, |area, t| {
        let (a, b, c) = (point(t[0])?, point(t[1])?, point(t[2])?);
        let (u, v) = ([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
        let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        Some(area + 0.5 * (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt())
    })?;
    area.is_finite().then_some(area)
}
