// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The merged mapped-item walk as a [`WalkVisitor`] (C2-3): the source cache is
//! checked at `enter_map`, a level's items merge into one source-coords mesh
//! per f64 frame (#6446), and `leave_map` caches the source, bakes this level's
//! `MappingTarget` and stamps the instance metadata.

use super::diagnostics::UnsupportedSourceScope;
use super::frame_parts::SourceParts;
use super::transforms::instancing_enabled;
use super::GeometryRouter;
use crate::math::mat4;
use crate::representation::{Flow, MappedLevel, WalkCtx, WalkRefusal, WalkVisitor};
use crate::{Error, InstanceMeta, Mesh, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use nalgebra::Matrix4;
use std::sync::Arc;

/// What the sink remembers of one entered `IfcMappedItem` level.
struct Frame<'r> {
    source: SourceParts,
    /// Set when a bound cut this level's mesh short (see the shared-cache guard
    /// in [`MergeSink::finish`]): either a nested item whose error this level
    /// swallowed, or a nested level that was itself truncated. The level ORs it
    /// into its parent's on the way out, so the flag reaches every enclosing
    /// level whose merged mesh is short.
    truncated: bool,
    mapping_transform: Option<Matrix4<f64>>,
    source_id: u32,
    /// The finished parts of a source-cache hit.
    hit: Option<Vec<Mesh>>,
    /// The level's transform failed: it contributes nothing.
    failed: bool,
    /// One scope for this source's whole walk: only a BODY representation's
    /// dropped item is a content loss, and this source's drops are counted the
    /// FIRST time any path walks it, not once per occurrence. See
    /// `GeometryRouter::enter_unsupported_source`.
    _drop_scope: Option<UnsupportedSourceScope<'r>>,
}

pub(super) struct MergeSink<'a> {
    pub(super) router: &'a GeometryRouter,
    frames: Vec<Frame<'a>>,
    pub(super) parts: Option<Vec<Mesh>>,
    pub(super) error: Option<Error>,
}

impl<'a> MergeSink<'a> {
    pub(super) fn new(router: &'a GeometryRouter) -> Self {
        Self { router, frames: Vec::new(), parts: None, error: None }
    }

    /// A level that could not run: the top one fails the call; a nested one
    /// truncates its parent and is counted as the lost `IfcMappedItem`.
    fn level_failed(&mut self, item: &DecodedEntity, error: Error, top: bool, entered: bool) {
        // Failing the items of an entered level: that level (the last frame)
        // contributes nothing and the parent is the one below it.
        // An unentered cycle may repeat the current frame's id. Ownership
        // follows the enter/Items phase, never the entity id (#7873).
        let parent = self.frames.len().saturating_sub(if entered { 2 } else { 1 });
        if entered {
            if let Some(frame) = self.frames.last_mut() {
                frame.failed = true;
            }
        }
        if top {
            self.error = Some(error);
        } else {
            if let Some(parent) = self.frames.get_mut(parent) {
                parent.truncated = true;
            }
            // Recording `IfcMappedItem` (not the inner item's type) is
            // deliberate: the inner walk errored before it could attribute
            // anything, so this level names the item it actually lost.
            self.router.drop_item(item, &error, "nested IfcMappedItem");
        }
    }

    /// The finished parts of a level whose items were merged.
    fn finish(&self, frame: Frame<'_>) -> Result<(Vec<Mesh>, bool)> {
        crate::resource::check_current()?;
        let router = self.router;
        let level_truncated = frame.truncated;
        let source_id = frame.source_id;
        let mut parts = frame.source.into_parts()?;
        // A multi-frame source is never cached or instanced: both assume one
        // source-coords mesh per map (#6446). No fixture-corpus map is one.
        let single_frame = parts.len() == 1;
        // Store in cache (before transformation, so cached mesh is in source
        // coordinates). Shared model-wide cache first (#1623), else the per-router
        // RefCell. A concurrent miss on the same source by another router rebuilds
        // an identical source-coords mesh, so an overwrite here is byte-identical.
        // Brief lock only — the source build above ran outside it (no join held).
        match &router.shared_mapped_item_cache {
            _ if !single_frame => {}
            Some(shared) => {
                // #1257: shared CSG-budget fallbacks must not escape to fresh
                // elements. Keep that policy separate from traversal truncation:
                // depth, cycles and per-walk work depend on the current path and
                // allowance, which source_id cannot encode. Neither cache may
                // publish those partial sources, even within the same router.
                if !parts[0].positions.is_empty()
                    && !crate::kernel::budget::tripped()
                    && !level_truncated
                {
                    let source_arc = router.clone_source_for_cache(&parts[0])?;
                    shared.lock().unwrap_or_else(|e| e.into_inner()).insert(source_id, source_arc);
                }
            }
            None if !level_truncated => {
                let source_arc = router.clone_source_for_cache(&parts[0])?;
                router.mapped_item_cache.borrow_mut().insert(source_id, source_arc);
            }
            None => {}
        }
        // Apply MappingTarget transformation to this instance
        let mut local_rm = None;
        if let Some(mut transform) = frame.mapping_transform {
            router.scale_transform(&mut transform);
            if instancing_enabled() {
                local_rm = Some(mat4::from_na(&transform));
            }
            for part in &mut parts {
                router.transform_mesh_local(part, &transform);
            }
        }
        if instancing_enabled() && single_frame {
            parts[0].instance_meta = Some(InstanceMeta::instanceable(source_id as u128, local_rm));
        }
        Ok((parts, level_truncated))
    }
}

