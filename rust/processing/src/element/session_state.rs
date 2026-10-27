// SPDX-License-Identifier: MPL-2.0
//! Product-owned stage and per-element state; no decoder, router or installed
//! thread-local guard survives between synchronous work slices.
use super::plan::PrimaryStrategy;
use super::*;

pub(super) enum Stage<'j> {
    Primary { strategy: PrimaryStrategy, layer_class: u8 },
    VoidedParts,
    PlainParts,
    TypeMaps(std::slice::Iter<'j, (u32, u8)>),
    Complete,
}

/// The product-independent numerical and diagnostic state of one element.
///
/// Exact-work budget, degenerate-triangle tally and pending reports are owned
/// values installed for one synchronous slice, so a rayon work-steal that runs
/// another element to completion inside this one cannot read or clear them.
pub(super) struct Scopes {
    pub budget: ifc_lite_geometry::kernel::budget::ElementState,
    pub degenerate: degenerate::ElementState,
    pub pending: ifc_lite_geometry::PendingDiagnosticState,
}
impl Scopes {
    pub fn new() -> Self {
        Self {
            budget: ifc_lite_geometry::kernel::budget::ElementState::new(),
            degenerate: degenerate::ElementState::new(),
            pending: ifc_lite_geometry::PendingDiagnosticState::new(),
        }
    }
    /// Every scope restores the caller's counters and reports on return and
    /// on unwind.
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
    pub fn new(scopes: Scopes) -> Self {
        Self(Some(scopes))
    }
    pub fn with_scope<R>(&mut self, work: impl FnOnce() -> R) -> R {
        match &mut self.0 {
            Some(scopes) => scopes.with_scope(work),
            // `complete` consumes the guard, so an active guard always holds.
            None => work(),
        }
    }
    pub fn complete(mut self) -> Scopes {
        self.0.take().unwrap_or_else(Scopes::new)
    }
}
impl Drop for ActiveScopes {
    fn drop(&mut self) {
        if let Some(scopes) = &mut self.0 {
            scopes.pending.publish_pending();
        }
    }
}

/// Never retained in a session: restores router configuration before a slice
/// returns or unwinds, including a registered processor's panic.
pub(super) struct TriangleOrderScope<'a> {
    router: &'a GeometryRouter,
    previous: Option<bool>,
}
impl<'a> TriangleOrderScope<'a> {
    pub fn new(router: &'a GeometryRouter, preserve: bool) -> Self {
        Self { router, previous: Some(router.set_preserve_triangle_order(preserve)) }
    }
    /// Retain a mode a reached extension set for the next product slice,
    /// while restoring the caller's setting between slices.
    pub fn finish(mut self) -> bool {
        // `previous` is taken only here, so it is always present.
        self.previous
            .take()
            .is_some_and(|previous| self.router.set_preserve_triangle_order(previous))
    }
}
impl Drop for TriangleOrderScope<'_> {
    fn drop(&mut self) {
        if let Some(previous) = self.previous {
            self.router.set_preserve_triangle_order(previous);
        }
    }
}

impl Stage<'_> {
    pub(super) fn next_kind(&mut self) -> Option<super::session_protocol::WorkKind> {
        use super::session_protocol::WorkKind;
        Some(match self {
            Stage::Complete => return None,
            Stage::Primary { strategy, layer_class } => WorkKind::Primary { strategy: *strategy, layer_class: *layer_class },
            Stage::VoidedParts => WorkKind::VoidedParts,
            Stage::PlainParts => WorkKind::PlainParts,
            Stage::TypeMaps(maps) => match maps.next() {
                Some(&(map_id, class)) => WorkKind::TypeMap { map_id, class },
                None => {
                    *self = Stage::Complete;
                    return None;
                }
            },
        })
    }
}
