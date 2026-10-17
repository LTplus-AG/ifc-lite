// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The element sub-mesh walk's mapped-item handling: a [`WalkVisitor`] over
//! `IfcMappedItem` levels (C2-3). The walk owns descent, depth and cycle
//! bounds; this sink owns what a level means to the sub-mesh output: the #1623
//! don't-bake decision, the per-source drop scope, the `MappingTarget` bake
//! over the sub-meshes the level added, and the template re-tag.

use super::item::ItemFrame;
use super::GeometryRouter;
use super::diagnostics::UnsupportedSourceScope;
use crate::math::mat4;
use crate::representation::{
    Flow, MappedLevel, NestedMaps, RepresentationWalk, Select, MAX_WALK_LEVELS, WalkCtx, WalkRefusal, WalkVisitor,
};
use crate::{Error, InstanceMeta, Mesh, Result, SubMesh, SubMeshCollection};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType, MAX_MAPPED_ITEM_DEPTH};
use nalgebra::Matrix4;
use rustc_hash::FxHashMap;

type TextureIndex = FxHashMap<u32, crate::processors::texture::ResolvedTextureMap>;

impl GeometryRouter {
    /// Collect sub-meshes from a representation item, following MappedItem references.
    /// `allow_instancing` enables the #1623 Phase 2 don't-bake path at the top-level
    /// mapped item.
    pub(super) fn collect_submeshes_from_item(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
        sub_meshes: &mut SubMeshCollection,
        allow_instancing: bool,
        texture_index: Option<&TextureIndex>,
    ) -> Result<()> {
        if item.ifc_type != IfcType::IfcMappedItem {
            self.submesh_plain_item(item, decoder, sub_meshes, 0, texture_index);
            return Ok(());
        }
        let mut sink = SubMeshSink {
            router: self,
            sub_meshes,
            allow_instancing,
            texture_index,
            frames: Vec::new(),
            error: None,
        };
        let walk = RepresentationWalk {
            select: Select::Any,
            nested: NestedMaps::Expand { max_depth: MAX_MAPPED_ITEM_DEPTH, max_levels: MAX_WALK_LEVELS },
        };
        walk.mapped_item(item, decoder, &mut sink);
        sink.error.map_or(Ok(()), Err)
    }

    /// A non-mapped item at `depth` mapped levels below the element.
    fn submesh_plain_item(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
        sub_meshes: &mut SubMeshCollection,
        depth: usize,
        texture_index: Option<&TextureIndex>,
    ) {
        // Textured tessellated face set (#1781): mesh with per-vertex UVs so
        // the occurrence path renders its image like the type-geometry path
        // (#961) always did. Bypasses the content-dedup cache — the cached
        // mesh has no UV channel, and UVs are per-face-set anyway. Falls
        // through to the plain path if the textured build fails. A nested
        // (mapped) item rebases by the model RTC (#5698) into its origin,
        // since its mapping targets and placement still apply (#7690).
        if let Some(map) = texture_index.and_then(|ti| ti.get(&item.id)) {
            let textured = self.textured_face_set(item, decoder, map, Some(self.rtc_offset()));
            if let Some((mut mesh, uvs)) = textured {
                if depth > 0 {
                    self.keep_rebase_in_origin(&mut mesh);
                }
                sub_meshes.add_textured(item.id, mesh, uvs, map.attachment());
                return;
            }
        }
        // Regular geometry item - process and record with its ID
        // Skip unsupported geometry types (e.g. IfcGeometricSet) instead of failing
        let frame = if depth > 0 { ItemFrame::Nested } else { ItemFrame::Direct };
        match self.mesh_item(item, decoder, frame) {
            Ok(mesh) => {
                if !mesh.is_empty() {
                    sub_meshes.add(item.id, mesh);
                }
            }
            Err(e) => self.drop_item(item, &e, "geometry"),
        }
    }
}

