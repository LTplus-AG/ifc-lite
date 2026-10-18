// SPDX-License-Identifier: MPL-2.0
//! Product-owned inputs and state; no decoder, router or thread-local guard.
use super::assembly_job::AssemblyJob;
use super::plan::PrimaryStrategy;
use super::*;

pub(super) struct OwnedJob {
    pub id: u32,
    pub ifc_type: IfcType,
    pub entity: DecodedEntity,
    pub metadata: Option<ElementMeshMetadata>,
}
impl OwnedJob {
    pub fn new(job: &ElementMeshJob<'_>) -> Self {
        Self { id: job.id, ifc_type: job.ifc_type.clone(), entity: job.entity.clone(),
            metadata: job.metadata.cloned() }
    }
    pub fn assembly(&self) -> AssemblyJob<'_> {
        AssemblyJob { id: self.id, ifc_type: &self.ifc_type,
            entity: &self.entity, metadata: self.metadata.as_ref() }
    }
}

pub(super) enum Stage {
    Primary { strategy: PrimaryStrategy, layer_class: u8 },
    VoidedParts,
    PlainParts,
    TypeMaps(std::vec::IntoIter<(u32, u8)>),
    Complete,
}

pub(super) struct Scopes {
    pub budget: ifc_lite_geometry::kernel::budget::ElementState,
    pub degenerate: degenerate::ElementState,
    pub pending: ifc_lite_geometry::PendingDiagnosticState,
}
impl Scopes {
    pub fn new() -> Self {
        Self { budget: ifc_lite_geometry::kernel::budget::ElementState::new(),
            degenerate: degenerate::ElementState::new(),
            pending: ifc_lite_geometry::PendingDiagnosticState::new() }
    }
    pub fn with_scope<R>(&mut self, work: impl FnOnce() -> R) -> R {
        let Self { budget, degenerate, pending } = self;
        budget.with_scope(|| degenerate.with_scope(|| pending.with_scope(work)))
    }
}

/// While a synchronous owner is on the stack, an unwind delivers its captured
/// pending reports to the caller and leaves the continuation poisoned. Dormant
/// state has no implicit publication: cancellation needs a terminal protocol.
pub(super) struct ActiveScopes(Option<Scopes>);
impl ActiveScopes {
    pub fn new(scopes: Scopes) -> Self { Self(Some(scopes)) }
    pub fn with_scope<R>(&mut self, work: impl FnOnce() -> R) -> R {
        self.0.as_mut().expect("active work scopes").with_scope(work)
    }
    pub fn complete(mut self) -> Scopes { self.0.take().expect("completed work scopes") }
}
impl Drop for ActiveScopes {
    fn drop(&mut self) {
        if let Some(scopes) = &mut self.0 { scopes.pending.publish_pending(); }
    }
}

/// Never retained in a session: restores router configuration before a poll
/// returns or unwinds, including a registered processor's panic.
pub(super) struct TriangleOrderScope<'a> {
    router: &'a GeometryRouter,
    previous: Option<bool>,
}
impl<'a> TriangleOrderScope<'a> {
    pub fn new(router: &'a GeometryRouter, preserve: bool) -> Self {
        Self { router, previous: Some(router.set_preserve_triangle_order(preserve)) }
    }
    /// Retain mutations made by a reached extension for the next product
    /// step, while restoring the caller's setting between polls.
    pub fn finish(mut self) -> bool {
        self.router.set_preserve_triangle_order(self.previous.take().expect("open order scope"))
    }
}
impl Drop for TriangleOrderScope<'_> {
    fn drop(&mut self) {
        if let Some(previous) = self.previous { self.router.set_preserve_triangle_order(previous); }
    }
}
