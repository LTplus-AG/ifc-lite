// SPDX-License-Identifier: MPL-2.0
//! Decoder-free palette output; source selection has already completed.
use super::assembly_submeshes::Record;
use super::presentation::SourceId;
use super::{AssemblyJob, MeshData};
use crate::types::presentation::NormalProvenance;
use ifc_lite_geometry::{calculate_normals, Mesh};

pub(super) fn emit_palette(
    groups: Vec<(usize, crate::style::Rgba, Mesh)>,
    job: &AssemblyJob<'_>,
    source: SourceId,
    class: u8,
    rotation: Option<&Vec<f64>>,
    record: Option<Record<'_>>,
) -> Vec<MeshData> {
    groups
        .into_iter()
        .map(|(palette_index, color, mut mesh)| {
            let mut record = record;
            if mesh.normals.len() != mesh.positions.len() {
                calculate_normals(&mut mesh);
                record = record.map(|record| record.with_normals(NormalProvenance::RecomputedMissing));
            }
            let mut data =
                super::assembly_submeshes::build(job, mesh, color.to_array(), None, source, class, rotation, None);
            data.presentation = record.map(|record| Box::new(record.split_part(palette_index)));
            data
        })
        .collect()
}
