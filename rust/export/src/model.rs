// SPDX-License-Identifier: MPL-2.0
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

use ifc_lite_core::{DecodedEntity, EntityDecoder, EntityIndex, EntityScanner, IfcType};
use ifc_lite_geometry::GeometryRouter;
use ifc_lite_processing::element::{plan_type_geometry, TypeGeometryMode};
use ifc_lite_processing::prepass::{resolve_unit_scales, UnitScales};
use rustc_hash::FxHashSet;

#[path = "model_options.rs"]
mod options;
pub use options::{ModelOptions, Placement};

#[path = "model_props.rs"]
mod props;
pub use props::fmt_num;
use props::{opt_string, ref_list, render_attributes, resolve_pset_defs};

#[path = "model_inherit.rs"]
mod inherit;
use inherit::merge_inherited;

/// A single property value (`IfcPropertySingleValue` and friends).
#[derive(Debug, Clone, PartialEq)]
pub struct PropValue {
    pub name: String,
    pub value: String,
    /// IFC value type tag when known (e.g. `IFCLABEL`, `IFCREAL`, `IFCBOOLEAN`).
    pub value_type: String,
}

/// A named property set (`IfcPropertySet`).
#[derive(Debug, Clone, PartialEq)]
pub struct PropertySet {
    pub name: String,
    pub properties: Vec<PropValue>,
}

/// A single physical quantity (`IfcQuantityLength`/`Area`/`Volume`/…).
#[derive(Debug, Clone, PartialEq)]
pub struct QuantityValue {
    pub name: String,
    pub value: f64,
    /// `Length` | `Area` | `Volume` | `Count` | `Weight` | `Time`.
    pub kind: &'static str,
}

/// A named quantity set (`IfcElementQuantity`).
#[derive(Debug, Clone, PartialEq)]
pub struct QuantitySet {
    pub name: String,
    pub quantities: Vec<QuantityValue>,
}

/// One exportable entity row (an `IfcProduct` occurrence).
#[derive(Debug, Clone, PartialEq)]
pub struct EntityRow {
    pub express_id: u32,
    pub ifc_type: String,
    pub global_id: Option<String>,
    pub name: Option<String>,
    pub description: Option<String>,
    pub object_type: Option<String>,
    /// True when the product carries a geometric Representation (attr 6).
    pub has_geometry: bool,
    /// The product's placement, when [`ModelOptions::placements`] asked for it
    /// AND the product carries an `ObjectPlacement` (attr 5).
    ///
    /// `None` is therefore two different facts. The caller knows which it asked
    /// for; it cannot tell from the row alone, and 7.5% of product occurrences
    /// in a real corpus genuinely have no placement, so this is not a rare case
    /// to hand-wave.
    ///
    /// **A resolvable-but-broken chain is not `None`.** A dangling reference, a
    /// cycle, or a chain deeper than 32 composes to the identity, and identity
    /// is a legitimate placement — so a malformed file yields a product at the
    /// origin rather than an error. Distinguishing those would mean changing
    /// what the resolver returns, which is a wider change than this.
    pub placement: Option<Placement>,
    pub property_sets: Vec<PropertySet>,
    pub quantity_sets: Vec<QuantitySet>,
    /// The entity's TYPE-SPECIFIC attributes, when [`ModelOptions::attributes`]
    /// asked for them. Empty otherwise, and empty for a type that declares none
    /// beyond the rooted set.
    ///
    /// Not property sets, and not reachable through one: `NominalDiameter` on
    /// an `IfcReinforcingBar` or `OverallHeight` on an `IfcDoor` is declared on
    /// the entity itself, so a consumer reading only psets never sees it. The
    /// fields this row already carries (`GlobalId`, `Name`, `Description`,
    /// `ObjectType`) and the reference-valued ones are excluded.
    pub attributes: Vec<PropValue>,
}

impl EntityRow {
    /// Look up a flattened `PsetName.PropName` value (case-sensitive), then quantities.
    pub fn lookup(&self, pset: &str, prop: &str) -> Option<String> {
        for ps in &self.property_sets {
            if ps.name == pset {
                for p in &ps.properties {
                    if p.name == prop {
                        return Some(p.value.clone());
                    }
                }
            }
        }
        for qs in &self.quantity_sets {
            if qs.name == pset {
                for q in &qs.quantities {
                    if q.name == prop {
                        return Some(fmt_num(q.value));
                    }
                }
            }
        }
        None
    }
}

