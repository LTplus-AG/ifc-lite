// SPDX-License-Identifier: MPL-2.0
//! Source-free identity and shared metadata used only by presentation assembly.
//! No decoded entity, decoder or router can reach assembly through this view.
use super::{ElementMeshJob, ElementMeshMetadata};
use ifc_lite_core::IfcType;

/// Borrowed and `Copy`: carrying it with every part costs nothing.
#[derive(Clone, Copy)]
pub(super) struct AssemblyJob<'a> {
    pub id: u32,
    pub ifc_type: &'a IfcType,
    metadata: Option<&'a ElementMeshMetadata>,
}
impl<'a> AssemblyJob<'a> {
    pub fn metadata(&self) -> Option<&'a ElementMeshMetadata> {
        self.metadata
    }
}
impl<'a, 'source: 'a> From<&'a ElementMeshJob<'source>> for AssemblyJob<'a> {
    fn from(job: &'a ElementMeshJob<'source>) -> Self {
        Self {
            id: job.id,
            ifc_type: &job.ifc_type,
            metadata: job.metadata,
        }
    }
}
