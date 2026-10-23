// SPDX-License-Identifier: MPL-2.0
use super::*;
/// One host triangle in f64 (positions + per-vertex normals), host-local frame.
#[derive(Clone)]
pub(in crate::router::voids) struct PTri {
    pub(in crate::router::voids) p: [V3; 3],
    pub(in crate::router::voids) n: [V3; 3],
}

impl PTri {
    #[inline]
    pub(in crate::router::voids) fn aabb(&self) -> (V3, V3) {
        let mut lo = self.p[0];
        let mut hi = self.p[0];
        for v in &self.p[1..] {
            for k in 0..3 {
                lo[k] = lo[k].min(v[k]);
                hi[k] = hi[k].max(v[k]);
            }
        }
        (lo, hi)
    }
}

/// The retained and discarded host fragments must reconstruct the source surface.
/// Their combined divergence residual is meaningful even when either fragment
/// set is open: this is a partition identity, not an enclosed-volume reading.
///
/// Check its value at the host AABB centre and its maximum variation across the
/// AABB. The residual is affine in the reference, so twice the sum of absolute
/// centre-to-face differences gives its exact range over all eight corners.
/// Both checks allow the established one-part-per-million clipping error. The
/// absolute floor uses the full host extent; a remote or long cutter cannot
/// enlarge it. Caps are excluded because their opposite contributions cancel.
pub(in crate::router::voids) fn partition_consistent(host: &[PTri], out: &[PTri], inside: &[PTri], bounds: &[(V3, V3)]) -> bool {
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for (a, b) in bounds {
        for k in 0..3 {
            lo[k] = lo[k].min(a[k]);
            hi[k] = hi[k].max(b[k]);
        }
    }
    let origin: V3 = std::array::from_fn(|k| (lo[k] + hi[k]) * 0.5);
    let extent = (0..3).map(|k| hi[k] - lo[k]).fold(0.0, f64::max);
    let sum = |ts: &[PTri], reference: &V3| {
        ts.iter()
            .map(|t| {
                crate::kernel::signed_volume::tetra_volume6(&t.p[0], &t.p[1], &t.p[2], reference)
            })
            .sum::<f64>()
            / 6.0
    };
    let tolerance =
        (1.0e-12 * (1.0 + extent).powi(3) + 1.0e-9).max(sum(host, &origin).abs() * 1.0e-6);
    let residual =
        |reference: &V3| sum(out, reference) + sum(inside, reference) - sum(host, reference);
    let center = residual(&origin);
    let range = (0..3)
        .map(|axis| {
            let mut reference = origin;
            reference[axis] = hi[axis];
            2.0 * (residual(&reference) - center).abs()
        })
        .sum::<f64>();
    center.is_finite() && range.is_finite() && center.abs() <= tolerance && range <= tolerance
}

/// A containing box is a geometric upper bound on any possible removed volume;
/// it does not require the discarded fragments and caps to form a closed shell.
/// Use a face-aligned box so an exactly planar contact has zero thickness even
/// when it is oblique to the world axes. Keep the existing 1e-9 m³ measurable
/// removal threshold without rejecting every thin but wide authored cut.
pub(in crate::router::voids) fn has_measurable_region(inside: &[PTri], caps: &[PTri]) -> bool {
    let faces: Vec<PTri> = inside.iter().chain(caps).cloned().collect();
    let mut geometry = mesh_from_ptris(&faces, &Mesh::new());
    geometry.clean_degenerate();
    if geometry.indices.is_empty() {
        return false;
    }
    let normal = |t: &PTri| cross(sub(t.p[1], t.p[0]), sub(t.p[2], t.p[0]));
    let Some(face) = faces
        .iter()
        .max_by(|a, b| norm(normal(a)).total_cmp(&norm(normal(b))))
    else {
        return false;
    };
    let origin = face.p[0];
    let Some(u) = normalize(sub(face.p[1], origin)) else {
        return false;
    };
    let Some(n) = normalize(normal(face)) else {
        return false;
    };
    let axes = [u, cross(n, u), n];
    let mut lo = [0.0f64; 3];
    let mut hi = [0.0f64; 3];
    for t in &faces {
        for p in t.p {
            for k in 0..3 {
                let coordinate = dot(sub(p, origin), axes[k]);
                lo[k] = lo[k].min(coordinate);
                hi[k] = hi[k].max(coordinate);
            }
        }
    }
    let envelope = (0..3).map(|k| hi[k] - lo[k]).product::<f64>();
    envelope.is_finite() && envelope >= 1.0e-9
}

/// Reject a consolidated no-op before optional refinement can perturb it.
/// Only call this after auditing the result surface. A shared host reference
/// cancels untouched hairline flux; the AABB drift bounds any dependence left
/// in the before/after difference. Reject only when the ENTIRE change interval
/// is below the established 1e-9 m³ measurable-removal threshold.
pub(in crate::router::voids) fn consolidated_change_is_measurable(before: &Mesh, after: &Mesh) -> bool {
    let (_, delta, drift) = mesh_change_interval(before, after);
    delta.is_finite() && drift.is_finite() && delta.abs() + drift >= 1.0e-9
}

pub(in crate::router::voids) fn mesh_change_interval(before: &Mesh, after: &Mesh) -> (f64, f64, f64) {
    use super::geom::{mesh_signed_volume_about, volume_reference};
    let reference = volume_reference(before);
    let volume = mesh_signed_volume_about(before, &reference);
    let delta = mesh_signed_volume_about(after, &reference) - volume;
    let (_, hi) = before.bounds();
    let drift = (0..3)
        .map(|axis| {
            let mut probe = reference;
            probe[axis] = hi[axis] as f64;
            (mesh_signed_volume_about(after, &probe)
                - mesh_signed_volume_about(before, &probe)
                - delta)
                .abs()
        })
        .sum::<f64>();
    (volume, delta, drift)
}

