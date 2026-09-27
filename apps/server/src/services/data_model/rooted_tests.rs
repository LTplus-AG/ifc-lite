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

/// The wire names and the default. `all` is the default so a request that
/// predates #6034 deserializes to exactly the old behaviour.
#[test]
fn issue_6034_query_values() {
    #[derive(serde::Deserialize)]
    struct Q {
        #[serde(default)]
        data_model_entities: DataModelEntities,
    }
    let parse = |s: &str| {
        let uri: axum::http::Uri = format!("/x?{s}").parse().unwrap();
        axum::extract::Query::<Q>::try_from_uri(&uri).map(|q| q.0.data_model_entities)
    };
    assert_eq!(parse("").unwrap(), DataModelEntities::All);
    assert_eq!(parse("data_model_entities=all").unwrap(), DataModelEntities::All);
    assert_eq!(parse("data_model_entities=rooted").unwrap(), DataModelEntities::Rooted);
    assert!(parse("data_model_entities=objects").is_err(), "an unknown value is refused, not defaulted");
}

/// #6034 on a real authoring-tool export: no relation of the rooted data model
/// names an id its entities table dropped, every row with a GlobalId is kept,
/// and every dropped row is one nothing points at. Skips when the fixture is
/// absent (`pnpm fixtures`).
#[test]
fn issue_6034_rooted_resolves_every_relation_on_a_real_model() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/models/ara3d/AC20-FZK-Haus.ifc");
    let Ok(content) = std::fs::read(&path) else {
        eprintln!("skipping: {} absent; run `pnpm fixtures`", path.display());
        return;
    };
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