/// What the sink remembers of one entered `IfcMappedItem` level.
struct Frame<'r> {
    /// `MappingTarget · MappingOrigin` (file units); `None` for no transform.
    mapping_transform: Option<Matrix4<f64>>,
    /// Where this level's sub-meshes start in the output.
    start: usize,
    source_id: u32,
    /// The nested solid's id when this occurrence is don't-bake eligible.
    instance_solid_id: Option<u32>,
    is_template: bool,
    /// Whether the level's items run (false for a don't-bake placeholder or a
    /// level whose transform failed).
    active: bool,
    /// One scope for this source's walk. It covers the items AND the recursion
    /// beneath them: see `GeometryRouter::enter_unsupported_source`.
    _drop_scope: Option<UnsupportedSourceScope<'r>>,
}

struct SubMeshSink<'a> {
    router: &'a GeometryRouter,
    sub_meshes: &'a mut SubMeshCollection,
    allow_instancing: bool,
    texture_index: Option<&'a TextureIndex>,
    frames: Vec<Frame<'a>>,
    /// The error a top-level refusal reports; a nested one is only counted.
    error: Option<Error>,
}

impl SubMeshSink<'_> {
    /// A level that could not run: a top-level level fails the element's item,
    /// a nested one is dropped and counted.
    fn level_failed(&mut self, item: &DecodedEntity, error: Error, top: bool) {
        if top {
            self.error = Some(error);
        } else {
            self.router.drop_item(item, &error, "nested geometry");
        }
    }
}

