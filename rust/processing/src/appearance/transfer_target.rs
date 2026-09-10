// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::{source::Source, transfer_math::*, transfer_types::TransferFrame, MappingFrame};
use crate::types::mesh::MeshData;

pub(super) struct TargetTriangle {
    pub points: [Point; 3],
    pub normal: Point,
    pub area: f64,
}
/// Associate raw TFS corners with the canonical renderer's winding. Refuse
/// topology changes instead of guessing triangle provenance after repair.
pub(super) fn prepare(
    source: &mut Source<'_>,
    product: u32,
    points: &[Point],
    triangles: &[[u32; 3]],
    mesh: &MeshData,
    frame: &TransferFrame,
) -> Result<Vec<TargetTriangle>, String> {
    if mesh.indices.len() != triangles.len() * 3 {
        return Err("Transfer target topology was changed by canonical repair".into());
    }
    let mut world = points.to_vec();
    super::mapping::positions_in_frame(source, product, &mut world, MappingFrame::World)?;
    let context = source
        .context
        .as_ref()
        .ok_or("Missing canonical target context")?;
    let rtc: Point = if context.meta.needs_shift {
        context.meta.rtc_offset.into()
    } else {
        [0.; 3]
    };
    let local_magnitude = mesh
        .positions
        .iter()
        .fold(1_f64, |m, v| m.max(f64::from(*v).abs()));
    let world_magnitude = world.iter().flatten().fold(1_f64, |m, v| m.max(v.abs()));
    let tolerance = 4. * f64::from(f32::EPSILON) * local_magnitude
        + 16. * f64::EPSILON * world_magnitude
        + 1e-10;
    let mut output = Vec::with_capacity(triangles.len());
    for (ordinal, indices) in triangles.iter().enumerate() {
        let raw = indices.map(|i| world[i as usize - 1]);
        let mut canonical = [[0.; 3]; 3];
        for (corner, p) in canonical.iter_mut().enumerate() {
            let index = mesh.indices[ordinal * 3 + corner] as usize;
            for axis in 0..3 {
                p[axis] =
                    f64::from(mesh.positions[index * 3 + axis]) + mesh.origin[axis] + rtc[axis];
            }
        }
        let min_edge = (0..3)
            .map(|i| {
                let e = sub(raw[i], raw[(i + 1) % 3]);
                dot(e, e).sqrt()
            })
            .fold(f64::INFINITY, f64::min);
        if tolerance > min_edge * 0.001 {
            return Err(
                "Transfer target corner provenance is below canonical coordinate precision".into(),
            );
        }
        let mut used = [false; 3];
        for point in canonical {
            let Some(i) = raw
                .iter()
                .enumerate()
                .position(|(i, p)| !used[i] && sub(*p, point).iter().all(|v| v.abs() <= tolerance))
            else {
                return Err(
                    "Transfer cannot associate canonical target triangles with source TFS corners"
                        .into(),
                );
            };
            used[i] = true;
        }
        let (raw_normal, area) = normal(raw)?;
        let (canonical_normal, _) = normal(canonical)?;
        let sign = if dot(raw_normal, canonical_normal) >= 0. {
            1.
        } else {
            -1.
        };
        let transformed = raw.map(|p| transform(frame, p));
        let (n, _) = normal(transformed)?;
        output.push(TargetTriangle {
            points: transformed,
            normal: n.map(|v| v * sign),
            area,
        });
    }
    Ok(output)
}
