// SPDX-License-Identifier: MPL-2.0
//! The synchronous driver's single owner epoch, and publication.
//!
//! A product is planned, advanced ticket by ticket and published inside ONE
//! owner epoch: the decoder and router are leased once, the per-element
//! budget, degenerate tally and pending reports are installed once, and the
//! lexical capabilities for nested children and scoped workers are created
//! once. Each slice still runs its own triangle-order scope, so final hooks
//! see the caller's mode, and every ticket is still validated by the protocol.
use super::session::{Live, ProductState};
use super::session_owner::ProductOwner;
use super::session_protocol::WorkError;
use super::session_state::{ActiveScopes, Scopes, Stage};
use super::*;
use ifc_lite_geometry::resource::{self, ProgramStop};

/// Output is provisional until both source and owner validation succeed.
/// On rejection or unwind, preserve its drained diagnostics without replaying
/// final hooks or letting a later product adopt them. Geometry is discarded.
pub(super) struct Publication<'r> {
    router: &'r GeometryRouter,
    pub output: Option<ProducedElementMeshes>,
}
impl<'r> Publication<'r> {
    pub fn new(router: &'r GeometryRouter) -> Self {
        Self { router, output: None }
    }
    pub fn commit(mut self) -> Result<ProducedElementMeshes, WorkError> {
        self.output.take().ok_or(WorkError::Aborted)
    }
}
impl Drop for Publication<'_> {
    fn drop(&mut self) {
        if let Some(output) = &mut self.output {
            self.router.quarantine_unpublished_csg_failures(std::mem::take(&mut output.csg_failures));
        }
    }
}

/// Admit (or inherit) the owners, open the epoch, run `body` inside it and
/// publish the epoch's pending reports on every return path. `body` returns
/// the stop its product reached, if any, which is applied to the caller's
/// resource domain on the way out. The (large) output never travels through
/// this result: `body` writes it to a slot it captured.
pub(super) fn run_epoch(
    decoder: &mut EntityDecoder,
    router: &GeometryRouter,
    context: Option<ProductionContextId>,
    body: impl FnOnce(&mut EntityDecoder, &GeometryRouter, Live) -> Result<Option<ProgramStop>, WorkError>,
) -> Result<(), WorkError> {
    let mut owner = match session_canonical::inherited_owner(decoder, router)? {
        Some(owner) => owner,
        None => ProductOwner::admit(decoder, router)?,
    };
    let live = Live {
        stamp: owner.validate(decoder, router)?,
        decoder: decoder.execution_identity(),
        context,
        preplanning_stop: resource::check_current().err(),
    };
    let mut scopes = ActiveScopes::new(Scopes::new());
    let outcome = router.with_product_csg_scope(|| {
        owner.work(decoder, router, |decoder, router| {
            scopes.with_scope(|| {
                // A stopped product runs no hook; any other starts from a
                // clean opaque-log boundary on its router.
                if live.preplanning_stop.is_none() {
                    router.settle_opaque_csg_failures();
                }
                body(decoder, router, live)
            })
        })
    });
    // Reports the product's router did not drain reach the caller's thread,
    // as they did before they were owned, including after a failed commit.
    scopes.complete().pending.publish_pending();
    let (inner, _) = outcome?;
    if let Some(stop) = inner? {
        resource::stop(stop);
    }
    Ok(())
}

impl ProductState<'_> {
    /// Prepare output inside the open epoch; the driver validates publication.
    /// A stopped product runs no final hook and adopts nothing ambient; its
    /// output is empty and its stop is returned.
    pub(super) fn finish_live(
        mut self,
        router: &GeometryRouter,
        output: &mut Option<ProducedElementMeshes>,
    ) -> Result<Option<ProgramStop>, WorkError> {
        if self.live.is_none() {
            return Err(WorkError::Aborted);
        }
        if self.capture_stop() {
            router.quarantine_recorded_csg_failures();
            *output = Some(session_canonical::stopped_output());
            return Ok(self.terminal());
        }
        if !matches!(self.stage, Stage::Complete) {
            return Err(WorkError::Unfinished);
        }
        self.protocol.idle()?;
        self.apply_fixed_color();
        // Final hooks run here, in the epoch, so a hook that produces a nested
        // child on this router inherits this product's owners. Draining on
        // every return path leaves a warm router clean for the next element.
        match router.finish_product_csg_failures() {
            Ok(failures) => {
                *output = Some(self.publish(failures, degenerate::dropped_this_element()));
                Ok(None)
            }
            Err(stop) => {
                self.remember_stop(stop);
                *output = Some(session_canonical::stopped_output());
                Ok(self.terminal())
            }
        }
    }

    /// A class with a fixed display colour (openings, #5409) overrides
    /// whatever colour the style precedence resolved, on every mesh AND every
    /// don't-bake occurrence, so no path can leak one.
    pub(super) fn apply_fixed_color(&mut self) {
        if let Some(fixed) = crate::style::fixed_display_color_for_type(&self.job.ifc_type) {
            let fixed = fixed.to_array();
            for mesh in &mut self.meshes {
                mesh.color = fixed;
                mesh.texture = None;
                mesh.uvs = None;
            }
            for occurrence in &mut self.occurrences {
                occurrence.color = fixed;
            }
        }
    }

    /// The published output. The verdict was taken where the orienter runs;
    /// the degenerate backstop then dropped triangles from the same meshes, so
    /// retract before reading what ships.
    pub(super) fn publish(
        self,
        csg_failures: FxHashMap<u32, Vec<BoolFailure>>,
        dropped: u64,
    ) -> ProducedElementMeshes {
        let (geometry_hash, geometry_aabb, geometry_volume, geometry_closure) = match self.hasher {
            Some(mut h) if !h.is_empty() => {
                h.retract_closure_if_mesh_edited(dropped);
                (Some(h.finish()), h.world_aabb(), h.volume(), Some(h.closure()))
            }
            _ => (None, None, None, None),
        };
        ProducedElementMeshes {
            meshes: self.meshes,
            instance_occurrences: self.occurrences,
            geometry_hash,
            geometry_aabb,
            geometry_volume,
            geometry_closure,
            csg_failures,
            degenerate_triangles_dropped: dropped,
        }
    }
}
