// SPDX-License-Identifier: MPL-2.0
//! Decoder-free palette output; source selection has already completed.
use super::presentation::SourceId;
use super::{AssemblyJob, MeshData};
use ifc_lite_geometry::{calculate_normals, Mesh};

pub(super) fn emit_palette(
    groups: Vec<(crate::style::Rgba, Mesh)>,
    job: &AssemblyJob<'_>,
    source: SourceId,
    class: u8,
    rotation: Option<&Vec<f64>>,
) -> Vec<MeshData> {
    groups
        .into_iter()
        .map(|(color, mut mesh)| {
            if mesh.normals.len() != mesh.positions.len() {
                calculate_normals(&mut mesh);
            }
            super::assembly_submeshes::build(job, mesh, color.to_array(), None, source, class, rotation, None)
        })
        .collect()
}
