// SPDX-License-Identifier: MPL-2.0
//! Source-free identity and shared metadata used only by presentation assembly.
use super::{ElementMeshJob, ElementMeshMetadata};
use ifc_lite_core::IfcType;
use std::sync::Arc;

#[derive(Clone)]
pub(super) enum AssemblyMetadata<'a> {
    Borrowed(Option<&'a ElementMeshMetadata>),
    Shared(Option<Arc<ElementMeshMetadata>>),
}

#[derive(Clone)]
pub(super) struct AssemblyJob<'a> {
    pub id: u32,
    pub ifc_type: IfcType,
    pub metadata: AssemblyMetadata<'a>,
}
impl AssemblyJob<'_> {
    pub fn metadata(&self) -> Option<&ElementMeshMetadata> {
        match &self.metadata {
            AssemblyMetadata::Borrowed(meta) => *meta,
            AssemblyMetadata::Shared(meta) => meta.as_deref(),
        }
    }
}
impl<'a, 'source: 'a> From<&'a ElementMeshJob<'source>> for AssemblyJob<'a> {
    fn from(job: &'a ElementMeshJob<'source>) -> Self {
        Self {
            id: job.id,
            ifc_type: job.ifc_type.clone(),
            metadata: AssemblyMetadata::Borrowed(job.metadata),
        }
    }
}
