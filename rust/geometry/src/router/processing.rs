// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Core element processing: resolving representations, processing items, and caching.

use super::transforms::{instancing_enabled, mat4_to_row_major};
use super::GeometryRouter;
use crate::{Error, InstanceMeta, Mesh, Result, SubMeshCollection};

/// High tag bit distinguishing direct-solid rep_identity (a 128-bit local-mesh
/// content hash) from mapped-item rep_identity (a RepresentationMap entity id,
/// always < 2^32), so the two id spaces can never collide in `collate_instances`.
/// Bit 127 is set on direct-solid ids and clear on mapped ids; it costs one hash
/// bit (127 effective), still content-addressing grade.
const DIRECT_SOLID_TAG: u128 = 1u128 << 127;

/// Row-major 4x4 identity; placeholder `InstanceMeta::transform` before the
/// element's world placement is folded in by `apply_placement`.
const IDENTITY_ROW_MAJOR: [f64; 16] = [
    1.0, 0.0, 0.0, 0.0, //
    0.0, 1.0, 0.0, 0.0, //
    0.0, 0.0, 1.0, 0.0, //
    0.0, 0.0, 0.0, 1.0, //
];
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use rustc_hash::FxHashSet;
use std::sync::Arc;

/// Maximum nested IfcMappedItem depth we will traverse for a single geometry item.
const MAX_MAPPED_ITEM_DEPTH: usize = 32;

