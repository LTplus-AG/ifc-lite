// SPDX-License-Identifier: MPL-2.0
//! #7955: a plain halfspace clip that leaves a removable sliver on its removed side. Close
//! to a parallel end cap the kernel treats the plane as coincident and keeps the wedge
//! (ISSUE_129 #271772: 4.9 µm deep, +2.4e-5 volume). A product whose published mesh still
//! holds more material beyond one of its plane clips than the frozen volume limit allows is
//! refused, never trimmed. Rounding-sized overshoot of a clean cut is far below that limit.
use super::runtime::ReceiptEvidence;
use super::*;
use ifc_lite_geometry::{document::{retained_wire, PrismRole}, program::transactions::relative_frame, BoolOp};

const MAX_SPINE: usize = 128;
const IDENTITY: [f64; 16] = [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.];

/// Volume of a closed mesh beyond z = 0 in `plane_from_part` coordinates, whose +Z is the
/// clip's removed side. By the divergence theorem with the field (0, 0, z) the cap on z = 0
/// contributes nothing, so only the triangles' parts with z > 0 are integrated.
pub fn volume_beyond(positions: &[f64], indices: &[u32], plane_from_part: &[f64; 16]) -> Option<f64> {
    let m = plane_from_part;
    let point = |index: u32| -> Option<[f64; 3]> {
        let at = usize::try_from(index).ok()?.checked_mul(3)?;
        let p: &[f64] = positions.get(at..at.checked_add(3)?)?;
        Some(std::array::from_fn(|i| m[i] * p[0] + m[i + 4] * p[1] + m[i + 8] * p[2] + m[i + 12]))
    };
    let mut volume = 0.;
    let mut polygon: Vec<[f64; 3]> = Vec::with_capacity(4);
    for triangle in indices.chunks_exact(3) {
        let corners = [point(triangle[0])?, point(triangle[1])?, point(triangle[2])?];
        if corners.iter().all(|c| c[2] <= 0.) { continue; }
        polygon.clear();
        for i in 0..3 {
            let (a, b) = (corners[i], corners[(i + 1) % 3]);
            if a[2] > 0. { polygon.push(a); }
            if (a[2] > 0.) != (b[2] > 0.) {
                let t = a[2] / (a[2] - b[2]);
                polygon.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), 0.]);
            }
        }
        for i in 1..polygon.len().saturating_sub(1) {
            let (a, b, c) = (polygon[0], polygon[i], polygon[i + 1]);
            let projected = ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2.;
            volume += projected * (a[2] + b[2] + c[2]) / 3.;
        }
    }
    volume.is_finite().then_some(volume.abs())
}

/// Whether the material beyond a clip plane is within the frozen volume limit of the part.
pub fn within_clip_limit(beyond: f64, part_volume: f64, curved: bool) -> bool {
    beyond <= super::layer_caps::relative_tolerance(curved) * part_volume
}

/// Every plain halfspace on the host spine of this Boolean result, as (entity, plane <- result).
/// Later Differences only remove, so an earlier plane still bounds the result. Any other
/// operator can add material back beyond it, and ends the walk.
fn spine_planes<R: NumericalReceipt>(root: &RuntimeRealization<R>) -> Vec<(u32, [f64; 16])> {
    let mut planes = Vec::new();
    let (mut node, mut from_part) = (root, IDENTITY);
    for _ in 0..MAX_SPINE {
        let ReceiptEvidence::Boolean { operation, world_from_left, world_from_right, world_from_evaluation, .. } = node.kind.evidence() else { break };
        let [Some(left), Some(right)] = &node._inputs else { break };
        let right_is = |role| matches!(right.kind.evidence(), ReceiptEvidence::Construction(c)
            if matches!(c.request().recipe(), RetainedRecipe::Prism(p) if p.role == role));
        match operation {
            BoolOp::Difference => {
                if right_is(PrismRole::HalfSpace) {
                    if let (Ok(frame), ReceiptEvidence::Construction(c)) = (relative_frame(*world_from_right, *world_from_evaluation), right.kind.evidence()) {
                        planes.push((c.request().recipe().solid_id(), retained_wire::multiply(frame, from_part)));
                    }
                }
            }
            BoolOp::Intersection if right_is(PrismRole::LayerRegion) => {}
            _ => break,
        }
        let Ok(frame) = relative_frame(*world_from_left, *world_from_evaluation) else { break };
        from_part = retained_wire::multiply(frame, from_part);
        node = &**left;
    }
    planes
}

pub(super) fn admit<R: NumericalReceipt>(witness: &witness::RuntimeProductWitness<R>)
    -> Result<(), RetainedExecutionError> {
    witness.resources.with_scope(|| {
        for value in witness.plan.values() {
            let (_, node) = witness.ledger.iter().find(|(v, _)| v.as_ref().definition() == value.definition())
                .ok_or_else(|| protocol(ReceiptFailure::UndischargedDefinition))?;
            let (base, _) = super::affine_final::chain(node, witness.ledger.len())?;
            let Some(mesh) = base.kind.mesh() else { continue };
            let planes = spine_planes(base);
            if planes.is_empty() { continue; }
            let Some(part_volume) = super::chordal::mesh_volume(mesh.positions, mesh.indices) else { continue };
            let curved = super::publication::host_curved(base);
            for (entity, plane) in planes {
                resource::charge(resource::Cost { work: (mesh.indices.len() as u64) / 3, ..Default::default() })
                    .map_err(RetainedExecutionError::Stopped)?.retain();
                let Some(beyond) = volume_beyond(mesh.positions, mesh.indices, &plane) else { continue };
                if !within_clip_limit(beyond, part_volume, curved) {
                    return Err(RetainedExecutionError::ClipSliver { entity: Some(entity) });
                }
            }
        }
        Ok(())
    })
}
