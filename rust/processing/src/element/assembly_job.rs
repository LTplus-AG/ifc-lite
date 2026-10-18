// SPDX-License-Identifier: MPL-2.0
//! Borrowed identity and metadata used only by presentation assembly.
use super::{ElementMeshJob, ElementMeshMetadata};
use ifc_lite_core::{DecodedEntity, IfcType};

pub(super) struct AssemblyJob<'a> {
    pub id: u32,
    pub ifc_type: &'a IfcType,
    pub entity: &'a DecodedEntity,
    pub metadata: Option<&'a ElementMeshMetadata>,
}

impl<'a, 'source: 'a> From<&'a ElementMeshJob<'source>> for AssemblyJob<'a> {
    fn from(job: &'a ElementMeshJob<'source>) -> Self {
        Self { id: job.id, ifc_type: &job.ifc_type, entity: job.entity, metadata: job.metadata }
    }
}
