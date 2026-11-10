// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for the rooted-only entities table (issue #6034).

use super::super::{extract_data_model, DataModel, EntityMetadata};
use super::{retain_rooted_entities, DataModelEntities};
use std::collections::BTreeSet;

/// A small IFC4 model with every kind of row the rooted filter has to decide:
/// a spatial tree, a wall with a property set, a material layer set, a
/// classification and a document, plus geometry plumbing nothing points at.
const MIXED_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-6034 rooted fixture'),'2;1');
FILE_NAME('rooted.ifc','2026-09-27T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#10=IFCSITE('Site000000000000000001',$,'S',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);
#11=IFCBUILDING('Bldg00000000000000001',$,'B',$,$,$,$,$,.ELEMENT.,$,$,$);
#12=IFCBUILDINGSTOREY('Stor00000000000000001',$,'L1',$,$,$,$,$,.ELEMENT.,0.);
#13=IFCRELAGGREGATES('Agg0000000000000000001',$,$,$,#1,(#10));
#14=IFCRELAGGREGATES('Agg0000000000000000002',$,$,$,#10,(#11));
#15=IFCRELAGGREGATES('Agg0000000000000000003',$,$,$,#11,(#12));
#16=IFCRELCONTAINEDINSPATIALSTRUCTURE('Cnt0000000000000000001',$,$,$,(#28),#12);
#20=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('F90'),$);
#21=IFCPROPERTYSET('Pset000000000000000001',$,'Pset_WallCommon',$,(#20));
#22=IFCRELDEFINESBYPROPERTIES('Def0000000000000000001',$,$,$,(#28),#21);
#28=IFCWALL('Wall00000000000000001',$,'W1',$,$,$,$,$,$);
#29=IFCWALL($,$,'NoGuid',$,$,$,$,$,$);
#30=IFCMATERIAL('Concrete',$,'Mineral');
#31=IFCMATERIAL('Insulation',$,$);
#32=IFCMATERIALLAYER(#30,200.,.F.,'Core',$,'load-bearing',$);
#33=IFCMATERIALLAYER(#31,50.,.T.,'Insul',$,$,$);
#34=IFCMATERIALLAYERSET((#32,#33),'WallSet',$);
#35=IFCRELASSOCIATESMATERIAL('Mat0000000000000000001',$,$,$,(#28),#34);
#40=IFCCLASSIFICATION('Uniclass 2015','2',$,'Uniclass 2015',$,$,$);
#41=IFCCLASSIFICATIONREFERENCE('https://uniclass.example','EF_25_10_25','Walls',#40,$,$);
#42=IFCRELASSOCIATESCLASSIFICATION('Cls0000000000000000001',$,$,$,(#28),#41);
#50=IFCDOCUMENTREFERENCE('https://docs.example/spec','DOC-001','Wall spec',$,$);
#51=IFCRELASSOCIATESDOCUMENT('Doc0000000000000000001',$,$,$,(#28),#50);
#80=IFCPOLYLOOP((#4,#81,#82));
#81=IFCCARTESIANPOINT((1.,0.,0.));
#82=IFCCARTESIANPOINT((0.,1.,0.));
ENDSEC;
END-ISO-10303-21;
"#;

fn ids(entities: &[EntityMetadata]) -> BTreeSet<u32> {
    entities.iter().map(|e| e.entity_id).collect()
}

/// Every id the relation-carrying tables name, collected here independently of
/// the implementation's own `referenced_ids`, so the two cannot agree by
/// sharing a mistake.
fn ids_other_tables_name(dm: &DataModel) -> BTreeSet<u32> {
    let mut out = BTreeSet::new();
    for rel in &dm.relationships {
        out.extend([rel.relating_id, rel.related_id]);
    }
    for m in &dm.materials {
        out.extend([m.element_id, m.association_id, m.definition_id]);
        out.extend(m.material_id);
    }
    out.extend(dm.property_sets.iter().map(|p| p.pset_id));
    out.extend(dm.classifications.iter().map(|c| c.element_id));
    out.extend(dm.documents.iter().map(|d| d.element_id));
    for node in &dm.spatial_hierarchy.nodes {
        out.insert(node.entity_id);
        out.extend(node.element_ids.iter().copied());
        out.extend(node.children_ids.iter().copied());
    }
    out.remove(&0);
    out
}

/// #6034: the rooted table drops the plumbing (points, loops, property
/// values, material layers nothing addresses by id) and keeps the objects
/// plus the non-rooted instances the relations point at.
#[test]
fn issue_6034_rooted_keeps_objects_and_every_referenced_instance() {
    let full = extract_data_model(MIXED_IFC);
    let mut rooted = full.clone();
    retain_rooted_entities(&mut rooted);

    let kept = ids(&rooted.entities);
    // Rooted: project, spatial tree, rels, pset, wall, and the IfcWall whose
    // GlobalId the file left empty (#29): still an IfcRoot subtype.
    for id in [1, 10, 11, 12, 13, 14, 15, 16, 21, 22, 28, 29, 35, 42, 51] {
        assert!(kept.contains(&id), "rooted #{id} must be kept: {kept:?}");
    }
    // Non-rooted but referenced: the materials, the layer set, the
    // classification reference and the document reference.
    for id in [30, 31, 34, 41, 50] {
        assert!(kept.contains(&id), "referenced #{id} must be kept: {kept:?}");
    }
    // Plumbing nothing points at.
    for id in [2, 3, 4, 5, 6, 20, 32, 33, 40, 80, 81, 82] {
        assert!(!kept.contains(&id), "unreferenced #{id} must be dropped: {kept:?}");
    }

    // Every other table is untouched, and every id it names resolves.
    assert_eq!(rooted.relationships.len(), full.relationships.len());
    assert_eq!(rooted.property_sets.len(), full.property_sets.len());
    assert_eq!(rooted.materials.len(), full.materials.len());
    let dangling: Vec<u32> = ids_other_tables_name(&rooted).difference(&kept).copied().collect();
    assert!(dangling.is_empty(), "relations name ids the rooted table dropped: {dangling:?}");
}

/// A kept row is the SAME row the full table carries (id, type, every
/// attribute), in the same order: the rooted table is a subsequence of the
/// full one, never a re-derivation of it.
#[test]
fn issue_6034_rooted_rows_are_a_subsequence_of_the_full_table() {
    let full = extract_data_model(MIXED_IFC);
    let mut rooted = full.clone();
    DataModelEntities::Rooted.apply(&mut rooted);
    assert!(rooted.entities.len() < full.entities.len());

    let mut full_rows = full.entities.iter();
    for row in &rooted.entities {
        let same = full_rows.find(|f| f.entity_id == row.entity_id).expect("row in full table, in order");
        assert_eq!(
            serde_json::to_value(row).unwrap(),
            serde_json::to_value(same).unwrap(),
            "row #{} changed",
            row.entity_id
        );
    }
}

/// The default leaves the table exactly as extracted.
#[test]
fn issue_6034_all_is_a_no_op() {
    let full = extract_data_model(MIXED_IFC);
    let mut all = full.clone();
    DataModelEntities::All.apply(&mut all);
    assert_eq!(
        serde_json::to_value(&all.entities).unwrap(),
        serde_json::to_value(&full.entities).unwrap()
    );
}

/// #6034 on a real authoring-tool export: no relation of the rooted data model
/// names an id its entities table dropped, every row with a GlobalId is kept,
/// and every dropped row is one nothing points at. Skips when the fixture is
/// absent (`pnpm fixtures`).
#[test]
fn issue_6034_rooted_resolves_every_relation_on_a_real_model() {
    let content = ifc_lite_testkit::fixture_bytes_or_skip!("ara3d/AC20-FZK-Haus.ifc");
    let full = extract_data_model(&content);
    let mut rooted = full.clone();
    DataModelEntities::Rooted.apply(&mut rooted);

    let kept = ids(&rooted.entities);
    let named = ids_other_tables_name(&rooted);
    let dangling: Vec<u32> = named.difference(&kept).copied().collect();
    assert!(dangling.is_empty(), "relations name dropped ids: {dangling:?}");
    for row in &full.entities {
        if row.global_id.is_some() {
            assert!(kept.contains(&row.entity_id), "#{} has a GlobalId", row.entity_id);
        }
    }
    assert!(
        rooted.entities.len() * 10 < full.entities.len(),
        "most rows of this model are plumbing: {} of {}",
        rooted.entities.len(),
        full.entities.len()
    );
}

// ---------------------------------------------------------------------------
// #9582: the PRE-filtered path, which decides before any row exists.
// ---------------------------------------------------------------------------

use super::super::{extract_data_model_with, DataModelOptions};

/// A model whose spatial tree is disconnected and malformed, plus the rows
/// the pre-filter has to decide from the type name alone.
///
/// Every shape here is one the pre-filter could get wrong:
/// - `#70` is a storey no `IfcRelAggregates` ever names, so it is rescued as
///   an orphan root -- a spatial node reached through neither the project
///   walk nor a relationship the filter can see;
/// - `#71` is a space aggregated under one storey AND contained under
///   another (the cross-linked export of #3973);
/// - `#72` is a space placed by containment only (#1075), so it is promoted
///   to a node rather than a leaf element;
/// - `#76` is an `IfcSite` and `#77` an IFC4X3 `IfcFacilityPart` that NO
///   relationship names, so each becomes a spatial node reached only through
///   the orphan-fill loop's scan of the entities table -- the one spatial id
///   that is not a relationship endpoint;
/// - `#60` is a vendor type the IFC4 registry does not know, carrying a
///   GlobalId at slot 0 that only the extracted row can reveal;
/// - `#61` is a vendor type with NO GlobalId that nothing references, the row
///   the over-keeping pre-filter builds and the exact post-filter drops;
/// - `#29`/`#62` are IfcRoot subtypes whose GlobalId the file left null;
/// - `#30`-`#34`, `#41`, `#50` are the non-rooted association endpoints.
const SPATIAL_EDGE_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-9582 spatial edge cases'),'2;1');
FILE_NAME('edges.ifc','2026-11-11T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#10=IFCSITE('Site000000000000000001',$,'S',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);
#11=IFCBUILDING('Bldg00000000000000001',$,'B',$,$,$,$,$,.ELEMENT.,$,$,$);
#12=IFCBUILDINGSTOREY('Stor00000000000000001',$,'L1',$,$,$,$,$,.ELEMENT.,0.);
#13=IFCRELAGGREGATES('Agg0000000000000000001',$,$,$,#1,(#10));
#14=IFCRELAGGREGATES('Agg0000000000000000002',$,$,$,#10,(#11));
#15=IFCRELAGGREGATES('Agg0000000000000000003',$,$,$,#11,(#12));
#16=IFCRELCONTAINEDINSPATIALSTRUCTURE('Cnt0000000000000000001',$,$,$,(#28,#29),#12);
#20=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('F90'),$);
#21=IFCPROPERTYSET('Pset000000000000000001',$,'Pset_WallCommon',$,(#20));
#22=IFCRELDEFINESBYPROPERTIES('Def0000000000000000001',$,$,$,(#28),#21);
#23=IFCQUANTITYAREA('NetArea',$,$,12.5,$);
#24=IFCELEMENTQUANTITY('Qset000000000000000001',$,'Qto_WallBaseQuantities',$,$,(#23));
#25=IFCRELDEFINESBYPROPERTIES('Def0000000000000000002',$,$,$,(#28),#24);
#28=IFCWALL('Wall00000000000000001',$,'W1',$,$,$,$,$,$);
#29=IFCWALL($,$,'NoGuid',$,$,$,$,$,$);
#30=IFCMATERIAL('Concrete',$,'Mineral');
#31=IFCMATERIAL('Insulation',$,$);
#32=IFCMATERIALLAYER(#30,200.,.F.,'Core',$,'load-bearing',$);
#33=IFCMATERIALLAYER(#31,50.,.T.,'Insul',$,$,$);
#34=IFCMATERIALLAYERSET((#32,#33),'WallSet',$);
#35=IFCRELASSOCIATESMATERIAL('Mat0000000000000000001',$,$,$,(#28),#34);
#40=IFCCLASSIFICATION('Uniclass 2015','2',$,'Uniclass 2015',$,$,$);
#41=IFCCLASSIFICATIONREFERENCE('https://uniclass.example','EF_25_10_25','Walls',#40,$,$);
#42=IFCRELASSOCIATESCLASSIFICATION('Cls0000000000000000001',$,$,$,(#28),#41);
#50=IFCDOCUMENTREFERENCE('https://docs.example/spec','DOC-001','Wall spec',$,$);
#51=IFCRELASSOCIATESDOCUMENT('Doc0000000000000000001',$,$,$,(#28),#50);
#60=IFCVENDORWIDGET('Vend00000000000000001',$,'Widget',$,$,$,$,$,$);
#61=IFCVENDORSCRAP($,$,'Scrap',$,$,$,$,$,$);
#62=IFCFURNITURE($,$,'NullGuidFurniture',$,$,$,$,$,$);
#63=IFCRELCONTAINEDINSPATIALSTRUCTURE('Cnt0000000000000000002',$,$,$,(#60,#62),#70);
#70=IFCBUILDINGSTOREY('Orph00000000000000001',$,'Orphan',$,$,$,$,$,.ELEMENT.,3.);
#71=IFCSPACE('Spac00000000000000001',$,'CrossLinked',$,$,$,$,$,.ELEMENT.,$,$);
#72=IFCSPACE('Spac00000000000000002',$,'ContainedOnly',$,$,$,$,$,.ELEMENT.,$,$);
#73=IFCRELAGGREGATES('Agg0000000000000000004',$,$,$,#12,(#71));
#74=IFCRELCONTAINEDINSPATIALSTRUCTURE('Cnt0000000000000000003',$,$,$,(#71),#70);
#75=IFCRELCONTAINEDINSPATIALSTRUCTURE('Cnt0000000000000000004',$,$,$,(#72),#12);
#76=IFCSITE('Isol00000000000000001',$,'IsolatedSite',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);
#77=IFCFACILITYPART('Facp00000000000000001',$,'IFC4X3 part',$,$,$,$,$,$,$,$);
#80=IFCPOLYLOOP((#4,#81,#82));
#81=IFCCARTESIANPOINT((1.,0.,0.));
#82=IFCCARTESIANPOINT((0.,1.,0.));
ENDSEC;
END-ISO-10303-21;
"#;

/// A model with NO `IfcProject`, so the spatial walk never starts and every
/// spatial node is rescued as an orphan root.
const NO_PROJECT_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-9582 projectless'),'2;1');
FILE_NAME('noproject.ifc','2026-11-11T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#12=IFCBUILDINGSTOREY('Stor00000000000000001',$,'L1',$,$,$,$,$,.ELEMENT.,0.);
#16=IFCRELCONTAINEDINSPATIALSTRUCTURE('Cnt0000000000000000001',$,$,$,(#28),#12);
#28=IFCWALL('Wall00000000000000001',$,'W1',$,$,$,$,$,$);
#30=IFCMATERIAL('Concrete',$,'Mineral');
#34=IFCMATERIALLAYERSET((#32,#33),'WallSet',$);
#32=IFCMATERIALLAYER(#30,200.,.F.,'Core',$,$,$);
#33=IFCMATERIALLAYER(#30,50.,.T.,'Insul',$,$,$);
#35=IFCRELASSOCIATESMATERIAL('Mat0000000000000000001',$,$,$,(#28),#34);
#80=IFCPOLYLOOP((#4,#81,#82));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#81=IFCCARTESIANPOINT((1.,0.,0.));
#82=IFCCARTESIANPOINT((0.,1.,0.));
ENDSEC;
END-ISO-10303-21;
"#;

/// Every table of a data model as JSON, so two models can be compared whole.
/// `DataModel` is not `Serialize`; each of its tables is.
fn tables_json(dm: &DataModel) -> serde_json::Value {
    serde_json::json!({
        "entities": dm.entities,
        "property_sets": dm.property_sets,
        "quantity_sets": dm.quantity_sets,
        "relationships": dm.relationships,
        "classifications": dm.classifications,
        "materials": dm.materials,
        "documents": dm.documents,
        "spatial_hierarchy": dm.spatial_hierarchy,
        "refused": dm.refused,
    })
}

/// The pre-filtered path builds the SAME data model the post-filtered one
/// does -- every table, not just the entities it narrows.
///
/// This is the whole contract of the filtered path: it is only ever a cheaper
/// way to reach the same model. Three of its tables are reached by a route
/// the post-filter never takes:
///
/// - `spatial_hierarchy` is built FROM the entities table, so a narrowed
///   table is the builder's input here and the full one is its input there.
///   The post-filter's retained set also reads this table back, which the
///   pre-filter cannot; `metadata_jobs` carries the argument for why it does
///   not need to, and this asserts it.
/// - the association tables name non-rooted endpoints (`IfcMaterial`,
///   `IfcMaterialLayerSet`, `IfcClassificationReference`,
///   `IfcDocumentReference`) that carry no GlobalId and that no other table
///   points at, so they are kept only because that pass ran first.
/// - `refused` is set by that same pass when a table goes over budget.
fn assert_paths_agree(source: &[u8], what: &str) {
    let mut post = extract_data_model(source);
    let total_before = post.total_entities;
    DataModelEntities::Rooted.apply(&mut post);
    let pre = extract_data_model_with(source, DataModelOptions::for_entities(DataModelEntities::Rooted));
    assert_eq!(tables_json(&pre), tables_json(&post), "{what}: the two paths disagree");
    assert_eq!(
        pre.total_entities, total_before,
        "{what}: total_entities must stay the instance count, not the kept-row count"
    );
    assert!(
        pre.total_entities >= pre.entities.len(),
        "{what}: more rows kept than instances scanned"
    );
    // Nothing the model names is missing from the table it built.
    let kept = ids(&pre.entities);
    let dangling: Vec<u32> = ids_other_tables_name(&pre).difference(&kept).copied().collect();
    assert!(dangling.is_empty(), "{what}: relations name dropped ids: {dangling:?}");
}

/// #9582: synthetic models covering every case the pre-filter decides from
/// the type name alone -- null GlobalId, vendor types, non-rooted association
/// endpoints, and disconnected or malformed spatial structure.
#[test]
fn issue_9582_prefilter_matches_postfilter_on_edge_cases() {
    assert_paths_agree(MIXED_IFC.as_bytes(), "MIXED_IFC");
    assert_paths_agree(SPATIAL_EDGE_IFC.as_bytes(), "SPATIAL_EDGE_IFC");
    assert_paths_agree(NO_PROJECT_IFC.as_bytes(), "NO_PROJECT_IFC");
    assert_paths_agree(b"", "empty input");
}

/// #9582 on real authoring-tool exports, where the shapes above occur in
/// numbers and alongside each other. Skips when the fixtures are absent
/// (`pnpm fixtures`).
#[test]
fn issue_9582_prefilter_matches_postfilter_on_real_models() {
    for name in [
        "ara3d/AC20-FZK-Haus.ifc",
        "ara3d/duplex.ifc",
        "ara3d/example.ifc",
    ] {
        let Some(content) = ifc_lite_testkit::fixture_bytes(name) else {
            continue;
        };
        assert_paths_agree(&content, name);
    }
}

/// The rows the pre-filter decides WITHOUT a GlobalId to look at, named
/// individually so a regression says which rule moved rather than only that
/// two paths disagree.
#[test]
fn issue_9582_prefilter_keeps_the_rows_the_exact_rule_keeps() {
    let pre = extract_data_model_with(
        SPATIAL_EDGE_IFC.as_bytes(),
        DataModelOptions::for_entities(DataModelEntities::Rooted),
    );
    let kept = ids(&pre.entities);

    // A vendor type the IFC4 registry does not list: the pre-filter cannot
    // tell #60 from #61, so it builds both and the exact rule then keeps the
    // one whose slot 0 held a GlobalId.
    assert!(kept.contains(&60), "vendor type with a GlobalId must be kept: {kept:?}");
    assert!(!kept.contains(&61), "vendor type without one must be dropped: {kept:?}");
    // IfcRoot subtypes whose GlobalId the file left null are still objects.
    for id in [29, 62] {
        assert!(kept.contains(&id), "null-GlobalId root #{id} must be kept: {kept:?}");
    }
    // Non-rooted association endpoints, kept only because the association
    // pass runs before the filter.
    for id in [30, 31, 34, 41, 50] {
        assert!(kept.contains(&id), "association endpoint #{id} must be kept: {kept:?}");
    }
    // Spatial nodes the project walk never reaches: an orphan storey, a
    // cross-linked space, a containment-promoted space, and two that no
    // relationship names at all (one IFC4, one IFC4X3-only, so the IFC4
    // registry does not list it).
    for id in [70, 71, 72, 76, 77] {
        assert!(kept.contains(&id), "spatial node #{id} must be kept: {kept:?}");
    }
    // Plumbing nothing points at.
    for id in [4, 5, 20, 23, 32, 33, 40, 80, 81, 82] {
        assert!(!kept.contains(&id), "unreferenced #{id} must be dropped: {kept:?}");
    }
}

/// The kept rows stay in FILE order, and each is the row the unfiltered table
/// carries -- the pre-filtered table is a subsequence of the full one, never
/// a re-derivation of it.
#[test]
fn issue_9582_prefiltered_rows_are_a_subsequence_in_file_order() {
    let full = extract_data_model(SPATIAL_EDGE_IFC);
    let pre = extract_data_model_with(
        SPATIAL_EDGE_IFC.as_bytes(),
        DataModelOptions::for_entities(DataModelEntities::Rooted),
    );
    assert!(pre.entities.len() < full.entities.len());

    let mut full_rows = full.entities.iter();
    for row in &pre.entities {
        let same = full_rows
            .find(|f| f.entity_id == row.entity_id)
            .expect("row present in the full table, and in the same order");
        assert_eq!(
            serde_json::to_value(row).unwrap(),
            serde_json::to_value(same).unwrap(),
            "row #{} changed",
            row.entity_id
        );
    }
}

/// The default path is untouched: `All` builds the same model it always did,
/// and `total_entities` equals the row count exactly when nothing was
/// narrowed away.
#[test]
fn issue_9582_all_is_unchanged() {
    for source in [MIXED_IFC, SPATIAL_EDGE_IFC, NO_PROJECT_IFC] {
        let plain = extract_data_model(source);
        let explicit =
            extract_data_model_with(source, DataModelOptions::for_entities(DataModelEntities::All));
        assert_eq!(tables_json(&plain), tables_json(&explicit));
        assert_eq!(plain.total_entities, plain.entities.len());
    }
}

/// Switching the optional tables off drops exactly those two tables and
/// changes nothing else -- including the entities table, which the property
/// and quantity ids feed into the rooted filter.
#[test]
fn issue_9582_optional_tables_drop_only_themselves() {
    let full = extract_data_model(MIXED_IFC);
    assert!(!full.property_sets.is_empty(), "the fixture must have a pset to drop");
    let without = extract_data_model_with(
        MIXED_IFC,
        DataModelOptions { entities: DataModelEntities::All, properties: false, quantities: false },
    );
    assert!(without.property_sets.is_empty());
    assert!(without.quantity_sets.is_empty());
    assert_eq!(
        serde_json::to_value(&without.entities).unwrap(),
        serde_json::to_value(&full.entities).unwrap()
    );
    assert_eq!(
        serde_json::to_value(&without.spatial_hierarchy).unwrap(),
        serde_json::to_value(&full.spatial_hierarchy).unwrap()
    );
}
