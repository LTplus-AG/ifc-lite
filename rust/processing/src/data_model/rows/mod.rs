// SPDX-License-Identifier: MPL-2.0
//! (Moved from `rust/export/src/model.rs`, C6-8, #7783; `ifc_lite_export::model`
//! re-exports it at the same paths.)
//!
//! Shared **export data model** — one parse pass that yields the entities,
//! property sets and quantity sets the tabular / semantic exporters (CSV, JSON,
//! JSON-LD, Parquet) all consume.
//!
//! Built directly on `ifc_lite_core`'s `EntityDecoder` / `AttributeValue` model
//! (the Rust source of truth), so property + quantity extraction lives in Rust
//! rather than the TS `columnar-parser`. Covers `IfcProduct` occurrences and their
//! directly-attached `IfcRelDefinesByProperties` property/quantity sets.

use std::collections::HashMap;
use std::sync::Arc;

use ifc_lite_core::{
    keyword_eq, slot, AttributeValue, DecodedEntity, EntityDecoder, EntityIndex, EntityScanner, IfcType,
    EXPORTER_STRATUM_ALIASES,
};
use crate::element::{plan_type_geometry, TypeGeometryMode};
use crate::prepass::{resolve_unit_scales, UnitScales};
use ifc_lite_geometry::GeometryRouter;
use rustc_hash::FxHashSet;


mod options;
pub use options::{ModelOptions, Placement};

pub use ifc_lite_core::fmt_num::fmt_num;
use super::inherit::{inherit_from_type, TypeSetCache};
use super::type_assignments::TypeAssignments;
use super::render::flat::{new_property_decoder, opt_string, ref_list, render_attributes, resolve_pset_defs_with_kinds};
use super::property::PropertyKind;

mod classified;
pub use classified::{
    stream_export_model_with_inherited, stream_export_model_with_options, stream_export_model_with_property_kinds,
};
mod support;
mod types;
use support::TypeProductCandidate;
pub use support::attribute_schema;
pub use types::{EntityRow, ExportModel, Inherited, PropValue, PropertySet, QuantitySet, QuantityValue, ValueKind};

/// Build the export model from raw IFC/STEP bytes.
///
/// Collects every row into an [`ExportModel`]. This is fine for normal models,
/// but for very large ones (tens of millions of entities) the retained
/// `Vec<EntityRow>` is itself multiple GB — prefer [`stream_export_model`], which
/// yields rows one at a time and never holds them all. `build_export_model` is a
/// thin `collect` over `stream_export_model`, so the two share one code path.
pub fn build_export_model(content: &[u8]) -> ExportModel {
    let mut entities = Vec::new();
    let units = stream_export_model(content, |row| entities.push(row));
    ExportModel { entities, units }
}

/// [`build_export_model`] with options. Same memory caveat: this collects.
pub fn build_export_model_with_options(content: &[u8], opts: &ModelOptions) -> ExportModel {
    let entity_index = Arc::new(crate::build_entity_index_parallel(content));
    let mut entities = Vec::new();
    let units =
        stream_export_model_with_options(content, &entity_index, opts, |row, _| entities.push(row));
    ExportModel { entities, units }
}

/// Stream one [`EntityRow`] per `IfcProduct` occurrence, in file order, invoking
/// `f` for each row and then dropping it.
///
/// Unlike [`build_export_model`], this never retains all rows and never caches the
/// non-product entities (cartesian points, directions, index lists, …) that make
/// up the bulk of a STEP file. Peak working set is bounded by the entity index
/// plus the property side-map (both O(products)), so a model with tens of millions
/// of entities extracts in a few GB instead of exhausting memory. Output is the
/// caller's responsibility to stream onwards (e.g. to S3/Parquet) and drop.
pub fn stream_export_model(content: &[u8], f: impl FnMut(EntityRow)) -> UnitScales {
    // Parallel on native (byte-identical to `build_entity_index`), serial on wasm.
    let entity_index = Arc::new(crate::build_entity_index_parallel(content));
    stream_export_model_with_index(content, &entity_index, f)
}