/// Final subtraction bounds use audited result/host surfaces and an independent
/// cutter ceiling. Every committed cutter is measured AFTER cap/profile extension;
/// summing those prism volumes conservatively bounds their union, and the host
/// volume independently limits removal even for a very long cutter.
///
/// The local quantization model documented by `kernel::mesh_volume::mesh_volume`
/// is surface_area * SNAP_GRID. Both boundaries can move, so their areas add;
/// no world-coordinate magnitude or candidate-fragment envelope sets this bound.
pub(in crate::router::voids) fn result_volume_within_bounds(before: &Mesh, after: &Mesh, cutter_volume: f64) -> bool {
    let (volume, raw_delta, drift) = mesh_change_interval(before, after);
    let delta = raw_delta * volume.signum();
    let area = |mesh: &Mesh| {
        let p =
            |i: u32| -> V3 { std::array::from_fn(|k| mesh.positions[i as usize * 3 + k] as f64) };
        mesh.indices
            .chunks_exact(3)
            .map(|t| norm(cross(sub(p(t[1]), p(t[0])), sub(p(t[2]), p(t[0])))) * 0.5)
            .sum::<f64>()
    };
    let (lo, hi) = before.bounds();
    let extent = (0..3)
        .map(|k| hi[k] as f64 - lo[k] as f64)
        .fold(0.0, f64::max);
    let floor = (1.0e-12 * (1.0 + extent).powi(3) + 1.0e-9).max(volume.abs() * 1.0e-6);
    let tolerance = (area(before) + area(after)) * crate::kernel::mesh_bridge::SNAP_GRID + floor;
    let ceiling = cutter_volume.min(volume.abs());
    volume.is_finite()
        && volume != 0.0
        && cutter_volume.is_finite()
        && cutter_volume >= 0.0
        && delta.is_finite()
        && drift.is_finite()
        && tolerance.is_finite()
        && delta + drift <= tolerance
        && -delta + drift <= ceiling + tolerance
}

/// Promote a `Mesh` to the f64 triangle list, folding nothing (the mesh is
/// taken in its own frame — `origin` semantics are preserved by the caller).
pub(in crate::router::voids) fn ptris_from_mesh(mesh: &Mesh) -> Option<Vec<PTri>> {
    // Reject structurally malformed meshes outright: `chunks_exact(3)` below
    // silently drops any trailing partial triple, so a positions/indices length
    // that is not a multiple of 3 would rebuild the solid missing its tail data
    // while every emitted index still passed its bounds check.
    if !mesh.positions.len().is_multiple_of(3) || !mesh.indices.len().is_multiple_of(3) {
        return None;
    }
    let vc = mesh.positions.len() / 3;
    let have_normals = mesh.normals.len() == mesh.positions.len();
    let mut out = Vec::with_capacity(mesh.indices.len() / 3);
    for t in mesh.indices.chunks_exact(3) {
        if t.iter().any(|&i| i as usize >= vc) {
            return None;
        }
        let read = |i: u32| -> V3 {
            let b = i as usize * 3;
            [
                mesh.positions[b] as f64,
                mesh.positions[b + 1] as f64,
                mesh.positions[b + 2] as f64,
            ]
        };
        let p = [read(t[0]), read(t[1]), read(t[2])];
        if p.iter().any(|v| v.iter().any(|c| !c.is_finite())) {
            return None;
        }
        let n = if have_normals {
            let rn = |i: u32| -> V3 {
                let b = i as usize * 3;
                [
                    mesh.normals[b] as f64,
                    mesh.normals[b + 1] as f64,
                    mesh.normals[b + 2] as f64,
                ]
            };
            [rn(t[0]), rn(t[1]), rn(t[2])]
        } else {
            let fnrm =
                normalize(cross(sub(p[1], p[0]), sub(p[2], p[0]))).unwrap_or([0.0, 0.0, 1.0]);
            [fnrm, fnrm, fnrm]
        };
        out.push(PTri { p, n });
    }
    Some(out)
}

/// Store the f64 triangle list back to an f32 `Mesh` in the host's frame.
/// Per-triangle vertices (no sharing, no welding — #846); normals normalized
/// with the triangle's geometric normal as fallback.
pub(in crate::router::voids) fn mesh_from_ptris(tris: &[PTri], template: &Mesh) -> Mesh {
    let mut positions = Vec::with_capacity(tris.len() * 9);
    let mut normals = Vec::with_capacity(tris.len() * 9);
    let mut indices = Vec::with_capacity(tris.len() * 3);
    for (i, t) in tris.iter().enumerate() {
        let face = normalize(cross(sub(t.p[1], t.p[0]), sub(t.p[2], t.p[0])))
            .unwrap_or([0.0, 0.0, 1.0]);
        for v in 0..3 {
            positions.push(t.p[v][0] as f32);
            positions.push(t.p[v][1] as f32);
            positions.push(t.p[v][2] as f32);
            let n = normalize(t.n[v]).unwrap_or(face);
            normals.push(n[0] as f32);
            normals.push(n[1] as f32);
            normals.push(n[2] as f32);
        }
        let base = (i * 3) as u32;
        indices.extend_from_slice(&[base, base + 1, base + 2]);
    }
    template.reframed_like(positions, normals, indices, template.origin)
}