impl GeometryRouter {
    /// Process building element (IfcWall, IfcBeam, etc.) into mesh
    /// Follows the representation chain:
    /// Element → Representation → ShapeRepresentation → Items
    #[inline]
    pub fn process_element(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Mesh> {
        // IfcAlignment carries its directrix curve in a dedicated `Axis`
        // attribute (IFC4X1) instead of (or in addition to) a normal
        // IfcShapeRepresentation. Route those through the alignment
        // processor before the standard representation walk, since the
        // Representation is often `$` in practice.
        if element.ifc_type == IfcType::IfcAlignment {
            if let Some(mesh) = self.try_alignment_mesh(element, decoder)? {
                return Ok(mesh);
            }
        }

        // Get representation (attribute 6 for most building elements)
        // IfcProduct: GlobalId, OwnerHistory, Name, Description, ObjectType, ObjectPlacement, Representation, Tag
        let representation_attr = element.get(6).ok_or_else(|| {
            Error::geometry(format!(
                "Element #{} has no representation attribute",
                element.id
            ))
        })?;

        if representation_attr.is_null() {
            return Ok(Mesh::new()); // No geometry
        }

        let representation = decoder
            .resolve_ref(representation_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve representation".to_string()))?;

        // IfcProductDefinitionShape has Representations attribute (list of IfcRepresentation)
        if representation.ifc_type != IfcType::IfcProductDefinitionShape {
            return Err(Error::geometry(format!(
                "Expected IfcProductDefinitionShape, got {}",
                representation.ifc_type
            )));
        }

        // Get representations list (attribute 2)
        let representations_attr = representation.get(2).ok_or_else(|| {
            Error::geometry("IfcProductDefinitionShape missing Representations".to_string())
        })?;

        let representations = decoder.resolve_ref_list(representations_attr)?;

        // Process all representations and merge meshes
        let mut combined_mesh = Mesh::new();

        // Instancing: an element is cleanly shareable only when its whole body is
        // exactly ONE representation item that itself carried instance metadata
        // (a mapped item). `Mesh::merge` does not propagate the side-channel, so we
        // capture the single item's metadata here and re-attach it below; any second
        // item disqualifies the element (left as None -> rendered flat).
        let mut single_instance_meta: Option<InstanceMeta> = None;
        let mut instanceable_item_count: usize = 0;

        // First pass: check if we have any direct geometry representations
        // This prevents duplication when both direct and MappedRepresentation exist
        let has_direct_geometry = representations.iter().any(|rep| {
            rep.ifc_type == IfcType::IfcShapeRepresentation
                && super::effective_rep_type(rep)
                    .map(super::is_direct_body_representation)
                    .unwrap_or(false)
        });

        for shape_rep in representations {
            if shape_rep.ifc_type != IfcType::IfcShapeRepresentation {
                continue;
            }

            // Check the effective representation type (RepresentationType, falling
            // back to RepresentationIdentifier when the type is blank - #1661).
            // Skip 'Axis', 'Curve2D', 'FootPrint', etc. - only process 'Body', 'SweptSolid', 'Brep', etc.
            if let Some(rep_type) = super::effective_rep_type(&shape_rep) {
                // Skip MappedRepresentation if we already have direct geometry
                // This prevents duplication when an element has both direct and mapped representations
                if rep_type == "MappedRepresentation" && has_direct_geometry {
                    continue;
                }

                // Only process solid/surface geometry representations
                if !super::is_body_representation(rep_type) {
                    continue; // Skip non-solid representations like 'Axis', 'Curve2D', etc.
                }
            }

            // Get items list (attribute 3)
            let items_attr = shape_rep.get(3).ok_or_else(|| {
                Error::geometry("IfcShapeRepresentation missing Items".to_string())
            })?;

            let items = decoder.resolve_ref_list(items_attr)?;

            // Process each representation item
            for item in items {
                let mesh = self.process_representation_item(&item, decoder)?;
                if instancing_enabled() && !mesh.positions.is_empty() {
                    instanceable_item_count += 1;
                    single_instance_meta = if instanceable_item_count == 1 {
                        mesh.instance_meta.clone()
                    } else {
                        None
                    };
                }
                combined_mesh.merge(&mesh);
            }
        }

        // Re-attach single-item instance metadata so apply_placement can fold the
        // element's world placement into `transform`.
        if instancing_enabled() {
            combined_mesh.instance_meta = single_instance_meta;
        }

        // Mesh hygiene before placement (rigid transform preserves geometry, so
        // welding/dropping in local coords is identical and uses smaller f32
        // magnitudes). Single chokepoint downstream of every per-item branch,
        // incl. CSG output — restores the cleanup #1024 lost with Manifold:
        // redundant/coincident source vertices that otherwise triangulate into
        // visible needle spikes and jagged silhouettes. See clean_degenerate.
        combined_mesh.clean_degenerate();

        // Apply placement transformation
        self.apply_placement(element, decoder, &mut combined_mesh)?;

        Ok(combined_mesh)
    }

    /// Process element and return sub-meshes with their geometry item IDs.
    /// This preserves per-item identity for color/style lookup.
    ///
    /// For elements with multiple styled geometry items (like windows with frames + glass),
    /// this returns separate sub-meshes that can receive different colors.
    pub fn process_element_with_submeshes(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<SubMeshCollection> {
        // Public entry: the ordinary (non-void) element path, so the #1623 Phase 2
        // don't-bake instancing is allowed here. The void path
        // (`process_element_with_submeshes_and_voids`) calls the impl below with
        // `allow_instancing = false` — a voided occurrence must materialize its cut
        // geometry, never instance an un-cut shared template.
        self.process_element_with_submeshes_impl(element, decoder, true, None)
    }

    /// [`Self::process_element_with_submeshes`] with an explicit don't-bake gate.
    /// `allow_instancing` is `true` only on the ordinary (non-void) path; the void
    /// path passes `false` so its occurrences always materialize. The don't-bake
    /// additionally requires an armed [`GeometryRouter::enable_output_instancing`]
    /// plan, so with no plan this is byte-identical to the historical flat path.
    /// `texture_index` is `Some` only on the textured non-void path (#1781).
    pub(super) fn process_element_with_submeshes_impl(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
        allow_instancing: bool,
        texture_index: Option<
            &rustc_hash::FxHashMap<u32, crate::processors::texture::ResolvedTextureMap>,
        >,
    ) -> Result<SubMeshCollection> {
        // If a material-layer buildup is attached, try slicing single-solid
        // elements (walls / slabs with IfcMaterialLayerSetUsage) first so each
        // layer gets its own sub-mesh keyed by IfcMaterial id. An empty void
        // index is passed — the caller's has_openings branch takes the
        // voids-aware path below.
        if let Some(layered) = self.try_layered_sub_meshes(element, decoder, None) {
            return Ok(layered);
        }

        // Get representation (attribute 6 for most building elements)
        let representation_attr = element.get(6).ok_or_else(|| {
            Error::geometry(format!(
                "Element #{} has no representation attribute",
                element.id
            ))
        })?;

        if representation_attr.is_null() {
            return Ok(SubMeshCollection::new()); // No geometry
        }

        let representation = decoder
            .resolve_ref(representation_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve representation".to_string()))?;

        if representation.ifc_type != IfcType::IfcProductDefinitionShape {
            return Err(Error::geometry(format!(
                "Expected IfcProductDefinitionShape, got {}",
                representation.ifc_type
            )));
        }

        // Get representations list (attribute 2)
        let representations_attr = representation.get(2).ok_or_else(|| {
            Error::geometry("IfcProductDefinitionShape missing Representations".to_string())
        })?;

        let representations = decoder.resolve_ref_list(representations_attr)?;

        let mut sub_meshes = SubMeshCollection::new();

        // Check if we have direct geometry
        let has_direct_geometry = representations.iter().any(|rep| {
            rep.ifc_type == IfcType::IfcShapeRepresentation
                && super::effective_rep_type(rep)
                    .map(super::is_direct_body_representation)
                    .unwrap_or(false)
        });

        for shape_rep in representations {
            if shape_rep.ifc_type != IfcType::IfcShapeRepresentation {
                continue;
            }

            if let Some(rep_type) = super::effective_rep_type(&shape_rep) {
                // Skip MappedRepresentation if we have direct geometry
                if rep_type == "MappedRepresentation" && has_direct_geometry {
                    continue;
                }

                // Only process solid/surface geometry representations
                if !super::is_body_representation(rep_type) {
                    continue;
                }
            }

            // Get items list (attribute 3)
            let items_attr = shape_rep.get(3).ok_or_else(|| {
                Error::geometry("IfcShapeRepresentation missing Items".to_string())
            })?;

            let items = decoder.resolve_ref_list(items_attr)?;

            // Process each representation item, preserving geometry IDs
            for item in items {
                self.collect_submeshes_from_item(
                    &item,
                    decoder,
                    &mut sub_meshes,
                    allow_instancing,
                    texture_index,
                )?;
            }
        }

        // Mesh hygiene before placement — same chokepoint as process_element,
        // applied per sub-mesh for the multi-item (per-style) channel. Rigid
        // placement preserves geometry, so order is immaterial. (The layered
        // and textured channels are cleaned at their own sites:
        // try_layered_sub_meshes and process_representation_map_with_texture.)
        for sub in &mut sub_meshes.sub_meshes {
            sub.mesh.clean_degenerate();
        }

        self.apply_submesh_placement(&mut sub_meshes, element, decoder)?;
        Ok(sub_meshes)
    }

    /// Collect sub-meshes from a representation item, following MappedItem references.
    /// `allow_instancing` enables the #1623 Phase 2 don't-bake path at the top-level
    /// mapped item (see [`Self::collect_submeshes_from_item_inner`]).
    fn collect_submeshes_from_item(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
        sub_meshes: &mut SubMeshCollection,
        allow_instancing: bool,
        texture_index: Option<
            &rustc_hash::FxHashMap<u32, crate::processors::texture::ResolvedTextureMap>,
        >,
    ) -> Result<()> {
        let mut visited = FxHashSet::default();
        self.collect_submeshes_from_item_inner(
            item,
            decoder,
            sub_meshes,
            0,
            &mut visited,
            allow_instancing,
            texture_index,
        )
    }

    #[allow(clippy::too_many_arguments)] // internal recursion carries per-walk state
    fn collect_submeshes_from_item_inner(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
        sub_meshes: &mut SubMeshCollection,
        depth: usize,
        visited: &mut FxHashSet<u32>,
        allow_instancing: bool,
        texture_index: Option<
            &rustc_hash::FxHashMap<u32, crate::processors::texture::ResolvedTextureMap>,
        >,
    ) -> Result<()> {
        if depth >= MAX_MAPPED_ITEM_DEPTH {
            return Err(Error::geometry(format!(
                "MappedItem nesting exceeded maximum depth of {} at #{}",
                MAX_MAPPED_ITEM_DEPTH, item.id
            )));
        }

        // For MappedItem, recurse into the mapped representation
        if item.ifc_type == IfcType::IfcMappedItem {
            if !visited.insert(item.id) {
                return Err(Error::geometry(format!(
                    "Detected cyclic IfcMappedItem reference at #{}",
                    item.id
                )));
            }

            // Get MappingSource (RepresentationMap)
            let source_attr = item
                .get(0)
                .ok_or_else(|| Error::geometry("MappedItem missing MappingSource".to_string()))?;

            let source_entity = decoder
                .resolve_ref(source_attr)?
                .ok_or_else(|| Error::geometry("Failed to resolve MappingSource".to_string()))?;
            let source_id = source_entity.id;

            // Get MappedRepresentation from RepresentationMap (attribute 1)
            let mapped_repr_attr = source_entity.get(1).ok_or_else(|| {
                Error::geometry("RepresentationMap missing MappedRepresentation".to_string())
            })?;

            let mapped_repr = decoder.resolve_ref(mapped_repr_attr)?.ok_or_else(|| {
                Error::geometry("Failed to resolve MappedRepresentation".to_string())
            })?;

            // Get MappingTarget transformation
            let mapping_transform = if let Some(target_attr) = item.get(1) {
                if !target_attr.is_null() {
                    if let Some(target_entity) = decoder.resolve_ref(target_attr)? {
                        Some(self.parse_cartesian_transformation_operator(&target_entity, decoder)?)
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            };

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
            // Only fires at the TOP level (`depth == 0`) — a mapped item nested inside
            // another map is part of its parent's shared geometry, not an independent
            // occurrence — and only when `allow_instancing` (the non-void path). With
            // no armed plan this is skipped entirely, so the flat output is unchanged.
            let instance_solid_id: Option<u32> = if allow_instancing && depth == 0 {
                self.output_instancing_plan()
                    .and_then(|plan| plan.get(&source_id).copied())
                    .filter(|&(count, _)| count >= 2)
                    .and_then(|_| {
                        self.mapped_source_single_item(&mapped_repr, decoder)
                            // #858: a source whose single solid carries an
                            // IfcIndexedColourMap must materialize flat so
                            // emit_sub_meshes can split it into one mesh per palette
                            // group. An instance placeholder resolves ONE colour,
                            // collapsing the palette (WRONG vs the flat path); route
                            // to flat instead (byte-identical to instancing-off).
                            .filter(|&item_id| !self.is_indexed_colour_split_source(item_id))
                            // #1781: same rule for a TEXTURED single solid — an
                            // instance placeholder carries no UVs/texture, so the
                            // occurrence would render untextured. Materialize flat.
                            .filter(|&item_id| {
                                texture_index.is_none_or(|ti| !ti.contains_key(&item_id))
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
                Some(_) if self.instancing_batch_local() => {
                    self.mark_source_materialized_if_first(source_id)
                }
                Some(_) => {
                    let template_item_id = self
                        .output_instancing_plan()
                        .and_then(|plan| plan.get(&source_id))
                        .map(|&(_, t)| t)
                        .unwrap_or(item.id);
                    item.id == template_item_id
                }
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
                    self.ensure_shared_mapped_source(&mapped_repr, source_id, decoder);
                    let local_rm = mapping_transform.map(|mut t| {
                        self.scale_transform(&mut t);
                        mat4_to_row_major(&t)
                    });
                    let mut placeholder = Mesh::new();
                    placeholder.instance_meta = Some(InstanceMeta {
                        transform: IDENTITY_ROW_MAJOR,
                        local_transform: local_rm,
                        canonical_transform: None,
                        rep_identity: source_id as u128,
                        instanceable: true,
                    });
                    // Push directly (SubMeshCollection::add drops empty meshes; this
                    // placeholder is intentionally empty — its InstanceMeta is the payload).
                    sub_meshes
                        .sub_meshes
                        .push(crate::SubMesh::new(solid_item_id, placeholder));
                    visited.remove(&item.id);
                    return Ok(());
                }
            }
            // Record where THIS mapped item's sub-meshes start, so the don't-bake
            // TEMPLATE occurrence can be re-tagged with the source-id rep_identity
            // after the normal materialize below (see the retag after the loop).
            let mapped_items_start = sub_meshes.len();

            // Get items from the mapped representation
            if let Some(items_attr) = mapped_repr.get(3) {
                let items = decoder.resolve_ref_list(items_attr)?;
                for nested_item in items {
                    // Recursively collect sub-meshes (skip unsupported geometry types).
                    // Nested items never independently don't-bake (`allow_instancing =
                    // false`): they are this occurrence's own shared geometry.
                    let count_before = sub_meshes.len();
                    if let Err(_e) = self.collect_submeshes_from_item_inner(
                        &nested_item,
                        decoder,
                        sub_meshes,
                        depth + 1,
                        visited,
                        false,
                        texture_index,
                    ) {
                        crate::diag::diag_debug!(
                            { item_id = nested_item.id, ifc_type = ?nested_item.ifc_type,
                              error = %_e, "skipping unsupported nested geometry item" }
                            else {
                                #[cfg(debug_assertions)]
                                eprintln!(
                                    "[ifc-lite] Skipping unsupported nested geometry #{} ({:?}): {}",
                                    nested_item.id, nested_item.ifc_type, _e
                                );
                            }
                        );
                        continue;
                    }

                    // Apply MappedItem transform to newly added sub-meshes.
                    if let Some(mut transform) = mapping_transform {
                        self.scale_transform(&mut transform);
                        // The MappingTarget is a PER-OCCURRENCE transform: baked into the
                        // vertices here (flat output byte-for-byte unchanged), and for
                        // INSTANCING recorded in `local_transform` (keeping the canonical,
                        // pre-target `rep_identity`) — mirroring `process_mapped_item_cached`
                        // and the don't-bake TEMPLATE re-tag below — so occurrences sharing a
                        // map but differing by target collate under one template. Previously
                        // this RE-HASHED into `rep_identity`, giving every target a unique id
                        // and disabling instancing (GLB export #1443) for the MULTI-item class
                        // Phase 2 leaves flat (Tekla assemblies / MEP / metering skids). #1623
                        let nontrivial_target = !transform.is_identity(1e-9);
                        for sub in &mut sub_meshes.sub_meshes[count_before..] {
                            self.transform_mesh_local(&mut sub.mesh, &transform);
                            if nontrivial_target {
                                if let Some(im) =
                                    sub.mesh.instance_meta.as_mut().filter(|im| im.instanceable)
                                {
                                    im.local_transform = Some(match im.local_transform {
                                        // Nested map: outer target ∘ inner, bake order.
                                        Some(inner) => mat4_to_row_major(
                                            &(transform * nalgebra::Matrix4::from_row_slice(&inner)),
                                        ),
                                        None => mat4_to_row_major(&transform),
                                    });
                                }
                            }
                        }
                    }
                }
            }

            // #1623 Phase 2/3: this is the don't-bake TEMPLATE occurrence. It
            // materialized normally above (byte-identical to a flat occurrence — a
            // single-solid source ⇒ exactly one sub-mesh). Re-tag its `rep_identity`
            // to the source id and record the (scaled) MappingTarget as
            // `local_transform`, MATCHING the instance placeholders so the finalize
            // collates them onto this template. The baked geometry is untouched — the
            // MappingTarget is already folded into both the vertices AND
            // `local_transform`, which is consistent (the template's world geometry is
            // `transform · local_transform · source`, so `m_ref` recovers the same
            // `source` the placeholders reference). See the finalize in processor/mod.rs.
            if instance_solid_id.is_some() && is_template {
                let local_rm = mapping_transform.map(|mut t| {
                    self.scale_transform(&mut t);
                    mat4_to_row_major(&t)
                });
                for sub in &mut sub_meshes.sub_meshes[mapped_items_start..] {
                    if let Some(im) = sub.mesh.instance_meta.as_mut() {
                        im.rep_identity = source_id as u128;
                        im.local_transform = local_rm;
                    }
                }
            }

            visited.remove(&item.id);
        } else {
            // Textured tessellated face set (#1781): mesh with per-vertex UVs so
            // the occurrence path renders its image like the type-geometry path
            // (#961) always did. Bypasses the content-dedup cache — the cached
            // mesh has no UV channel, and UVs are per-face-set anyway. Falls
            // through to the plain path if the textured build fails.
            if item.ifc_type == IfcType::IfcTriangulatedFaceSet {
                if let Some(map) = texture_index.and_then(|ti| ti.get(&item.id)) {
                    let proc = crate::processors::TriangulatedFaceSetProcessor::new();
                    if let Ok((mut mesh, uvs)) = proc.process_with_texture(item, decoder, map) {
                        if !mesh.is_empty() {
                            self.scale_mesh(&mut mesh); // UVs are unaffected by scale
                            sub_meshes.add_textured(item.id, mesh, uvs, map.attachment());
                            return Ok(());
                        }
                    }
                }
            }
            // Regular geometry item - process and record with its ID
            // Skip unsupported geometry types (e.g. IfcGeometricSet) instead of failing
            match self.process_representation_item(item, decoder) {
                Ok(mesh) => {
                    if !mesh.is_empty() {
                        sub_meshes.add(item.id, mesh);
                    }
                }
                Err(_e) => {
                    crate::diag::diag_debug!(
                        { item_id = item.id, ifc_type = ?item.ifc_type, error = %_e,
                          "skipping unsupported geometry item" }
                        else {
                            #[cfg(debug_assertions)]
                            eprintln!(
                                "[ifc-lite] Skipping unsupported geometry #{} ({:?}): {}",
                                item.id, item.ifc_type, _e
                            );
                        }
                    );
                }
            }
        }

        Ok(())
    }

    /// Process a single representation item (IfcExtrudedAreaSolid, etc.), with
    /// content-dedup: a 128-bit structural hash of the item subtree skips the
    /// meshing + CSG for geometry byte-identical to an item meshed earlier (e.g.
    /// the thousands of Tekla connection plates/bolts an exporter failed to share
    /// via `IfcMappedItem`). The cached mesh is colour-free and pre-placement; the
    /// caller keeps this item's own `geometry_id` (so colour/palette/texture stay
    /// per-instance) and applies voids + placement afterwards, so a cache hit is
    /// indistinguishable from a fresh build.
    #[inline]
    pub fn process_representation_item(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Mesh> {
        // MappedItem has its own instancing cache (the source representation is
        // already shared), so it never enters the structural-hash path. It also
        // sets its own instance_meta, so the direct-solid tagging below is skipped.
        if item.ifc_type == IfcType::IfcMappedItem {
            return self.process_mapped_item_cached(item, decoder);
        }

        // `None` ⇒ dedup disabled (no hash overhead). On a hit, clone the cached
        // item mesh and stamp its STORED rep_identity (no per-occurrence re-hash);
        // meshing is skipped entirely.
        let dedup_key = self.item_dedup_key(item, decoder);
        if let (Some(key), Some(cache)) = (dedup_key, self.item_dedup_cache.as_ref()) {
            let hit = cache
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&key)
                .cloned();
            if let Some(entry) = hit {
                let (mesh, rep) = (entry.0.clone(), entry.1);
                return Ok(self.stamp_direct_instance(mesh, rep));
            }
        }

        let mesh = self.process_representation_item_uncached(item, decoder)?;
        // Compute the instancing rep_identity ONCE for this unique shape so cache
        // hits can reuse it instead of re-hashing the full mesh per occurrence.
        let rep = self.direct_rep_identity(&mesh);

        // Cache the freshly-meshed item under its structural hash. Two exclusions:
        //  - empty meshes (unsupported/degenerate geometry);
        //  - results produced once the per-element CSG budget has tripped. On a
        //    trip the boolean bails and `subtract_mesh` returns the UNCUT host
        //    (records `OperandTooLarge`); since the dedup key is budget-independent
        //    (structure/quality/scale/RTC), caching that fallback would serve the
        //    wrong (uncut) mesh to later identical booleans in a fresh-budget
        //    element (`budget::begin_element()` resets per element). Correctness of
        //    the cut wins over deduping a degraded result. (#1257 review P1.)
        if let (Some(key), Some(cache)) = (dedup_key, self.item_dedup_cache.as_ref()) {
            if !mesh.positions.is_empty() && !crate::kernel::budget::tripped() {
                // Clone into the Arc BEFORE locking: a mesh deep-copy inside the
                // single-Mutex critical section serializes the pool on every miss.
                let cached = Arc::new((mesh.clone(), rep));
                cache
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(key, cached);
            }
        }

        Ok(self.stamp_direct_instance(mesh, rep))
    }

    /// Compute the direct-solid instancing `rep_identity` for a freshly-built,
    /// pre-placement item mesh, or `None` when instancing is off / the mesh is
    /// empty / it already carries metadata (mapped items). FULL 128-bit
    /// (non-sampling) hash: rep_identity has no downstream meshes_equal guard at
    /// the source and must be cross-worker consistent, so a sampled-hash collision
    /// (#833 family) would silently group non-identical geometry; 128-bit makes
    /// that ~2^-127. Computed ONCE per unique shape — cache hits reuse the stored
    /// value via [`Self::stamp_direct_instance`] instead of re-hashing.
    fn direct_rep_identity(&self, mesh: &Mesh) -> Option<u128> {
        if instancing_enabled() && mesh.instance_meta.is_none() && !mesh.positions.is_empty() {
            Some(Self::compute_mesh_hash_full(mesh) | DIRECT_SOLID_TAG)
        } else {
            None
        }
    }

    /// Stamp a direct-solid item mesh with a KNOWN `rep_identity` (no re-hash) so
    /// identical representations collate into a single template + per-occurrence
    /// transforms. `rep` comes from [`Self::direct_rep_identity`] on a fresh build
    /// or from the dedup cache on a hit; `None` is a no-op (instancing off / empty
    /// / already tagged).
    fn stamp_direct_instance(&self, mut mesh: Mesh, rep: Option<u128>) -> Mesh {
        if let Some(exact_rep) = rep {
            mesh.instance_meta = Some(InstanceMeta {
                transform: IDENTITY_ROW_MAJOR,
                local_transform: None,
                canonical_transform: None,
                rep_identity: exact_rep,
                instanceable: true,
            });
        }
        mesh
    }

    /// Cache key for an item: its structural hash combined with the router params
    /// that change the meshed output (tessellation quality / unit scale / RTC), or
    /// `None` when dedup is disabled (skips the hash walk so disabled = zero
    /// overhead). The quality fold is what keeps `setTessellationQuality` correct —
    /// the shared cache persists across quality changes on a worker, so the key
    /// must distinguish them (#976).
    fn item_dedup_key(&self, item: &DecodedEntity, decoder: &mut EntityDecoder) -> Option<u128> {
        self.item_dedup_cache.as_ref()?;
        // Dedup the geometry types whose repeated instances dominate real models:
        // IfcFacetedBrep (tessellated steel) AND the procedural boolean/extrusion
        // hot path (clipped beams/columns — IfcBooleanResult /
        // IfcBooleanClippingResult / IfcExtrudedAreaSolid). #1177 had restricted
        // this to IfcFacetedBrep because the structural hash re-decoded the subtree
        // per item; it is now memoized (`content_sig_memo`), so shared subtrees
        // (the same cutter/profile referenced by hundreds of parts) are hashed once
        // and the dedup is a measured net win, byte-identical: a 20 MB boolean-clip
        // steel model (170_KM) drops geometry 16.4 s → 2.8 s (5.8×), and procedural
        // arch models improve too (advanced_model 3.1×, ISSUE_068 1.7×) with no
        // regression on the tested corpus. The IfcMappedItem instancing cache is a
        // separate path, always on.
        let base = matches!(
            item.ifc_type,
            IfcType::IfcFacetedBrep
                | IfcType::IfcBooleanResult
                | IfcType::IfcBooleanClippingResult
                | IfcType::IfcExtrudedAreaSolid
        );
        // Additive, flagged OFF by default: faceset / surface-model families. Their
        // generic byte signature (`sig_walk_bytes`) is already complete; gated so a
        // low-reuse model never pays the hash for no payback (the #1177 trap).
        let extra = Self::build_dedup_extra_enabled()
            && matches!(
                item.ifc_type,
                IfcType::IfcPolygonalFaceSet
                    | IfcType::IfcTriangulatedFaceSet
                    | IfcType::IfcShellBasedSurfaceModel
                    | IfcType::IfcFaceBasedSurfaceModel
            );
        if !(base || extra) {
            return None;
        }
        let structural = {
            let mut memo = self.content_sig_memo.borrow_mut();
            super::content_hash::item_signature(decoder, item.id, &mut memo)
        };
        Some(super::content_hash::key_with_params(
            structural,
            self.tessellation_quality.to_index(),
            self.unit_scale,
            self.rtc_offset,
        ))
    }

    /// The meshing body of [`Self::process_representation_item`] (everything except
    /// the MappedItem path and the content-dedup wrapper).
    fn process_representation_item_uncached(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Mesh> {
        // For raw world-coordinate FacetedBrep with RTC: subtract RTC from f64
        // coordinates BEFORE f32 conversion. Do not use this path for ordinary
        // local Breps whose large position comes from IfcObjectPlacement; those
        // are shifted uniformly during the final world transform.
        if item.ifc_type == IfcType::IfcFacetedBrep
            && self.has_rtc_offset()
            && self.representation_item_uses_raw_large_coordinates(item, decoder)
        {
            let processor = crate::processors::FacetedBrepProcessor::new();
            let rtc_file_units = (
                self.rtc_offset.0 / self.unit_scale,
                self.rtc_offset.1 / self.unit_scale,
                self.rtc_offset.2 / self.unit_scale,
            );
            let mut mesh =
                processor.process_with_rtc(item, decoder, &self.schema, rtc_file_units)?;
            mesh.validate_indices();
            self.scale_mesh(&mut mesh);
            // Mark positions as already RTC-shifted by setting a flag
            // (positions are small values near origin, not world-space)
            if !mesh.positions.is_empty() {
                let cached = self.get_or_cache_by_hash(mesh);
                return Ok((*cached).clone());
            }
            return Ok(mesh);
        }

        // Check if we have a processor for this type
        if let Some(processor) = self.processors.get(&item.ifc_type) {
            let mut mesh =
                processor.process(item, decoder, &self.schema, self.tessellation_quality)?;
            // Safety net: strip any out-of-bounds indices before downstream use
            mesh.validate_indices();

            // For raw world-coordinate meshes: apply RTC before unit scaling
            // to avoid jitter from f32 truncation at world-space scale.
            // This covers FaceBasedSurface, ShellBasedSurface, and any other
            // processor that stores raw world-space coordinates as f32.
            if self.has_rtc_offset()
                && !mesh.rtc_applied
                && !mesh.positions.is_empty()
                && self.representation_item_uses_raw_large_coordinates(item, decoder)
            {
                // Positions are in file units (pre-scale). RTC offset is in meters.
                // Convert RTC to file units for consistent subtraction.
                let rtc_fu = (
                    self.rtc_offset.0 / self.unit_scale,
                    self.rtc_offset.1 / self.unit_scale,
                    self.rtc_offset.2 / self.unit_scale,
                );
                for chunk in mesh.positions.chunks_exact_mut(3) {
                    chunk[0] = (chunk[0] as f64 - rtc_fu.0) as f32;
                    chunk[1] = (chunk[1] as f64 - rtc_fu.1) as f32;
                    chunk[2] = (chunk[2] as f64 - rtc_fu.2) as f32;
                }
                mesh.rtc_applied = true;
            }

            self.scale_mesh(&mut mesh);

            // Deduplicate by hash - buildings with repeated floors have identical geometry
            if !mesh.positions.is_empty() {
                let cached = self.get_or_cache_by_hash(mesh);
                return Ok((*cached).clone());
            }
            return Ok(mesh);
        }

        // No processor is registered for this type. Every `GeometryCategory`
        // that has a real implementation (SweptSolid, ExplicitMesh, Boolean) is
        // already caught by the processor lookup above; `MappedItem` never
        // reaches here (`process_representation_item` intercepts it first, see
        // `process_mapped_item_cached`). So landing here means the type is
        // genuinely unsupported, not merely "not implemented yet".
        Err(Error::geometry(format!(
            "Unsupported representation type: {}",
            item.ifc_type
        )))
    }

    /// Process MappedItem with caching for repeated geometry
    #[inline]
    pub(super) fn process_mapped_item_cached(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Mesh> {
        // IfcMappedItem attributes:
        // 0: MappingSource (IfcRepresentationMap)
        // 1: MappingTarget (IfcCartesianTransformationOperator)

        // Get mapping source (RepresentationMap)
        let source_attr = item
            .get(0)
            .ok_or_else(|| Error::geometry("MappedItem missing MappingSource".to_string()))?;

        let source_entity = decoder
            .resolve_ref(source_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve MappingSource".to_string()))?;

        let source_id = source_entity.id;

        // Get MappingTarget transformation (attribute 1: CartesianTransformationOperator)
        let mapping_transform = if let Some(target_attr) = item.get(1) {
            if !target_attr.is_null() {
                if let Some(target_entity) = decoder.resolve_ref(target_attr)? {
                    Some(self.parse_cartesian_transformation_operator(&target_entity, decoder)?)
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };

        // Check cache first. The model-wide shared cache (#1623) takes precedence
        // over the per-router RefCell fallback so a source shared across owning
        // elements is meshed once model-wide (a fresh router — hence a fresh
        // RefCell — is built per element). Only a brief get/clone runs under the
        // shared lock; the source build below (which nests faceted-brep's rayon
        // `par_iter`) runs OUTSIDE any lock, so a lock is never held across a nested
        // join (the #1587 deadlock class).
        let cached_source: Option<Arc<Mesh>> = match &self.shared_mapped_item_cache {
            Some(shared) => shared
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&source_id)
                .cloned(),
            None => self.mapped_item_cache.borrow().get(&source_id).cloned(),
        };
        if let Some(cached_mesh) = cached_source {
            let mut mesh = cached_mesh.as_ref().clone();
            let mut local_rm = None;
            if let Some(mut transform) = mapping_transform {
                self.scale_transform(&mut transform);
                if instancing_enabled() {
                    local_rm = Some(mat4_to_row_major(&transform));
                }
                self.transform_mesh_local(&mut mesh, &transform);
            }
            // Instancing: all occurrences of this RepresentationMap share the
            // cached source-coords geometry; `local_transform` is the mapping
            // (canonical -> element-local), `transform` is filled later by the
            // element's apply_placement (element-local -> world).
            if instancing_enabled() {
                mesh.instance_meta = Some(InstanceMeta {
                    transform: IDENTITY_ROW_MAJOR,
                    local_transform: local_rm,
                    canonical_transform: None,
                    rep_identity: source_id as u128,
                    instanceable: true,
                });
            }
            return Ok(mesh);
        }

        // Cache miss - process the geometry
        // IfcRepresentationMap has:
        // 0: MappingOrigin (IfcAxis2Placement)
        // 1: MappedRepresentation (IfcRepresentation)

        let mapped_rep_attr = source_entity.get(1).ok_or_else(|| {
            Error::geometry("RepresentationMap missing MappedRepresentation".to_string())
        })?;

        let mapped_rep = decoder
            .resolve_ref(mapped_rep_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve MappedRepresentation".to_string()))?;

        // Get representation items
        let items_attr = mapped_rep
            .get(3)
            .ok_or_else(|| Error::geometry("Representation missing Items".to_string()))?;

        let items = decoder.resolve_ref_list(items_attr)?;

        // Process all items and merge
        // Skip nested MappedItems AND IfcBooleanClippingResult that reference MappedItems
        // to prevent stack overflow from deeply nested recursive geometry
        let mut mesh = Mesh::new();
        for sub_item in items {
            if sub_item.ifc_type == IfcType::IfcMappedItem {
                continue;
            }
            if let Some(processor) = self.processors.get(&sub_item.ifc_type) {
                if let Ok(mut sub_mesh) =
                    processor.process(&sub_item, decoder, &self.schema, self.tessellation_quality)
                {
                    sub_mesh.validate_indices();
                    self.scale_mesh(&mut sub_mesh);
                    mesh.merge(&sub_mesh);
                }
            }
        }

        // Store in cache (before transformation, so cached mesh is in source
        // coordinates). Shared model-wide cache first (#1623), else the per-router
        // RefCell. A concurrent miss on the same source by another router rebuilds
        // an identical source-coords mesh, so an overwrite here is byte-identical.
        // Brief lock only — the source build above ran outside it (no join held).
        let source_arc = Arc::new(mesh.clone());
        match &self.shared_mapped_item_cache {
            Some(shared) => {
                // Mirror the item-dedup #1257 guard: a mapped source can contain
                // IfcBooleanResult/IfcCsgSolid, and on a per-element CSG-budget trip
                // the boolean bails and returns the UNCUT host. Caching that degraded
                // source MODEL-WIDE would serve the wrong (uncut) mesh to a later
                // occurrence in a fresh-budget element that would otherwise get the
                // full exact cut. Skip the shared insert on a trip (or empty mesh) —
                // the next occurrence re-meshes and a clean element caches it. The
                // RefCell fallback arm below stays UNGUARDED: it is per-element
                // (consistent budget within the element), reproducing main exactly.
                if !mesh.positions.is_empty() && !crate::kernel::budget::tripped() {
                    shared
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .insert(source_id, source_arc);
                }
            }
            None => {
                self.mapped_item_cache.borrow_mut().insert(source_id, source_arc);
            }
        }

        // Apply MappingTarget transformation to this instance
        let mut local_rm = None;
        if let Some(mut transform) = mapping_transform {
            self.scale_transform(&mut transform);
            if instancing_enabled() {
                local_rm = Some(mat4_to_row_major(&transform));
            }
            self.transform_mesh_local(&mut mesh, &transform);
        }
        if instancing_enabled() {
            mesh.instance_meta = Some(InstanceMeta {
                transform: IDENTITY_ROW_MAJOR,
                local_transform: local_rm,
                        canonical_transform: None,
                rep_identity: source_id as u128,
                instanceable: true,
            });
        }

        Ok(mesh)
    }

    /// Run an `IfcAlignment` through the dedicated alignment processor, then
    /// apply the standard unit scale + placement transform. Returns `None`
    /// when the alignment has no recognisable directrix curve (the caller
    /// falls back to normal representation processing).
    fn try_alignment_mesh(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Option<Mesh>> {
        let processor = match self.processors.get(&IfcType::IfcAlignment) {
            Some(p) => Arc::clone(p),
            None => return Ok(None),
        };
        let mut mesh =
            match processor.process(element, decoder, &self.schema, self.tessellation_quality) {
            Ok(m) => m,
            // Missing Axis or unparseable curve isn't fatal — fall back so
            // the caller can still walk a normal representation if present.
            Err(_) => return Ok(None),
        };
        if mesh.positions.is_empty() {
            return Ok(None);
        }
        mesh.validate_indices();
        self.scale_mesh(&mut mesh);
        self.apply_placement(element, decoder, &mut mesh)?;
        Ok(Some(mesh))
    }
}
