// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Which rows the data model's entities table carries (issue #6034).
//!
//! Its own module because it is a WIRE CONTRACT as much as a filter: the parse
//! routes read it off the query, the data-model cache key is built from it, the
//! fetch route selects by it, and the client sends it. One definition keeps
//! those four in step, the same shape as `parquet_layout.rs`.

use super::slots::RootSlots;
use super::types::{
    ClassificationAssociation, DataModel, DocumentAssociation, EntityJob, MaterialAssociation,
    PropertySet, QuantitySet, Relationship, SpatialHierarchyData,
};
use rustc_hash::{FxHashMap, FxHashSet};
use std::borrow::Cow;

/// Which STEP instances the data model's entities table carries.
///
/// OPT-IN, defaulting to [`Self::All`], because the default table is a public
/// payload: a client that looks up a non-rooted instance by id (an
/// `IfcCartesianPoint`, an `IfcPropertySingleValue`) keeps working, and a
/// default request writes and reads exactly the bytes it did before #6034.
///
/// [`Self::Rooted`] is for the clients that only ever look up objects. On a
/// large architectural model about five in six entity rows are geometry and
/// property plumbing with no GlobalId (`IfcPolyLoop`, `IfcFace`,
/// `IfcCartesianPoint`, `IfcPropertySingleValue`, ...), none of which another
/// table of the data model points at: property values are already flattened
/// into the properties table, quantities into the quantities table.
///
/// The two variants are cached under separate keys (see
/// `routes::parse::cache_keys::data_model_cache_key`), so a warm cache can
/// never answer one with the other.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Deserialize)]
pub enum DataModelEntities {
    /// Every STEP instance in the file. The only behaviour before #6034.
    #[default]
    #[serde(rename = "all")]
    All,
    /// Only rooted entities (`IfcRoot` subtypes, the ones carrying a
    /// GlobalId), plus every non-rooted instance another table of the same
    /// data model references by id, so no relation dangles. See
    /// [`retain_rooted_entities`].
    #[serde(rename = "rooted")]
    Rooted,
}

impl DataModelEntities {
    /// The data-model cache-key infix naming this variant. Empty for
    /// [`Self::All`], so a default request keeps hitting the entries already
    /// on disk.
    pub fn cache_infix(self) -> &'static str {
        match self {
            Self::All => "",
            Self::Rooted => "-rooted",
        }
    }

    /// Narrow `data_model`'s entities table to this variant. A no-op for
    /// [`Self::All`]; every other table is left untouched either way.
    pub fn apply(self, data_model: &mut DataModel) {
        if self == Self::Rooted {
            retain_rooted_entities(data_model);
        }
    }
}

/// Keep the entity rows a rooted-only client can need, dropping the rest.
///
/// A row is kept when EITHER
/// - it is rooted: it carries a GlobalId, or its type is one the schema
///   registry says declares one (an `IfcRoot` subtype whose GlobalId the file
///   left empty is still an object); or
/// - another table of this data model references its id: a material, a
///   material layer set or usage (`materials.definition_id` /
///   `material_id`), the `RelatingMaterial` / `RelatingClassification` /
///   `RelatingDocument` of an `IfcRelAssociates*` row, and so on.
///
/// The second rule is what keeps every relation resolvable. Without it the
/// relationships table would name `IfcMaterial` and `IfcClassificationReference`
/// ids the entities table no longer describes, and a client resolving a
/// relation's endpoint to its type or name through the entities table would
/// find nothing. They are few, so keeping them costs nothing measurable; the
/// rows this drops are the ones nothing points at.
///
/// `entity_id`s are untouched, and the kept rows stay in file order.
pub(crate) fn retain_rooted_entities(data_model: &mut DataModel) {
    let referenced = referenced_ids(data_model);
    // Types are few (hundreds) and rows are many (millions), so the registry
    // lookup runs once per type.
    let mut rooted_type: FxHashMap<String, bool> = FxHashMap::default();
    let keep: Vec<bool> = data_model
        .entities
        .iter()
        .map(|entity| {
            if entity.global_id.is_some() || referenced.contains(&entity.entity_id) {
                return true;
            }
            if let Some(&rooted) = rooted_type.get(entity.type_name.as_str()) {
                return rooted;
            }
            let rooted = declares_global_id(&entity.type_name);
            rooted_type.insert(entity.type_name.clone(), rooted);
            rooted
        })
        .collect();
    let mut keep = keep.into_iter();
    // `retain` visits every element exactly once, in order.
    data_model
        .entities
        .retain(|_| keep.next().unwrap_or(true));
}