impl WalkVisitor for MergeSink<'_> {
    fn item(&mut self, item: &DecodedEntity, _at: &WalkCtx<'_>, decoder: &mut EntityDecoder) -> Flow {
        if let Some(frame) = self.frames.last_mut() {
            self.router.merge_source_item(item, decoder, &mut frame.source, "mapped-source");
        }
        if crate::resource::check_current().is_err() { Flow::Stop } else { Flow::Continue }
    }

    fn enter_map(&mut self, level: &MappedLevel, at: &WalkCtx<'_>, decoder: &mut EntityDecoder) -> Flow {
        let router = self.router;
        let source_id = level.map.id;
        // MappingTarget (attr 1) composed over the map's MappingOrigin (attr 0),
        // which applies innermost. #1985
        let mapping_transform = match level.local_transform(decoder) {
            Ok(transform) => transform,
            Err(error) => {
                self.level_failed(&level.item, error, at.path.is_empty(), false);
                self.frames.push(Frame {
                    source: SourceParts::default(),
                    truncated: false,
                    mapping_transform: None,
                    source_id,
                    hit: None,
                    failed: true,
                    _drop_scope: None,
                });
                return Flow::SkipChildren;
            }
        };
        // Check cache first. The model-wide shared cache (#1623) takes precedence
        // over the per-router RefCell fallback so a source shared across owning
        // elements is meshed once model-wide (a fresh router — hence a fresh
        // RefCell — is built per element). Only a brief get/clone runs under the
        // shared lock; the source build (which nests faceted-brep's rayon
        // `par_iter`) runs OUTSIDE any lock, so a lock is never held across a nested
        // join (the #1587 deadlock class).
        let cached_source: Option<Arc<Mesh>> = match &router.shared_mapped_item_cache {
            Some(shared) => {
                shared.lock().unwrap_or_else(|e| e.into_inner()).get(&source_id).cloned()
            }
            None => router.mapped_item_cache.borrow().get(&source_id).cloned(),
        };
        let mut frame = Frame {
            source: SourceParts::default(),
            truncated: false,
            mapping_transform,
            source_id,
            hit: None,
            failed: false,
            _drop_scope: None,
        };
        if let Some(cached_mesh) = cached_source {
            let mut mesh = match router.clone_cached_mesh(cached_mesh.as_ref()) {
                Ok(mesh) => mesh,
                Err(error) => {
                    self.error = Some(error);
                    frame.failed = true;
                    self.frames.push(frame);
                    return Flow::Stop;
                }
            };
            let mut local_rm = None;
            if let Some(mut transform) = mapping_transform {
                router.scale_transform(&mut transform);
                if instancing_enabled() {
                    local_rm = Some(mat4::from_na(&transform));
                }
                router.transform_mesh_local(&mut mesh, &transform);
            }
            // Instancing: all occurrences of this RepresentationMap share the
            // cached source-coords geometry; `local_transform` is the mapping
            // (canonical -> element-local), `transform` is filled later by the
            // element's apply_placement (element-local -> world).
            if instancing_enabled() {
                mesh.instance_meta = Some(InstanceMeta::instanceable(source_id as u128, local_rm));
            }
            frame.hit = Some(vec![mesh]);
            self.frames.push(frame);
            return Flow::SkipChildren;
        }
        frame._drop_scope = Some(router.enter_unsupported_source(source_id, &level.mapped_rep));
        self.frames.push(frame);
        Flow::Continue
    }

    fn leave_map(&mut self, _level: &MappedLevel) {
        let Some(mut frame) = self.frames.pop() else { return };
        if frame.failed || self.error.is_some() {
            return;
        }
        let parts = match frame.hit.take() {
            Some(hit) => hit,
            None => {
                let (parts, truncated) = match self.finish(frame) {
                    Ok(finished) => finished,
                    Err(error) => { self.error = Some(error); return; }
                };
                // The merge is short, so every enclosing level's is too.
                if let Some(parent) = self.frames.last_mut() {
                    parent.truncated |= truncated;
                }
                parts
            }
        };
        match self.frames.last_mut() {
            Some(parent) => parts.iter().for_each(|part| parent.source.merge(part)),
            None => self.parts = Some(parts),
        }
    }

    fn refused(&mut self, item: &DecodedEntity, why: WalkRefusal, at: &WalkCtx<'_>) {
        let entered = self.frames.len() > at.path.len();
        let error = why.into_error(item.id);
        self.level_failed(item, error, at.path.is_empty(), entered);
    }
}
