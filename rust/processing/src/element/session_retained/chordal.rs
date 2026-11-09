// SPDX-License-Identifier: MPL-2.0
//! #7955: a curved construction publishes its own tessellation only within the
//! curved volume tolerance of the exact sweep it encodes. The kernel bounds
//! each edge's chord height on its own and subdivides by powers of two, so the
//! two concentric arcs of one thin profile can land on different counts
//! (dental_clinic #2510 at chord 1 mm: 8 segments on the inner arc, 16 on the
//! outer, +0.68% volume). Each count honours the chord; their uncancelled sum
//! breaks the curved tolerance. Such a product is refused, never
//! re-tessellated: one construction, no replay.
use super::runtime::ReceiptEvidence;
use super::*;

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}
impl Reader<'_> {
    fn take<const N: usize>(&mut self) -> Option<[u8; N]> {
        let word = self.bytes.get(self.at..self.at.checked_add(N)?)?.try_into().ok()?;
        self.at += N;
        Some(word)
    }
    fn u32(&mut self) -> Option<u32> {
        self.take().map(u32::from_le_bytes)
    }
    fn f64(&mut self) -> Option<f64> {
        self.take().map(f64::from_le_bytes)
    }
}

/// Exact volume of a wire-format-1 sweep (metres³) and whether any boundary
/// is a circle or arc. Mirrors the adapter's own construction invariant
/// (`native/smlib-adapter/src/sweep.cpp`): twice the loop area from the exact
/// segments, times the projected depth. `None` for any other format or a
/// malformed payload, which this check never interprets.
pub(super) fn sweep_volume(format: u32, bytes: &[u8]) -> Option<(f64, bool)> {
    if format != 1 {
        return None;
    }
    let mut reader = Reader { bytes, at: 0 };
    let [_, loops, _, _] = [reader.u32()?, reader.u32()?, reader.u32()?, reader.u32()?];
    let [_, _, dz, depth] = [reader.f64()?, reader.f64()?, reader.f64()?, reader.f64()?];
    let (mut twice_area, mut curved) = (0., false);
    for _ in 0..loops {
        let [_, count] = [reader.u32()?, reader.u32()?];
        for _ in 0..count {
            let [kind, _] = [reader.u32()?, reader.u32()?];
            let mut v = [0.; 12];
            for value in &mut v {
                *value = reader.f64()?;
            }
            twice_area += match kind {
                1 => v[0] * v[4] - v[3] * v[1],
                2 | 3 => {
                    curved = true;
                    let sweep = if kind == 2 { std::f64::consts::TAU.copysign(v[11]) } else { v[11] };
                    let (yx, yy) = (-v[5] * v[7], v[5] * v[6]);
                    let point = |angle: f64| {
                        let (cos, sin) = (libm::cos(angle), libm::sin(angle));
                        [v[0] + v[9] * (v[6] * cos + yx * sin), v[1] + v[9] * (v[7] * cos + yy * sin)]
                    };
                    let (start, end) = (point(v[10]), point(v[10] + sweep));
                    v[0] * (end[1] - start[1]) - v[1] * (end[0] - start[0]) + v[5] * v[9] * v[9] * sweep
                }
                _ => return None,
            };
        }
    }
    let volume = twice_area.abs() * 0.5 * depth * dz.abs();
    (reader.at == bytes.len() && volume.is_finite() && volume > 0.).then_some((volume, curved))
}

/// Unsigned volume of a closed triangle mesh, about its first vertex.
pub(super) fn mesh_volume(positions: &[f64], indices: &[u32]) -> Option<f64> {
    let point = |index: u32| -> Option<[f64; 3]> {
        let at = usize::try_from(index).ok()?.checked_mul(3)?;
        positions.get(at..at.checked_add(3)?)?.try_into().ok()
    };
    let origin = point(*indices.first()?)?;
    let mut six = 0.;
    for triangle in indices.chunks_exact(3) {
        let [a, b, c] = [point(triangle[0])?, point(triangle[1])?, point(triangle[2])?]
            .map(|p| [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]]);
        six += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
            + a[2] * (b[0] * c[1] - b[1] * c[0]);
    }
    Some((six / 6.).abs())
}

/// Curved format-1 payloads only: a linear sweep's mesh is its exact solid.
pub(super) fn within_curved_volume(format: u32, bytes: &[u8], positions: &[f64], indices: &[u32]) -> bool {
    let Some((exact, true)) = sweep_volume(format, bytes) else { return true };
    let limit = super::layer_caps::relative_tolerance(true) * exact;
    mesh_volume(positions, indices).is_some_and(|mesh| (mesh - exact).abs() <= limit)
}

/// Every published part whose mesh is a construction's own tessellation,
/// directly or through an affine final, is checked. Boolean results carry no
/// nominal source volume and are out of scope here.
pub(super) fn admit<R: NumericalReceipt>(witness: &witness::RuntimeProductWitness<R>)
    -> Result<(), RetainedExecutionError> {
    witness.resources.with_scope(|| {
        for value in witness.plan.values() {
            let (_, node) = witness.ledger.iter().find(|(v, _)| v.as_ref().definition() == value.definition())
                .ok_or_else(|| protocol(ReceiptFailure::UndischargedDefinition))?;
            let (base, _) = super::affine_final::chain(node, witness.ledger.len())?;
            let ReceiptEvidence::Construction(completion) = base.kind.evidence() else { continue };
            let payload = completion.request().payload();
            let mesh = &completion.tessellation;
            if !within_curved_volume(payload.format, &payload.bytes, &mesh.positions, &mesh.indices) {
                return Err(RetainedExecutionError::ChordalVolume {
                    entity: Some(completion.request().recipe().solid_id()),
                });
            }
        }
        Ok(())
    })
}

#[cfg(test)]
#[path = "chordal_tests.rs"]
mod tests;