/// Whether the schema registry lists `type_name` as declaring a GlobalId,
/// i.e. as an `IfcRoot` subtype. A type the registry does not know answers
/// `false`: for those the extracted `global_id` (read at the `IfcRoot`
/// position by the metadata fallback) is the only evidence there is.
fn declares_global_id(type_name: &str) -> bool {
    RootSlots::declares_global_id(type_name)
}

/// Every entity id another table of `data_model` points at. `0` is the
/// tables' "none" (a root spatial node's parent, a synthetic relationship's
/// `rel_id`), never an instance, so it is skipped.
fn referenced_ids(data_model: &DataModel) -> FxHashSet<u32> {
    let mut ids = FxHashSet::default();
    collect_table_refs(TableRefs::of(data_model), &mut ids);
    collect_spatial_refs(&data_model.spatial_hierarchy, &mut ids);
    ids
}

/// The tables that can name a non-rooted instance, borrowed together.
///
/// Borrowed rather than read off a [`DataModel`] because the pre-filter
/// ([`metadata_jobs`]) has to consult them BEFORE a `DataModel` exists -- the
/// entities table it is deciding is the one that would go into it. One type
/// and one collector serve both callers, so the rule for "which non-rooted
/// rows must survive" cannot drift between them.
#[derive(Clone, Copy)]
pub(crate) struct TableRefs<'a> {
    pub(crate) property_sets: &'a [PropertySet],
    pub(crate) quantity_sets: &'a [QuantitySet],
    pub(crate) relationships: &'a [Relationship],
    pub(crate) classifications: &'a [ClassificationAssociation],
    pub(crate) materials: &'a [MaterialAssociation],
    pub(crate) documents: &'a [DocumentAssociation],
}

impl<'a> TableRefs<'a> {
    fn of(data_model: &'a DataModel) -> Self {
        Self {
            property_sets: &data_model.property_sets,
            quantity_sets: &data_model.quantity_sets,
            relationships: &data_model.relationships,
            classifications: &data_model.classifications,
            materials: &data_model.materials,
            documents: &data_model.documents,
        }
    }
}

/// Every id `tables` names. THE one policy; both filters call it.
fn collect_table_refs(tables: TableRefs<'_>, ids: &mut FxHashSet<u32>) {
    let mut add = |id: u32| {
        if id != 0 {
            ids.insert(id);
        }
    };
    for rel in tables.relationships {
        add(rel.rel_id);
        add(rel.relating_id);
        add(rel.related_id);
    }
    for pset in tables.property_sets {
        add(pset.pset_id);
    }
    for qset in tables.quantity_sets {
        add(qset.qset_id);
    }
    for row in tables.classifications {
        add(row.element_id);
    }
    // `definition_id` and `material_id` are the non-rooted ones: an
    // `IfcMaterial` or an `IfcMaterialLayerSet` carries no GlobalId, and no
    // other table names it.
    for row in tables.materials {
        add(row.element_id);
        add(row.association_id);
        add(row.definition_id);
        if let Some(material_id) = row.material_id {
            add(material_id);
        }
    }
    for row in tables.documents {
        add(row.element_id);
    }
}

/// Every id the spatial hierarchy names.
///
/// The pre-filter does NOT call this, and cannot: the hierarchy is built from
/// the entities table it is deciding. It does not have to, because every id
/// reachable here is already kept for another reason -- see the proof on
/// [`metadata_jobs`], and `rooted_tests.rs`, which asserts the whole
/// `SpatialHierarchyData` is identical on both paths.
fn collect_spatial_refs(spatial: &SpatialHierarchyData, ids: &mut FxHashSet<u32>) {
    let mut add = |id: u32| {
        if id != 0 {
            ids.insert(id);
        }
    };
    add(spatial.project_id);
    for node in &spatial.nodes {
        add(node.entity_id);
        add(node.parent_id);
        node.children_ids.iter().for_each(|&id| add(id));
        node.element_ids.iter().for_each(|&id| add(id));
    }
    for lookup in [
        &spatial.element_to_storey,
        &spatial.element_to_building,
        &spatial.element_to_site,
        &spatial.element_to_space,
    ] {
        for &(element, container) in lookup {
            add(element);
            add(container);
        }
    }
}