/// The full extracted model.
#[derive(Debug, Clone, PartialEq)]
pub struct ExportModel {
    pub entities: Vec<EntityRow>,
    /// The model's unit scales, resolved from its `IFCPROJECT`.
    ///
    /// Attribute values in [`EntityRow`] are in the file's OWN units — a
    /// millimetre model yields a `Qto_WallBaseQuantities.Length` of 3000, not 3.
    /// The geometry exporters normalise to metres; this path deliberately does
    /// not, because a property value is not always a length and coercing one
    /// would be guessing. That leaves the caller needing the scale to interpret
    /// anything dimensional, and until now it had no way to obtain it: the
    /// resolver was internal and `ExportModel` carried only entities. A consumer
    /// writing quantities alongside exported geometry therefore had a silent
    /// 1000x mismatch with no value on hand to detect it with.
    pub units: UnitScales,
}

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
    let entity_index = Arc::new(ifc_lite_processing::build_entity_index_parallel(content));
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
    let entity_index = Arc::new(ifc_lite_processing::build_entity_index_parallel(content));
    stream_export_model_with_index(content, &entity_index, f)
}

/// An `IfcTypeProduct` (e.g. `IfcBoilerType`) that carries its own
/// `RepresentationMaps` — a #957 "Route B" mesh candidate. The geometry pass
/// meshes the ORPHAN ones (no occurrence instantiates them) under the type's own
/// expressId; without a matching [`EntityRow`] those GLB nodes render with no
/// attributes (#1518). Everything needed to emit that row is captured here in the
/// pass-1 scan so the emission phase never re-decodes the type.
struct TypeProductCandidate {
    express_id: u32,
    ifc_type: IfcType,
    global_id: Option<String>,
    name: Option<String>,
    description: Option<String>,
    /// `IfcTypeProduct.RepresentationMaps` (attr 6) — non-empty by construction.
    rep_map_ids: Vec<u32>,
    /// `IfcTypeObject.HasPropertySets` (attr 5): the type's directly-attached
    /// property/quantity set definitions (types do NOT use
    /// `IfcRelDefinesByProperties`).
    pset_def_ids: Vec<u32>,
}

/// Like [`stream_export_model`] but reuses a pre-built entity index. A caller also
/// running the geometry pass ([`crate::export_glb_with_stats_with_index`]) over the
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

