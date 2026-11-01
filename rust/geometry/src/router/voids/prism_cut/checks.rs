// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Self-checks on a candidate cut: the host partition identity, a
//! measurable removed region, and the consolidated result's change and
//! volume bounds.

use super::kit::{cross, dot, norm, normalize, sub, V3};
use super::ptri::{mesh_from_ptris, PTri};
use crate::math::aabb::Aabb3;
use crate::mesh::Mesh;

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
pub(super) fn partition_consistent(
    host: &[PTri],
    out: &[PTri],
    inside: &[PTri],
    bounds: &[(V3, V3)],
) -> bool {
    let mut envelope = Aabb3::EMPTY;
    for &(min, max) in bounds {
        envelope = envelope.union(&Aabb3 { min, max });
    }
    let (lo, hi) = (envelope.min, envelope.max);
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
pub(super) fn has_measurable_region(inside: &[PTri], caps: &[PTri]) -> bool {
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
    let mut bounds = Aabb3 {
        min: [0.0; 3],
        max: [0.0; 3],
    };
    for t in &faces {
        for p in t.p {
            bounds.extend(std::array::from_fn(|k| dot(sub(p, origin), axes[k])));
        }
    }
    let (lo, hi) = (bounds.min, bounds.max);
    let envelope = (0..3).map(|k| hi[k] - lo[k]).product::<f64>();
    envelope.is_finite() && envelope >= 1.0e-9
}

/// Reject a consolidated no-op before optional refinement can perturb it.
/// Only call this after auditing the result surface. A shared host reference
/// cancels untouched hairline flux; the AABB drift bounds any dependence left
/// in the before/after difference. Reject only when the ENTIRE change interval
/// is below the established 1e-9 m³ measurable-removal threshold.
pub(super) fn consolidated_change_is_measurable(before: &Mesh, after: &Mesh) -> bool {
    let (_, delta, drift) = mesh_change_interval(before, after);
    delta.is_finite() && drift.is_finite() && delta.abs() + drift >= 1.0e-9
}

pub(super) fn mesh_change_interval(before: &Mesh, after: &Mesh) -> (f64, f64, f64) {
    use super::super::geom::{mesh_signed_volume_about, volume_reference};
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
pub(super) fn result_volume_within_bounds(before: &Mesh, after: &Mesh, cutter_volume: f64) -> bool {
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
