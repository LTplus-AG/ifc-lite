// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The element sub-mesh walk's mapped-item handling: a [`WalkVisitor`] over
//! `IfcMappedItem` levels (C2-3). The walk owns descent, depth and cycle
//! bounds; this sink owns what a level means to the sub-mesh output: the #1623
//! don't-bake decision, the per-source recording decision, the `MappingTarget` bake
//! over the sub-meshes the level added, and the template re-tag.

use super::item::ItemFrame;
use super::GeometryRouter;
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
            let textured = self.textured_face_set(item, decoder, map, Some(self.rtc_offset));
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
            Err(error) => self.record_unsupported_geometry(item, error),
        }
    }
}

/// What the sink remembers of one entered `IfcMappedItem` level.
struct Frame {
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
    /// Claimed once; scopes open only around an item or a drop.
    policy: bool,
}

struct SubMeshSink<'a> {
    router: &'a GeometryRouter,
    sub_meshes: &'a mut SubMeshCollection,
    allow_instancing: bool,
    texture_index: Option<&'a TextureIndex>,
    frames: Vec<Frame>,
    /// A top-level input error or a terminal stop reached at any depth.
    error: Option<Error>,
}

impl SubMeshSink<'_> {
    /// A level that could not run: a top-level level fails the element's item,
    /// a nested one is dropped and counted.
    fn level_failed(&mut self, item: &DecodedEntity, error: Error, parent_depth: usize) {
        if parent_depth == 0 {
            self.error = Some(error);
        } else {
            let policy = self.frames.get(parent_depth - 1).is_none_or(|frame| frame.policy);
            let _scope = self.router.enter_unsupported_policy(policy);
            self.router.record_unsupported_nested_geometry(item, error);
        }
    }
}

impl WalkVisitor for SubMeshSink<'_> {
    fn item(&mut self, item: &DecodedEntity, at: &WalkCtx<'_>, decoder: &mut EntityDecoder) -> Flow {
        let policy = self.frames.last().is_none_or(|frame| frame.policy);
        let _scope = self.router.enter_unsupported_policy(policy);
        // Preserve the recursive caller's nested-item drop at the depth cap.
        if at.path.len() >= MAX_MAPPED_ITEM_DEPTH as usize {
            self.router.record_unsupported_nested_geometry(item, Error::geometry(format!(
                "MappedItem nesting exceeded maximum depth of {} at #{}",
                MAX_MAPPED_ITEM_DEPTH, item.id
            )));
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
                self.level_failed(&level.item, error, at.path.len());
                self.frames.push(Frame {
                    mapping_transform: None,
                    start: self.sub_meshes.len(),
                    source_id: level.map.id,
                    instance_solid_id: None,
                    is_template: true,
                    active: false,
                    policy: false,
                });
                return if self.error.is_some() { Flow::Stop } else { Flow::SkipChildren };
            }
        };
        let source_id = level.map.id;
        // #1623: a repeated single-solid source materializes one template;
        // other top-level occurrences carry only InstanceMeta. Nested sources
        // remain part of their parent's geometry. The solid id preserves colour.
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
        // Native plans pick the min-id occurrence; WASM batches materialize
        // their first occurrence so each shard contains its own template.
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
                policy: false,
            });
            Flow::SkipChildren
        };
        if let Some(solid_item_id) = instance_solid_id {
            if !is_template {
                // Keep source geometry for orphan recovery; placeholders retain
                // the nested solid id so appearance matches the template.
                if let Err(error) = router.ensure_shared_mapped_source(&level.mapped_rep, source_id, decoder) {
                    self.error = Some(error);
                    inert(self);
                    return Flow::Stop;
                }
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
            policy: router.claim_unsupported_source(source_id, &level.mapped_rep),
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
        // Re-tag the materialized template to match its placeholders. Geometry
        // and local_transform both include the target, letting finalize recover
        // the canonical source from transform · local_transform · source (#1623).
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
        self.level_failed(item, error, at.path.len());
    }
}

#[cfg(test)]
#[path = "processing_shared_cap_tests.rs"]
mod shared_cap_tests;