impl WalkVisitor for SubMeshSink<'_> {
    fn item(&mut self, item: &DecodedEntity, at: &WalkCtx<'_>, decoder: &mut EntityDecoder) -> Flow {
        // A plain item below the depth cap is refused like a mapped one.
        if at.path.len() >= MAX_MAPPED_ITEM_DEPTH as usize {
            self.router.record_unsupported_item(item.ifc_type.clone());
            return Flow::Continue;
        }
        self.router.submesh_plain_item(item, decoder, self.sub_meshes, at.path.len(), self.texture_index);
        Flow::Continue
    }

    fn enter_map(&mut self, level: &MappedLevel, at: &WalkCtx<'_>, decoder: &mut EntityDecoder) -> Flow {
        let router = self.router;
        let top = at.path.is_empty();
        // MappingTarget · MappingOrigin (#1985: the origin used to be dropped).
        let mapping_transform = match level.local_transform(decoder) {
            Ok(transform) => transform,
            Err(error) => {
                self.level_failed(&level.item, error, top);
                self.frames.push(Frame {
                    mapping_transform: None,
                    start: self.sub_meshes.len(),
                    source_id: level.map.id,
                    instance_solid_id: None,
                    is_template: true,
                    active: false,
                    _drop_scope: None,
                });
                return Flow::SkipChildren;
            }
        };
        let source_id = level.map.id;
        // #1623 Phase 2/3 "don't-bake": if this top-level mapped item's source is
        // a REPEATED (count >= 2) single-solid `IfcRepresentationMap` the armed
        // plan lists, exactly ONE occurrence (the "template") materializes its
        // geometry; every OTHER occurrence skips the per-occurrence vertex clone /
        // MappingTarget bake / weld and emits an instance-only placeholder (empty
        // geometry carrying the mapping transform + rep_identity in `InstanceMeta`).
        // `apply_submesh_placement` folds the world placement into `im.transform`;
        // the finalize turns the placeholder into an occurrence against the template.
        //
        // `instance_solid_id` is the nested SOLID's id (used as the placeholder's
        // geometry_id so colour resolves EXACTLY as the flat/template sub-mesh).
        // Only fires at the TOP level — a mapped item nested inside another map is
        // part of its parent's shared geometry, not an independent occurrence — and
        // only when `allow_instancing` (the non-void path). With no armed plan this
        // is skipped entirely, so the flat output is unchanged.
        let instance_solid_id: Option<u32> = if self.allow_instancing && top {
            router
                .output_instancing_plan()
                .and_then(|plan| plan.get(&source_id).copied())
                .filter(|&(count, _)| count >= 2)
                .and_then(|_| {
                    router
                        .mapped_source_single_item(&level.mapped_rep, decoder)
                        // #858: a source whose single solid carries an
                        // IfcIndexedColourMap must materialize flat so
                        // emit_sub_meshes can split it into one mesh per palette
                        // group. An instance placeholder resolves ONE colour,
                        // collapsing the palette (WRONG vs the flat path); route
                        // to flat instead (byte-identical to instancing-off).
                        .filter(|&item_id| !router.is_indexed_colour_split_source(item_id))
                        // #1781: same rule for a TEXTURED single solid — an
                        // instance placeholder carries no UVs/texture, so the
                        // occurrence would render untextured. Materialize flat.
                        .filter(|&item_id| {
                            self.texture_index.is_none_or(|ti| !ti.contains_key(&item_id))
                        })
                })
        } else {
            None
        };
        // Which occurrence MATERIALIZES the template. Native (global) mode: the
        // plan's deterministic min-id occurrence, so all occurrences resolve
        // against ONE model-wide template across the rayon pool. WASM batch-local
        // mode: the FIRST occurrence of this source seen by this router/batch (the
        // rest don't-bake), so each per-batch shard is self-contained. Both emit
        // geometrically identical world triangles.
        let is_template = match instance_solid_id {
            None => true, // not eligible ⇒ materialize flat as usual
            Some(_) if router.instancing_batch_local() => {
                router.mark_source_materialized_if_first(source_id)
            }
            Some(_) => {
                let template_item_id = router
                    .output_instancing_plan()
                    .and_then(|plan| plan.get(&source_id))
                    .map(|&(_, t)| t)
                    .unwrap_or(level.item.id);
                level.item.id == template_item_id
            }
        };
        let inert = |sink: &mut Self| {
            sink.frames.push(Frame {
                mapping_transform,
                start: sink.sub_meshes.len(),
                source_id,
                instance_solid_id,
                is_template,
                active: false,
                _drop_scope: None,
            });
            Flow::SkipChildren
        };
        if let Some(solid_item_id) = instance_solid_id {
            if !is_template {
                // NON-template occurrence: don't-bake. Ensure the shared registry
                // holds the source geometry (meshed once model-wide) so the
                // finalize can recover geometry even in the (effectively
                // unreachable) case that the template occurrence never
                // materialized, then push the instance-only placeholder. Its
                // geometry_id is the nested SOLID's id (not the mapped-item id) so
                // emit_sub_meshes resolves the occurrence colour identically to the
                // flat/template sub-mesh.
                router.ensure_shared_mapped_source(&level.mapped_rep, source_id, decoder);
                let local_rm = mapping_transform.map(|t| router.scaled_row_major(&t));
                let mut placeholder = Mesh::new();
                placeholder.instance_meta = Some(InstanceMeta::instanceable(source_id as u128, local_rm));
                // Push directly (SubMeshCollection::add drops empty meshes; this
                // placeholder is intentionally empty — its InstanceMeta is the payload).
                self.sub_meshes.sub_meshes.push(SubMesh::new(solid_item_id, placeholder));
                return inert(self);
            }
        }
        self.frames.push(Frame {
            mapping_transform,
            // Where THIS mapped item's sub-meshes start, so the don't-bake
            // TEMPLATE occurrence can be re-tagged with the source-id rep_identity
            // after the normal materialize (see the retag in `leave_map`).
            start: self.sub_meshes.len(),
            source_id,
            instance_solid_id,
            is_template,
            active: true,
            _drop_scope: Some(router.enter_unsupported_source(source_id, &level.mapped_rep)),
        });
        Flow::Continue
    }

    fn leave_map(&mut self, _level: &MappedLevel) {
        let Some(frame) = self.frames.pop() else { return };
        if !frame.active {
            return;
        }
        let router = self.router;
        // Apply the MappedItem transform to the sub-meshes the level added.
        if let Some(transform) = frame.mapping_transform {
            let mut transform = transform;
            router.scale_transform(&mut transform);
            // The MappingTarget is a PER-OCCURRENCE transform: baked into the
            // vertices here (flat output byte-for-byte unchanged), and for
            // INSTANCING recorded in `local_transform` (keeping the canonical,
            // pre-target `rep_identity`) — mirroring the don't-bake TEMPLATE
            // re-tag below — so occurrences sharing a map but differing by
            // target collate under one template. Previously this RE-HASHED into
            // `rep_identity`, giving every target a unique id and disabling
            // instancing (GLB export #1443) for the MULTI-item class Phase 2
            // leaves flat (Tekla assemblies / MEP / metering skids). #1623
            let nontrivial_target = !transform.is_identity(1e-9);
            for sub in &mut self.sub_meshes.sub_meshes[frame.start..] {
                router.transform_mesh_local(&mut sub.mesh, &transform);
                if nontrivial_target {
                    if let Some(im) = sub.mesh.instance_meta.as_mut().filter(|im| im.instanceable) {
                        im.local_transform = Some(match im.local_transform {
                            // Nested map: outer target ∘ inner, bake order.
                            Some(inner) => {
                                mat4::from_na(&(transform * Matrix4::from_row_slice(&inner)))
                            }
                            None => mat4::from_na(&transform),
                        });
                    }
                }
            }
        }
        // #1623 Phase 2/3: this is the don't-bake TEMPLATE occurrence. It
        // materialized normally (byte-identical to a flat occurrence — a
        // single-solid source ⇒ exactly one sub-mesh). Re-tag its `rep_identity`
        // to the source id and record the (scaled) MappingTarget as
        // `local_transform`, MATCHING the instance placeholders so the finalize
        // collates them onto this template. The baked geometry is untouched — the
        // MappingTarget is already folded into both the vertices AND
        // `local_transform`, which is consistent (the template's world geometry is
        // `transform · local_transform · source`, so `m_ref` recovers the same
        // `source` the placeholders reference). See the finalize in processor/mod.rs.
        if frame.instance_solid_id.is_some() && frame.is_template {
            let local_rm = frame.mapping_transform.map(|t| router.scaled_row_major(&t));
            for sub in &mut self.sub_meshes.sub_meshes[frame.start..] {
                if let Some(im) = sub.mesh.instance_meta.as_mut() {
                    im.rep_identity = frame.source_id as u128;
                    im.local_transform = local_rm;
                }
            }
        }
    }

    fn refused(&mut self, item: &DecodedEntity, why: WalkRefusal, at: &WalkCtx<'_>) {
        // A representation without `Items` holds nothing to walk.
        if matches!(why, WalkRefusal::MissingItems) {
            return;
        }
        let error = why.into_error(item.id);
        self.level_failed(item, error, at.path.is_empty());
    }
}

