// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use super::solid::extract_extruded_solid;
use crate::representation::{Flow, MappedLevel, WalkRefusal};
use nalgebra::Matrix4;

// ═══════════════════════════════════════════════════════════════════════════
// PRIVATE: THE WALK VISITOR
// ═══════════════════════════════════════════════════════════════════════════

/// The element's world placement (IFC Z-up, metres), resolved on the first
/// extractable item: an element with no extrusion never needs it.
pub(super) enum Placement {
    Unresolved,
    Resolved(Matrix4<f64>),
    /// Reported once; nothing of the element can be drawn.
    Failed,
}

/// What the walk's visits mean to the 2D drawing: extrusion leaves become
/// profiles, mapped levels compose their transforms, and every refusal the walk
/// reports, and every leaf that cannot be extracted, becomes a
/// [`SkippedProfile`] of the element.
pub(super) struct ProfileSink<'a> {
    pub(super) router: &'a GeometryRouter,
    pub(super) profile_processor: &'a ProfileProcessor,
    pub(super) element: &'a DecodedEntity,
    pub(super) ifc_type: &'a str,
    pub(super) model_index: u32,
    pub(super) placement: Placement,
    /// `placement · Π (MappingTarget · MappingOrigin)` per entered level,
    /// translation in metres: the mesh path's own composition (#1985).
    pub(super) frames: Vec<Matrix4<f64>>,
    pub(super) results: &'a mut Vec<ExtractedProfile>,
    pub(super) skipped: &'a mut Vec<SkippedProfile>,
    pub(super) terminal: Option<crate::resource::ProgramStop>,
}

impl ProfileSink<'_> {
    fn check(&mut self) -> Flow {
        if let Err(stop) = crate::resource::check_current() { self.terminal = Some(stop); }
        if self.terminal.is_some() { Flow::Stop } else { Flow::Continue }
    }

    pub(super) fn finish(&mut self) -> crate::Result<()> {
        self.check();
        match self.terminal {
            Some(stop) => Err(stop.into()),
            None => Ok(()),
        }
    }

    fn failed(&mut self, error: crate::Error, context: &str) {
        // Observe an already pending cancellation before adopting a callback's
        // terminal; a resource stop must never replace the sticky first stop.
        if self.check() == Flow::Stop { return; }
        if let crate::Error::ProgramStopped(stop) = error {
            self.terminal = Some(crate::resource::stop(stop));
        } else {
            self.drop(format!("{context}{error}"));
        }
    }

    /// The transform an item at the current level is placed by; `None` once the
    /// element's placement failed (reported here, once).
    fn frame(&mut self, decoder: &mut EntityDecoder) -> Option<Matrix4<f64>> {
        if self.check() == Flow::Stop { return None; }
        if let Some(frame) = self.frames.last() {
            return Some(*frame);
        }
        if let Placement::Unresolved = self.placement {
            self.placement = match self.router.resolve_scaled_placement(self.element, decoder) {
                Ok(m) => Placement::Resolved(Matrix4::from_column_slice(&m)),
                Err(e) => {
                    // The element's placement, not this item's: no later
                    // representation can be drawn either, so report it once.
                    self.failed(e, "placement: ");
                    Placement::Failed
                }
            };
        }
        match self.placement {
            Placement::Resolved(m) => Some(m),
            _ => None,
        }
    }

    /// Record a dropped profile of the element.
    fn drop(&mut self, reason: String) {
        if self.check() == Flow::Stop { return; }
        crate::diag::diag_debug!(
            { element_id = self.element.id, ifc_type = %self.ifc_type, reason = %reason,
              "profile_extractor: skipping profile" }
            else {
                #[cfg(feature = "debug_geometry")]
                eprintln!("[profile_extractor] Skipping #{} ({}): {reason}", self.element.id, self.ifc_type);
            }
        );
        self.skipped.push(SkippedProfile {
            express_id: self.element.id,
            ifc_type: self.ifc_type.to_string(),
            reason,
        });
    }
}

impl WalkVisitor for ProfileSink<'_> {
    fn item(&mut self, item: &DecodedEntity, _at: &WalkCtx<'_>, decoder: &mut EntityDecoder) -> Flow {
        if self.check() == Flow::Stop { return Flow::Stop; }
        if !is_extruded_area_solid(item.ifc_type.clone()) {
            return Flow::Continue;
        }
        let Some(frame) = self.frame(decoder) else { return Flow::Stop };
        let unit_scale = self.router.unit_scale();
        let (element, ifc_type) = (self.element.id, self.ifc_type);
        match extract_extruded_solid(element, ifc_type, item, &frame, unit_scale, self.profile_processor, decoder, self.model_index) {
            Ok(entry) => {
                if self.check() == Flow::Stop { return Flow::Stop; }
                self.results.push(entry);
            }
            Err(e) => self.failed(e, ""),
        }
        self.check()
    }

    fn enter_map(&mut self, level: &MappedLevel, _at: &WalkCtx<'_>, decoder: &mut EntityDecoder) -> Flow {
        let parent = self.frame(decoder);
        // The engine pairs EVERY enter callback, even an early Stop. Reserve
        // this scope before returning so leave_map cannot pop its parent.
        self.frames.push(parent.unwrap_or_else(Matrix4::identity));
        let Some(parent) = parent else { return Flow::Stop };
        // MappingTarget · MappingOrigin, translation in metres: the mesh path's
        // own composition (#1985), so the drawing and the 3D item cannot
        // disagree about a target, a 2D origin or a broken reference.
        let (frame, flow) = match self.router.resolve_scaled_mapped_item_transform(&level.item, &level.map, decoder) {
            Ok(Some(m)) => (parent * Matrix4::from_column_slice(&m), Flow::Continue),
            Ok(None) => (parent, Flow::Continue),
            Err(e) => {
                self.failed(e, &format!("mapped item #{}: ", level.item.id));
                (parent, Flow::SkipChildren)
            }
        };
        if let Some(current) = self.frames.last_mut() { *current = frame; }
        if self.check() == Flow::Stop { Flow::Stop } else { flow }
    }

    fn leave_map(&mut self, _level: &MappedLevel) {
        self.frames.pop();
        self.check();
    }

    fn refused(&mut self, item: &DecodedEntity, why: WalkRefusal, _at: &WalkCtx<'_>) {
        if self.check() == Flow::Stop { return; }
        // A failed placement is the element's only record (as it always was).
        // The walk refuses before a level is entered and hands no decoder, so a
        // refusal does not resolve the placement itself.
        if !matches!(self.placement, Placement::Failed) {
            self.drop(format!("mapped item #{}: {}", item.id, why.into_error(item.id)));
        }
    }
}