/// The jobs whose metadata a narrowed extraction still has to build, so the
/// rest are never materialised. [`DataModelEntities::All`] borrows the full
/// list: the default path does not copy a job.
///
/// # What this decides, and with what
///
/// [`retain_rooted_entities`] decides per EXTRACTED ROW, which knows whether a
/// GlobalId was actually present. Here only the type name is known, so the
/// test is deliberately WIDER in one place: a type the IFC4 registry does not
/// list is kept, because for those the extracted GlobalId is the only evidence
/// there is (`RootSlots::UNKNOWN_TYPE_FALLBACK` reads slot 0) and dropping
/// them here would lose rows the post-filter keeps. Vendor extensions are the
/// realistic unknown type and they are rare; a file made entirely of them
/// simply costs what the unfiltered path costs today.
///
/// `retain_rooted_entities` then runs on the much smaller table and applies
/// the exact rule, so the two paths agree row for row.
///
/// # Why this is safe without the spatial tables
///
/// [`referenced_ids`] -- the post-filter's retained set -- also includes
/// `spatial_hierarchy`, which does not exist yet here. It does not need to,
/// because the hierarchy can only name ids this filter already keeps:
///
/// - `project_id`, and every id in `spatial_entity_ids`, is an entity whose
///   type is in `spatial.rs`'s spatial-type list. Every one of those is an
///   `IfcRoot` subtype, so it is kept by type (or, for the IFC4X3 ones the
///   IFC4 registry does not list, kept as an unknown type).
/// - every other id the builder touches -- a node's `parent_id`, its
///   `children_ids`, its `element_ids`, and both halves of every
///   `element_to_*` pair -- is read from `IfcRelAggregates` /
///   `IfcRelContainedInSpatialStructure` rows, so it is a `relating_id` or a
///   `related_id` of the relationships table, which `collect_table_refs`
///   keeps.
///
/// So the spatial build also sees the same answers from the narrowed table it
/// saw from the full one: every id it looks up in its `entity_map` is a
/// relationship endpoint or a spatial-typed row. `rooted_tests.rs` asserts
/// that empirically on real models and on disconnected and malformed spatial
/// fixtures, rather than resting on this argument.
///
/// # The ordering condition
///
/// The caller must have built EVERY other table in `tables` first,
/// associations included. That is not hypothetical: while the association
/// pass still ran after this one, the catalogued models lost every non-rooted
/// `IfcMaterial` the materials table points at -- 24 rows on
/// `ara3d/AC20-FZK-Haus.ifc`, 88 on `ara3d/ISSUE_068_ARK_NUS_skolebygg.ifc` --
/// because nothing had yet recorded that they were referenced.
pub(crate) fn metadata_jobs<'j, 'a>(
    entities: DataModelEntities,
    all_entities: &'j [EntityJob<'a>],
    tables: TableRefs<'_>,
) -> Cow<'j, [EntityJob<'a>]> {
    if entities == DataModelEntities::All {
        return Cow::Borrowed(all_entities);
    }

    let mut referenced = FxHashSet::default();
    collect_table_refs(tables, &mut referenced);
    // Types are few (hundreds) and rows are many (millions), so the registry
    // lookup runs once per type rather than once per row.
    let mut keep_type: FxHashMap<&str, bool> = FxHashMap::default();
    Cow::Owned(
        all_entities
            .iter()
            .filter(|job| {
                if referenced.contains(&job.id) {
                    return true;
                }
                *keep_type
                    .entry(job.type_name)
                    .or_insert_with(|| may_carry_global_id(job.type_name))
            })
            .copied()
            .collect(),
    )
}

/// Whether a row of this type could survive [`retain_rooted_entities`] on its
/// GlobalId alone.
///
/// Derived from [`declares_global_id`], the post-filter's own predicate,
/// rather than restating it: that one answers `false` for BOTH "known to IFC4
/// and declares no GlobalId" and "not in the registry at all", and only the
/// first of those is a reason to drop a row before it exists. For the second,
/// the metadata pass falls back to `RootSlots::UNKNOWN_TYPE_FALLBACK` and
/// reads slot 0, so only the extracted row can say.
fn may_carry_global_id(type_name: &str) -> bool {
    declares_global_id(type_name) || RootSlots::for_type(type_name).is_none()
}

#[cfg(test)]
#[path = "rooted_tests.rs"]
mod tests;
