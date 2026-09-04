// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The router's surface-texture channel (#961, #1781): texture-aware
//! representation-map tessellation (orphan type geometry) and the textured
//! occurrence sub-mesh entry point. Split from `processing.rs` so the main
//! element pipeline stays within the module-size house rule; the texture
//! index itself is built in `crate::processors::texture`.

use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

use super::GeometryRouter;
use crate::{Error, Mesh, Result, SubMeshCollection};

impl GeometryRouter {
    /// Texture-aware [`Self::process_element_with_submeshes`] (#1781): a face
    /// set listed in `texture_index` becomes its own textured sub-mesh carrying
    /// per-vertex UVs + the texture attachment. The void path never passes an
    /// index — a CSG cut rebuilds vertices, which would orphan the UVs, so a
    /// voided textured element renders with its style colour instead.
    pub fn process_element_with_submeshes_textured(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
        texture_index: &rustc_hash::FxHashMap<u32, crate::processors::texture::ResolvedTextureMap>,
    ) -> Result<SubMeshCollection> {
        let textures = if texture_index.is_empty() {
            None
        } else {
            Some(texture_index)
        };
        self.process_element_with_submeshes_impl(element, decoder, true, textures)
    }

    /// Tessellate an `IfcRepresentationMap`'s `MappedRepresentation` and bake
    /// its `MappingOrigin` placement (issue #957).
    ///
    /// Used to render geometry that hangs off an `IfcTypeProduct` (e.g.
    /// `IfcBoilerType`) through its `RepresentationMaps` when no occurrence
    /// instantiates it — the buildingSMART annex-E "tessellated shape with
    /// style" samples ship exactly this shape (geometry on the type, declared
    /// via `IfcRelDeclares`, with no product instance).
    ///
    /// Unlike [`Self::process_mapped_item_cached`], this applies `MappingOrigin`
    /// (`IfcRepresentationMap` attr 0) rather than a `MappingTarget`: there is
    /// no occurrence placement and no `IfcMappedItem` to carry one, so the
    /// MappingOrigin axis placement is the only transform. It is the caller's
    /// responsibility to only invoke this for orphan representation maps so
    /// normally-instanced typed products aren't double-rendered.
    pub fn process_representation_map(
        &self,
        rep_map: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Mesh> {
        let empty = rustc_hash::FxHashMap::default();
        let parts = self.process_representation_map_with_texture(rep_map, decoder, &empty)?;
        let mut mesh = Mesh::new();
        for (part, _uvs, _texture) in parts {
            mesh.merge(&part);
        }
        Ok(mesh)
    }

    /// Texture-aware variant of [`Self::process_representation_map`] (issue
    /// #961). Returns one render part per output mesh: each textured
    /// `IfcTriangulatedFaceSet` item becomes its OWN part carrying its UVs +
    /// decoded image (so a representation with several differently-textured
    /// items renders each with the correct image), and all untextured items are
    /// merged into a single part with empty UVs / no texture. The MappingOrigin
    /// placement is baked into every part.
    pub fn process_representation_map_with_texture(
        &self,
        rep_map: &DecodedEntity,
        decoder: &mut EntityDecoder,
        texture_index: &rustc_hash::FxHashMap<u32, crate::processors::texture::ResolvedTextureMap>,
    ) -> Result<
        Vec<(
            Mesh,
            Vec<f32>,
            Option<crate::processors::texture::TextureAttachment>,
        )>,
    > {
        // attr 1: MappedRepresentation (IfcShapeRepresentation)
        let mapped_rep_attr = rep_map.get(1).ok_or_else(|| {
            Error::geometry("RepresentationMap missing MappedRepresentation".to_string())
        })?;
        let mapped_rep = decoder
            .resolve_ref(mapped_rep_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve MappedRepresentation".to_string()))?;

        // attr 3: Items
        let items_attr = mapped_rep
            .get(3)
            .ok_or_else(|| Error::geometry("Representation missing Items".to_string()))?;
        let items = decoder.resolve_ref_list(items_attr)?;

        // Whether a dropped item here is a real content gap, or just this router
        // declining to mesh a 2D representation it was never meant to mesh.
        //
        // The occurrence path filters representations with `is_body_representation`
        // before it ever reaches an item (`processing.rs`, "Skip 'Axis', 'Curve2D',
        // 'FootPrint'"). The TYPE path does not: `plan_type_geometry` selects
        // RepresentationMaps by reference/instantiation only and never looks at the
        // identifier, so a Revit/ArchiCAD `IfcDoorType` carrying a 'FootPrint' or
        // 'Annotation' map hands us `IfcGeometricCurveSet` / `IfcPolyline` /
        // `IfcAnnotationFillArea` — none of which have a processor, all of which are
        // CORRECTLY absent from a 3D view. Counting those made a clean model warn
        // "N representation items dropped ... elements are missing or incomplete",
        // which is exactly the false positive that would teach users to ignore it.
        //
        // Only the counting is gated, not the walk: a non-body map still runs
        // through the loop (merging nothing) so geometry output is byte-identical.
        // The scope also makes the count per SOURCE rather than per call — this
        // map may already have been walked through `mapped_item.rs` — see
        // `GeometryRouter::enter_unsupported_source`.
        let _drop_scope = self.enter_unsupported_source(rep_map.id, &mapped_rep);

        let mut untextured = Mesh::new();
        // One entry per textured item — keeps each item with its own image.
        let mut textured: Vec<(
            Mesh,
            Vec<f32>,
            crate::processors::texture::TextureAttachment,
        )> = Vec::new();
        for item in items {
            // A nested IfcMappedItem inside a type's own representation: process
            // it (applies its MappingTarget) rather than dropping its geometry.
            if item.ifc_type == IfcType::IfcMappedItem {
                match self.process_mapped_item_cached(&item, decoder) {
                    Ok(sub_mesh) => untextured.merge(&sub_mesh), // already scaled inside the cached path
                    Err(_e) => {
                        self.record_unsupported_item(item.ifc_type);
                        crate::diag::diag_debug!(
                            { item_id = item.id, error = %_e,
                              "skipping unsupported nested IfcMappedItem in representation map" }
                            else {
                                #[cfg(debug_assertions)]
                                eprintln!(
                                    "[ifc-lite] Skipping unsupported nested IfcMappedItem #{} in representation map: {}",
                                    item.id, _e
                                );
                            }
                        );
                    }
                }
                continue;
            }

            // Textured tessellated face set → its own part with per-vertex UVs (#961).
            if item.ifc_type == IfcType::IfcTriangulatedFaceSet {
                if let Some(map) = texture_index.get(&item.id) {
                    let proc = crate::processors::TriangulatedFaceSetProcessor::new();
                    if let Ok((mut sub_mesh, sub_uvs)) =
                        proc.process_with_texture(&item, decoder, map)
                    {
                        self.scale_mesh(&mut sub_mesh); // UVs are unaffected by scale
                        textured.push((sub_mesh, sub_uvs, map.attachment()));
                        continue;
                    }
                }
            }

            match self.processors.get(&item.ifc_type) {
                Some(processor) => match processor.process(
                    &item,
                    decoder,
                    &self.schema,
                    self.tessellation_quality,
                ) {
                    Ok(mut sub_mesh) => {
                        sub_mesh.validate_indices();
                        self.scale_mesh(&mut sub_mesh);
                        untextured.merge(&sub_mesh);
                    }
                    Err(_e) => {
                        self.record_unsupported_item(item.ifc_type);
                        crate::diag::diag_debug!(
                            { item_id = item.id, ifc_type = ?item.ifc_type,
                              error = %_e, "skipping unsupported representation-map item" }
                            else {
                                #[cfg(debug_assertions)]
                                eprintln!(
                                    "[ifc-lite] Skipping unsupported representation-map item #{} ({:?}): {}",
                                    item.id, item.ifc_type, _e
                                );
                            }
                        );
                    }
                },
                None => {
                    self.record_unsupported_item(item.ifc_type);
                    crate::diag::diag_debug!(
                        { item_id = item.id, ifc_type = ?item.ifc_type,
                          "skipping unsupported representation-map item (no processor)" }
                        else {
                            #[cfg(debug_assertions)]
                            eprintln!(
                                "[ifc-lite] Skipping unsupported representation-map item #{} ({:?}): no processor",
                                item.id, item.ifc_type
                            );
                        }
                    );
                }
            }
        }

        // attr 0: MappingOrigin (IfcAxis2Placement3D) — the only 3D transform;
        // UVs are 2D and unaffected. Parse once, bake into every part.
        let origin_transform: Option<nalgebra::Matrix4<f64>> = match rep_map.get(0) {
            Some(origin_attr) if !origin_attr.is_null() => {
                match decoder.resolve_ref(origin_attr)? {
                Some(origin) if origin.ifc_type == IfcType::IfcAxis2Placement3D => {
                    let mut t = self.parse_axis2_placement_3d(&origin, decoder)?;
                    self.scale_transform(&mut t);
                    Some(t)
                }
                _ => None,
                }
            }
            _ => None,
        };

        let mut out: Vec<(
            Mesh,
            Vec<f32>,
            Option<crate::processors::texture::TextureAttachment>,
        )> = Vec::new();
        for (mut mesh, uvs, texture) in textured {
            if let Some(t) = &origin_transform {
                self.transform_mesh_local(&mut mesh, t);
            }
            // Same sliver hygiene as the other mesh-output chokepoints. This is
            // the type-geometry (RepresentationMap) channel and the only one
            // carrying a parallel per-vertex UV array; clean_degenerate edits
            // only indices (vertices/UVs untouched), so the UVs stay in sync.
            mesh.clean_degenerate();
            out.push((mesh, uvs, Some(texture)));
        }
        if !untextured.is_empty() {
            if let Some(t) = &origin_transform {
                self.transform_mesh_local(&mut untextured, t);
            }
            untextured.clean_degenerate();
            out.push((untextured, Vec::new(), None));
        }

        Ok(out)
    }
}