/// Like [`stream_export_model`] but reuses a pre-built entity index. A caller also
/// running the geometry pass ([`crate::try_export_glb_with_stats_with_index`]) over the
/// same bytes builds the index once with [`build_entity_index`] and shares it across
/// both, skipping the duplicate scan. `entity_index` MUST be built from the same
/// `content`; output is identical to `stream_export_model`.
/// Returns the model's [`UnitScales`], so a caller consuming attribute values can
/// interpret them without a second pass over the file: the scales are resolved
/// from the decoder this function already builds.
pub fn stream_export_model_with_index(
    content: &[u8],
    entity_index: &Arc<EntityIndex>,
    mut f: impl FnMut(EntityRow),
) -> UnitScales {
    stream_export_model_with_options(content, entity_index, &ModelOptions::default(), |row, _| {
        f(row)
    })
}

fn stream_rows(
    content: &[u8],
    entity_index: &Arc<EntityIndex>,
    opts: &ModelOptions,
    capture_kinds: bool,
    mut f: impl FnMut(EntityRow, Inherited, Option<&DecodedEntity>, &[Vec<PropertyKind>]),
) -> UnitScales {
    // Attribute positions are schema-specific. Unlike STEP re-export, where
    // IFC4 is an established fallback for a missing declaration, attribute
    // export must fail closed rather than assign IFC4 names to unknown slots.
    let source_schema = attribute_schema(content);
    // Property resolution memoizes the shared `IfcPropertySet`/leaf entities for
    // speed. Cap that cache so it can't grow without bound across millions of
    // products; clearing only forces a re-decode of a shared set, never affects
    // correctness.
    const PSET_CACHE_CAP: usize = 1 << 18; // 262_144 entries

    let mut decoder = EntityDecoder::with_arc_index(content, entity_index.clone());
    let mut props = new_property_decoder(content.len());
    // Pass 1 — one scan that collects, uncached (each entity visited once here):
    //   • object → attached property/quantity definitions (IfcRelDefinesByProperties),
    //   • the #957/#1518 type-product orphan-geometry bookkeeping, mirroring the
    //     geometry pass exactly so both agree on which IfcTypeProducts are meshed.
    // IfcRelDefinesByProperties: [GlobalId, OwnerHistory, Name, Description,
    //                             RelatedObjects(4, list), RelatingPropertyDefinition(5, ref or set)]
    let mut defs_by_object: HashMap<u32, Vec<u32>> = HashMap::new();
    // The file's single IFCPROJECT, for the unit resolution below. First wins:
    // the schema allows exactly one, and a malformed file with two would
    // otherwise make which units apply depend on scan order.
    let mut project_id: Option<u32> = None;
    // #957 "Route B": an IfcTypeProduct that carries its own RepresentationMaps
    // renders directly under the type's expressId when NO occurrence draws it. The
    // geometry pass (processor::process_geometry) decides this with three sets —
    // reproduce them here so a type-product row is emitted for exactly the meshed
    // set (#1518), reusing the CANONICAL `plan_type_geometry` gate for the decision.
    let mut referenced_representation_maps: FxHashSet<u32> = FxHashSet::default();
    let mut instantiated_type_ids: FxHashSet<u32> = FxHashSet::default();
    let mut type_product_candidates: Vec<TypeProductCandidate> = Vec::new();
    // Occurrence → its `IfcTypeObject`, from `IfcRelDefinesByType.RelatedObjects`.
    // Populated only when `opts.inherit_type_properties` asks for it.
    let mut type_by_object = TypeAssignments::new();
    // Type id → its resolved sets, so one IfcWallType typing 5000 walls is
    // decoded once. Bounded by the file's distinct types, which is orders of
    // magnitude below its occurrences.
    let mut type_pset_cache = TypeSetCache::new();
    {
        let mut scanner = EntityScanner::new(content);
        while let Some((id, type_name, start, end)) = scanner.next_entity() {
            if keyword_eq(type_name, "IFCRELDEFINESBYPROPERTIES") {
                let rel = match decoder.decode_at_uncached(start, end) {
                    Ok(e) => e,
                    Err(_) => continue,
                };
                // A single definition or an IfcPropertySetDefinitionSet, bare
                // or typed (#7681): `get_refs` reads every spelling.
                let Some(def_ids) = rel.ref_list_at(slot::IfcRelDefinesByProperties::RELATING_PROPERTY_DEFINITION) else { continue };
                if let Some(objs) = rel.attr(slot::IfcRelDefinesByProperties::RELATED_OBJECTS).and_then(|a| a.as_list()) {
                    for o in objs {
                        if let Some(oid) = o.as_entity_ref() {
                            defs_by_object.entry(oid).or_default().extend_from_slice(&def_ids);
                        }
                    }
                }
            } else if keyword_eq(type_name, "IFCMAPPEDITEM") {
                // IfcMappedItem.MappingSource (attr 0) → the RepresentationMap an
                // occurrence instances; such maps draw through the occurrence, so
                // they are NOT orphan type geometry.
                if let Ok(mi) = decoder.decode_at_uncached(start, end) {
                    if let Some(src) = mi.ref_at(slot::IfcMappedItem::MAPPING_SOURCE) {
                        referenced_representation_maps.insert(src);
                    }
                }
            } else if keyword_eq(type_name, "IFCRELDEFINESBYTYPE") {
                // IfcRelDefinesByType.RelatingType (attr 5) → a type WITH occurrences;
                // its geometry is drawn by those occurrences, never as orphan type
                // geometry (the AC20/ArchiCAD duplicate-boxes guard).
                //
                // RelatedObjects (attr 4) is read only when property inheritance
                // is on: it is the occurrence → type edge that makes a type's
                // HasPropertySets reachable from the occurrence, and building the
                // map costs an allocation per typed occurrence that the geometry
                // bookkeeping above has no use for.
                if let Ok(rel) = decoder.decode_at_uncached(start, end) {
                    if let Some(tid) = rel.ref_at(slot::IfcRelDefinesByType::RELATING_TYPE) {
                        instantiated_type_ids.insert(tid);
                        if opts.inherit_type_properties {
                            if let Some(objs) = rel.attr(slot::IfcRelDefinesByType::RELATED_OBJECTS).and_then(|a| a.as_list()) {
                                for o in objs {
                                    if let Some(oid) = o.as_entity_ref() {
                                        // FIRST relationship wins, conflicts recorded (D42).
                                        type_by_object.record(oid, tid);
                                    }
                                }
                            }
                        }
                    }
                }
            } else if keyword_eq(type_name, "IFCPROJECT") {
                project_id = project_id.or(Some(id));
            } else {
                // An IfcTypeProduct subtype carrying RepresentationMaps (attr 6).
                // `type_product_ifc_type` keeps its own cheap suffix pre-filter, so
                // the non-type majority still pays only that.
                //
                // Asked once, in the branch body rather than in its condition: a
                // condition cannot bind, so testing `.is_some()` there forced a
                // second identical call to get the value. Shares `type_product_ifc_type` with the
                // processor's type-geometry gate, so this pass cannot admit a
                // different set than the one that gets meshed (#1518, #3187).
                let Some(type_ty) = ifc_lite_core::type_product_ifc_type(type_name) else {
                    continue;
                };
                let t = match decoder.decode_at_uncached(start, end) {
                    Ok(e) => e,
                    Err(_) => continue,
                };
                let rep_map_ids = ref_list(t.attr(slot::IfcTypeProduct::REPRESENTATION_MAPS));
                if rep_map_ids.is_empty() {
                    continue;
                }
                type_product_candidates.push(TypeProductCandidate {
                    express_id: id,
                    ifc_type: type_ty,
                    type_name: type_name.to_string(),
                    global_id: opt_string(t.attr(slot::IfcTypeProduct::GLOBAL_ID)),
                    name: opt_string(t.attr(slot::IfcTypeProduct::NAME)),
                    description: opt_string(t.attr(slot::IfcTypeProduct::DESCRIPTION)),
                    rep_map_ids,
                    pset_def_ids: ref_list(t.attr(slot::IfcTypeProduct::HAS_PROPERTY_SETS)),
                });
            }
        }
    }

    // Units, resolved from the `IFCPROJECT` pass 1 just walked past. The
    // resolver falls back to a SIMD substring search for that entity when it is
    // not told which one it is; handing it the id makes this an O(1) decode
    // against the index this function already holds, and pass 1 visits every
    // entity anyway, so recording it costs nothing.
    //
    // Resolved here rather than left to the caller because a consumer of the
    // rows needs it to interpret them — attribute values are in the file's own
    // units, unlike the geometry exporters' output — and returning it means
    // they cannot forget to ask.
    let units = resolve_unit_scales(content, project_id, &mut decoder);

    // Not drained: meshes nothing. Pinned by rust/geometry/tests/issue_3821_auxiliary_routers_mesh_nothing.rs.
    // Built with the file's scale, NOT `GeometryRouter::new()`: `new` defaults
    // `unit_scale` to 1.0 and `scale_transform` only scales when it was given
    // the real one, so the difference is silently-millimetre translations.
    // Constructed only when asked — it registers its processor table.
    let router = opts
        .placements
        .then(|| GeometryRouter::with_scale(units.length_unit_scale));

    // Pass 2 — emit a row per IfcProduct occurrence, resolving its property/quantity sets.
    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        // Filter on the STEP keyword before decoding, skipping non-product geometry primitives. The three exporter-only stratum
        // spellings are explicit product compatibility aliases: they keep their
        // owned exact keyword rather than being relabelled as a nearby EXPRESS
        // entity, while still receiving the row their geometry needs.
        let ty = ifc_lite_core::ifc_type_from_keyword(type_name);
        if !ty.is_subtype_of(IfcType::IfcProduct)
            && !EXPORTER_STRATUM_ALIASES
                .iter()
                .any(|alias| keyword_eq(type_name, alias))
        {
            continue;
        }
        let entity = match decoder.decode_at_uncached(start, end) {
            Ok(e) => e,
            Err(_) => continue,
        };
        // PascalCase canonical name (IfcWall), not the STEP keyword (IFCWALL).
        // An owned unknown compatibility alias intentionally retains its exact
        // upper-case STEP spelling, matching the geometry label.
        let ifc_type = ty.name().to_string();
        let global_id = opt_string(entity.attr(slot::IfcProduct::GLOBAL_ID));
        let name = opt_string(entity.attr(slot::IfcProduct::NAME));
        let description = opt_string(entity.attr(slot::IfcProduct::DESCRIPTION));
        let object_type = opt_string(entity.attr(slot::IfcProduct::OBJECT_TYPE));
        let has_geometry = entity.attr(slot::IfcProduct::REPRESENTATION).is_some_and(|a| !a.is_null());

        // `None` is decided from attribute 5, not from the resolver's `Result`:
        // the resolver answers `Ok(identity)` for an absent placement as well as
        // for a broken one, so asking it would report every unplaced product as
        // sitting at the origin.
        let placement = router.as_ref().and_then(|r| {
            entity.attr(slot::IfcProduct::OBJECT_PLACEMENT).filter(|a| !matches!(a, AttributeValue::Null | AttributeValue::Derived))?;
            r.resolve_scaled_placement(&entity, &mut decoder)
                .ok()
                .map(|matrix| Placement { matrix })
        });

        // One pass over the object's definitions: `(#20,#20)`, or two
        // relationships naming one set, must not export that set twice.
        let mut def_ids = defs_by_object.get(&id).cloned().unwrap_or_default();
        if def_ids.len() > 1 {
            let mut seen = FxHashSet::default();
            def_ids.retain(|d| seen.insert(*d));
        }
        let mut kinds = Vec::new();
        let (mut property_sets, mut quantity_sets) = resolve_pset_defs_with_kinds(
            &mut props, &mut decoder, &def_ids, capture_kinds.then_some(&mut kinds),
        );

        let mut inherited = Inherited::default();
        if opts.inherit_type_properties {
            if let Some(type_id) = type_by_object.type_of(id) {
                let defs = (&mut props, &mut decoder, &defs_by_object);
                (property_sets, quantity_sets, inherited) =
                    inherit_from_type(&mut type_pset_cache, type_id, defs, property_sets, quantity_sets);
            }
        }

        f(
            EntityRow {
                express_id: id,
                ifc_type,
                global_id,
                name,
                description,
                object_type,
                has_geometry,
                placement,
                property_sets,
                quantity_sets,
                attributes: if opts.attributes {
                    render_attributes(&entity, type_name, source_schema.as_deref())
                } else {
                    Vec::new()
                },
            },
            inherited, Some(&entity), &kinds,
        );

        // Bound decoded-entity retention without invalidating placement memoization.
        if decoder.cache_size() > PSET_CACHE_CAP {
            decoder.clear_entity_cache();
        }
    }

    // Pass 3 — emit a row for each IfcTypeProduct whose ORPHAN RepresentationMaps
    // the geometry pass meshes (#957 class 1) under the type's own expressId. Ties
    // the exact same canonical gate (`plan_type_geometry`, SuppressInstanced — the
    // export/native profile) the processor uses, so the geometry and attribute
    // passes agree on the meshed set: no more type-product GLB nodes without an
    // EntityRow (#1518). Emitted after all product rows, matching the geometry
    // pass appending its type-geometry jobs after the product jobs. On a normal
    // model (no orphan type geometry) `type_product_candidates` is empty, so this
    // is a no-op and output is byte-identical to before.
    for cand in &type_product_candidates {
        let meshed = !plan_type_geometry(
            &cand.rep_map_ids,
            &referenced_representation_maps,
            instantiated_type_ids.contains(&cand.express_id),
            TypeGeometryMode::SuppressInstanced,
        )
        .is_empty();
        if !meshed {
            continue;
        }

        // The type's own HasPropertySets. Sets attached to it by
        // IfcRelDefinesByProperties are read only for inheritance.
        let mut kinds = Vec::new();
        let (property_sets, quantity_sets) = resolve_pset_defs_with_kinds(
            &mut props, &mut decoder, &cand.pset_def_ids, capture_kinds.then_some(&mut kinds),
        );

        f(
            EntityRow {
                express_id: cand.express_id,
                // PascalCase canonical name (IfcBoilerType) — equals the node's
                // `ifcType` extra the geometry pass emits.
                ifc_type: cand.ifc_type.name().to_string(),
                global_id: cand.global_id.clone(),
                name: cand.name.clone(),
                description: cand.description.clone(),
                // IfcTypeObject attr 4 is ApplicableOccurrence, not ObjectType.
                object_type: None,
                has_geometry: true,
                placement: None,
                property_sets,
                quantity_sets,
                // Pass 3 has no type handle, so honouring the attributes option
                // costs one decode per rare orphan-geometry type.
                attributes: if opts.attributes {
                    decoder
                        .decode_by_id(cand.express_id)
                        .ok()
                        .map(|t| render_attributes(&t, &cand.type_name, source_schema.as_deref()))
                        .unwrap_or_default()
                } else {
                    Vec::new()
                },
            },
            Inherited::default(), None, &kinds,
        );
        if decoder.cache_size() > PSET_CACHE_CAP {
            decoder.clear_entity_cache();
        }
    }

    units
}