#[cfg(test)]
mod shared_cap_tests {
    /// `MAX_MAPPED_ITEM_DEPTH` must be the one in `ifc_lite_core::limits`, not
    /// a private copy that happens to hold the same number today.
    ///
    /// This is not redundant with the constant being shared. Sharing removes
    /// the drift that EXISTS; it does not stop anyone reintroducing a local
    /// `const MAX_MAPPED_ITEM_DEPTH` that shadows the import. Verified by
    /// mutation: with the import replaced by a private `= 16`, 800 tests stayed
    /// green until this test existed. A mid-review revision of #2864 held
    /// exactly that value against the router's 32, so the shadow is not a
    /// hypothetical shape.
    ///
    /// The assertion is on the VALUE, not on identity, so a private copy
    /// holding the same 32 still passes. That is the honest ceiling: Rust has
    /// no cheap const-identity check, and a same-value shadow is harmless until
    /// the shared value is next tuned, at which point this fires.
    #[test]
    fn mapped_item_depth_is_the_shared_constant() {
        assert_eq!(
            super::MAX_MAPPED_ITEM_DEPTH,
            ifc_lite_core::MAX_MAPPED_ITEM_DEPTH,
            "use the shared cap from ifc_lite_core::limits, not a private copy"
        );
    }
}