/// [`stream_export_model_with_index`], plus the decoded entity behind each row
/// and whatever [`ModelOptions`] asked to resolve.
///
/// The second callback argument is the `DecodedEntity` the row was built from,
/// **borrowed**: a caller that wants an attribute this crate does not surface
/// reads it here, without this crate having to guess which attributes matter
/// and without anything being retained. It is `None` for the type-product rows emitted in
/// pass 3, which are assembled from the pass-1 scan and have no occurrence
/// entity behind them.
///
/// Storing the attributes on [`EntityRow`] instead would be the obvious shape
/// and is the wrong one twice over: `AttributeValue` is not `PartialEq`, so it
/// would break the derive that `stream == build` equality rests on, and
/// [`build_export_model`] collects, so every product's attribute vector would
/// stay resident — which is the exact bound this function exists to keep.
pub fn stream_export_model_with_options(
    content: &[u8],
    entity_index: &Arc<EntityIndex>,
    opts: &ModelOptions,
    mut f: impl FnMut(EntityRow, Option<&DecodedEntity>),
) -> UnitScales {
    // Property resolution memoizes the shared `IfcPropertySet`/leaf entities for
    // speed. Cap that cache so it can't grow without bound across millions of
    // products; clearing only forces a re-decode of a shared set, never affects
    // correctness.
    const PSET_CACHE_CAP: usize = 1 << 18; // 262_144 entries

    let mut decoder = EntityDecoder::with_arc_index(content, entity_index.clone());



    // Pass 1 — one scan that collects, uncached (each entity visited once here):
    //   • object → attached property/quantity definitions (IfcRelDefinesByProperties),
    //   • the #957/#1518 type-product orphan-geometry bookkeeping, mirroring the
    //     geometry pass exactly so both agree on which IfcTypeProducts are meshed.
    // IfcRelDefinesByProperties: [GlobalId, OwnerHistory, Name, Description,
    //                             RelatedObjects(4, list), RelatingPropertyDefinition(5, ref)]
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
    let mut type_by_object: HashMap<u32, u32> = HashMap::new();
    // Type id → its resolved sets, so one IfcWallType typing 5000 walls is
    // decoded once. Bounded by the file's distinct types, which is orders of
    // magnitude below its occurrences.
    let mut type_pset_cache: HashMap<u32, (Vec<PropertySet>, Vec<QuantitySet>)> = HashMap::new();
    {
        let mut scanner = EntityScanner::new(content);
        while let Some((id, type_name, start, end)) = scanner.next_entity() {
            match type_name {
                "IFCRELDEFINESBYPROPERTIES" => {
                    let rel = match decoder.decode_at_uncached(start, end) {
                        Ok(e) => e,
                        Err(_) => continue,
                    };
                    let def_id = match rel.get(5).and_then(|a| a.as_entity_ref()) {
                        Some(d) => d,
                        None => continue,
                    };
                    if let Some(objs) = rel.get(4).and_then(|a| a.as_list()) {
                        for o in objs {
                            if let Some(oid) = o.as_entity_ref() {
                                defs_by_object.entry(oid).or_default().push(def_id);
                            }
                        }
                    }
                }
                // IfcMappedItem.MappingSource (attr 0) → the RepresentationMap an
                // occurrence instances; such maps draw through the occurrence, so
                // they are NOT orphan type geometry.
                "IFCMAPPEDITEM" => {
                    if let Ok(mi) = decoder.decode_at_uncached(start, end) {
                        if let Some(src) = mi.get(0).and_then(|a| a.as_entity_ref()) {
                            referenced_representation_maps.insert(src);
                        }
                    }
                }
                // IfcRelDefinesByType.RelatingType (attr 5) → a type WITH occurrences;
                // its geometry is drawn by those occurrences, never as orphan type
                // geometry (the AC20/ArchiCAD duplicate-boxes guard).
                //
                // RelatedObjects (attr 4) is read only when property inheritance
                // is on: it is the occurrence → type edge that makes a type's
                // HasPropertySets reachable from the occurrence, and building the
                // map costs an allocation per typed occurrence that the geometry
                // bookkeeping above has no use for.
                "IFCRELDEFINESBYTYPE" => {
                    if let Ok(rel) = decoder.decode_at_uncached(start, end) {
                        if let Some(tid) = rel.get(5).and_then(|a| a.as_entity_ref()) {
                            instantiated_type_ids.insert(tid);
                            if opts.inherit_type_properties {
                                if let Some(objs) = rel.get(4).and_then(|a| a.as_list()) {
                                    for o in objs {
                                        if let Some(oid) = o.as_entity_ref() {
                                            // FIRST relationship wins if a file
                                            // types one object twice (a schema
                                            // violation, but exports do it).
                                            // `typeIds[0]` is what the TS
                                            // extractor takes, and scan order
                                            // here is file order, so the two
                                            // pick the same type rather than
                                            // disagreeing per engine.
                                            type_by_object.entry(oid).or_insert(tid);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                // An IfcTypeProduct subtype carrying RepresentationMaps (attr 6). The
                // cheap suffix pre-filter mirrors the geometry pass and keeps the
                // is_subtype_of check off the hot path for the non-type majority.
                _ if (type_name.ends_with("TYPE") || type_name.ends_with("STYLE"))
                    && IfcType::from_str(type_name).is_subtype_of(IfcType::IfcTypeProduct) =>
                {
                    let t = match decoder.decode_at_uncached(start, end) {
                        Ok(e) => e,
                        Err(_) => continue,
                    };
                    let rep_map_ids = ref_list(t.get(6));
                    if rep_map_ids.is_empty() {
                        continue;
                    }
                    type_product_candidates.push(TypeProductCandidate {
                        express_id: id,
                        ifc_type: IfcType::from_str(type_name),
                        global_id: opt_string(t.get(0)),
                        name: opt_string(t.get(2)),
                        description: opt_string(t.get(3)),
                        rep_map_ids,
                        pset_def_ids: ref_list(t.get(5)),
                    });
                }
                "IFCPROJECT" => project_id = project_id.or(Some(id)),
                _ => {}
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
        // Filter on the STEP keyword *before* decoding, skipping the millions of
        // non-product geometry primitives. `legacy_aware_ifc_type` (not a bare
        // `from_str`) resolves removed/renamed keywords (IFCPROXY, IFCSOLIDSTRATUM,
        // …) to their modern base type, matching what the geometry pass meshes —
        // otherwise those products render as GLB nodes with no attribute row (#1496).
        let ty = ifc_lite_core::legacy_aware_ifc_type(type_name);
        if !ty.is_subtype_of(IfcType::IfcProduct) {
            continue;
        }
        let entity = match decoder.decode_at_uncached(start, end) {
            Ok(e) => e,
            Err(_) => continue,
        };
        // PascalCase canonical name (IfcWall), not the STEP keyword (IFCWALL);
        // the legacy-resolved type, so a proxy is "IfcBuildingElementProxy", not
        // "Unknown", and equals the node's `ifcType` extra.
        let ifc_type = ty.name().to_string();
        let global_id = opt_string(entity.get(0));
        let name = opt_string(entity.get(2));
        let description = opt_string(entity.get(3));
        let object_type = opt_string(entity.get(4));
        let has_geometry = entity.get(6).is_some_and(|a| !a.is_null());

        // `None` is decided from attribute 5, not from the resolver's `Result`:
        // the resolver answers `Ok(identity)` for an absent placement as well as
        // for a broken one, so asking it would report every unplaced product as
        // sitting at the origin.
        let placement = router.as_ref().and_then(|r| {
            entity.get(5).filter(|a| !a.is_null())?;
            r.resolve_scaled_placement(&entity, &mut decoder)
                .ok()
                .map(|matrix| Placement { matrix })
        });

        let def_ids = defs_by_object.get(&id).cloned().unwrap_or_default();
        let (mut property_sets, mut quantity_sets) = resolve_pset_defs(&mut decoder, &def_ids);

        // Fold in whatever this occurrence inherits from its type. Resolution is
        // memoized per type id, not per occurrence: a Revit export types
        // thousands of walls off one IfcWallType, and re-decoding its sets for
        // each would turn a constant cost into a linear one.
        if opts.inherit_type_properties {
            if let Some(&type_id) = type_by_object.get(&id) {
                let inherited = type_pset_cache.entry(type_id).or_insert_with_key(|&tid| {
                    // `HasPropertySets` is attr 5 on IfcTypeObject. Resolved
                    // from the type entity itself rather than the pass-1
                    // candidate list, because that list holds only types with
                    // RepresentationMaps and the common inheriting type has
                    // none.
                    let def_ids = decoder
                        .decode_by_id(tid)
                        .ok()
                        .map(|t| ref_list(t.get(5)))
                        .unwrap_or_default();
                    resolve_pset_defs(&mut decoder, &def_ids)
                });
                property_sets = merge_inherited(property_sets, inherited.0.clone());
                quantity_sets = merge_inherited(quantity_sets, inherited.1.clone());
            }
        }

        f(EntityRow {
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
                render_attributes(&entity)
            } else {
                Vec::new()
            },
        }, Some(&entity));

        // Keep the property-resolution cache bounded across the whole file.
        // `clear_entity_cache`, not `clear_cache`: the latter also drops the
        // placement memo, and resolving placements is what makes this trigger
        // fire in the first place. Dropping the memo here would re-resolve the
        // site/building/storey chain that every product under it shares — the
        // output stays correct and the run gets slower the larger the file,
        // which is the opposite of what the cap is for.
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

        // Types attach their sets via HasPropertySets (attr 5), not
        // IfcRelDefinesByProperties.
        let (property_sets, quantity_sets) = resolve_pset_defs(&mut decoder, &cand.pset_def_ids);

        f(EntityRow {
            express_id: cand.express_id,
            // PascalCase canonical name (IfcBoilerType) — equals the node's
            // `ifcType` extra the geometry pass emits.
            ifc_type: cand.ifc_type.name().to_string(),
            global_id: cand.global_id.clone(),
            name: cand.name.clone(),
            description: cand.description.clone(),
            // IfcTypeObject has no ObjectType attribute (attr 4 is
            // ApplicableOccurrence); leave unset rather than mislabel it.
            object_type: None,
            // It is meshed by construction (RepresentationMaps present).
            has_geometry: true,
            // A type object has no ObjectPlacement — it is not an occurrence.
            placement: None,
            property_sets,
            quantity_sets,
            // Pass 3 assembles this row from the pass-1 scan and never holds
            // the type entity, so there is nothing to render from without a
            // re-decode. Type rows are the orphan-geometry case, not the
            // attribute-reading one, so they stay empty rather than paying for
            // a decode nobody asked for.
            attributes: Vec::new(),
        }, None);

        if decoder.cache_size() > PSET_CACHE_CAP {
            decoder.clear_entity_cache();
        }
    }

    units
}

#[cfg(test)]
#[path = "model_tests.rs"]
mod tests;
