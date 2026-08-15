// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

/// IFC4 model (millimetre units) with a wall carrying a two-layer material
/// set, a Uniclass classification reference, and a document reference — one
/// of each association type (issue #900).
const ASSOCIATIONS_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-900 associations fixture'),'2;1');
FILE_NAME('assoc.ifc','2026-06-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#28=IFCWALL('Wall00000000000000001',$,'W1',$,$,$,$,$,$);
/* Material layer set: 200mm Concrete + 50mm ventilated Insulation */
#30=IFCMATERIAL('Concrete',$,$);
#31=IFCMATERIAL('Insulation',$,$);
#32=IFCMATERIALLAYER(#30,200.,.F.,'Core',$,$,$);
#33=IFCMATERIALLAYER(#31,50.,.T.,'Insul',$,$,$);
#34=IFCMATERIALLAYERSET((#32,#33),'WallSet',$);
#35=IFCRELASSOCIATESMATERIAL('Mat0000000000000000001',$,$,$,(#28),#34);
/* Classification */
#40=IFCCLASSIFICATION('Uniclass 2015','2',$,'Uniclass 2015',$,$,$);
#41=IFCCLASSIFICATIONREFERENCE('https://uniclass.example','EF_25_10_25','Walls',#40,$,$);
#42=IFCRELASSOCIATESCLASSIFICATION('Cls0000000000000000001',$,$,$,(#28),#41);
/* Document */
#50=IFCDOCUMENTREFERENCE('https://docs.example/spec','DOC-001','Wall spec',$,$);
#51=IFCRELASSOCIATESDOCUMENT('Doc0000000000000000001',$,$,$,(#28),#50);
/* Column with a material constituent set */
#60=IFCCOLUMN('Col0000000000000000001',$,'C1',$,$,$,$,$,$);
#61=IFCMATERIAL('Steel',$,$);
#62=IFCMATERIALCONSTITUENT('Core',$,#61,$,'load-bearing');
#63=IFCMATERIALCONSTITUENTSET('ColSet',$,(#62));
#64=IFCRELASSOCIATESMATERIAL('Mat0000000000000000002',$,$,$,(#60),#63);
/* Beam with a material profile set */
#70=IFCBEAM('Bem0000000000000000001',$,'B1',$,$,$,$,$,$);
#71=IFCMATERIAL('Timber',$,$);
#72=IFCMATERIALPROFILE('Flange',$,#71,$,$,$);
#73=IFCMATERIALPROFILESET('BeamSet',$,(#72),$);
#74=IFCRELASSOCIATESMATERIAL('Mat0000000000000000003',$,$,$,(#70),#73);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn extracts_classification_material_and_document_associations() {
    let dm = extract_data_model(ASSOCIATIONS_IFC);

    // Classification: one reference assigned to the wall (#28).
    assert_eq!(dm.classifications.len(), 1, "expected one classification");
    let c = &dm.classifications[0];
    assert_eq!(c.element_id, 28);
    assert_eq!(c.system_name.as_deref(), Some("Uniclass 2015"));
    assert_eq!(c.identification.as_deref(), Some("EF_25_10_25"));
    assert_eq!(c.name.as_deref(), Some("Walls"));

    // Materials: the wall (#28) has two layers, thickness in metres (mm * 0.001).
    let mut layers: Vec<_> = dm
        .materials
        .iter()
        .filter(|m| m.element_id == 28)
        .cloned()
        .collect();
    layers.sort_by_key(|m| m.layer_index);
    assert_eq!(layers.len(), 2, "expected two wall layers");
    assert_eq!(layers[0].element_id, 28);
    assert_eq!(layers[0].set_name.as_deref(), Some("WallSet"));
    assert_eq!(layers[0].material_name, "Concrete");
    assert!(
        (layers[0].thickness.unwrap() - 0.2).abs() < 1e-9,
        "200mm -> 0.2m"
    );
    assert_eq!(layers[0].is_ventilated, Some(false));
    assert_eq!(layers[1].material_name, "Insulation");
    assert!(
        (layers[1].thickness.unwrap() - 0.05).abs() < 1e-9,
        "50mm -> 0.05m"
    );
    assert_eq!(layers[1].is_ventilated, Some(true));

    // Document.
    assert_eq!(dm.documents.len(), 1, "expected one document");
    let d = &dm.documents[0];
    assert_eq!(d.element_id, 28);
    assert_eq!(d.identification.as_deref(), Some("DOC-001"));
    assert_eq!(d.name.as_deref(), Some("Wall spec"));
    assert_eq!(d.location.as_deref(), Some("https://docs.example/spec"));

    // Material constituent set on the column (#60) — constituents read from
    // attribute 2, set name preserved from attribute 0.
    let column_mats: Vec<_> = dm.materials.iter().filter(|m| m.element_id == 60).collect();
    assert_eq!(
        column_mats.len(),
        1,
        "expected one constituent for the column"
    );
    assert_eq!(column_mats[0].material_name, "Steel");
    assert_eq!(column_mats[0].set_name.as_deref(), Some("ColSet"));

    // The IfcRelAssociates* family must also land in the generic relationship
    // graph (relating = the material/classification/document, related = element).
    let has_rel = |ty: &str, relating: u32, related: u32| {
        dm.relationships.iter().any(|r| {
            r.rel_type.eq_ignore_ascii_case(ty)
                && r.relating_id == relating
                && r.related_id == related
        })
    };
    assert!(
        has_rel("IFCRELASSOCIATESCLASSIFICATION", 41, 28),
        "classification association missing from relationships"
    );
    assert!(
        has_rel("IFCRELASSOCIATESDOCUMENT", 50, 28),
        "document association missing from relationships"
    );
    assert!(
        has_rel("IFCRELASSOCIATESMATERIAL", 34, 28),
        "material association missing from relationships"
    );

    // Material profile set on the beam (#70).
    let beam_mats: Vec<_> = dm.materials.iter().filter(|m| m.element_id == 70).collect();
    assert_eq!(beam_mats.len(), 1, "expected one profile for the beam");
    assert_eq!(beam_mats[0].material_name, "Timber");
    assert_eq!(beam_mats[0].set_name.as_deref(), Some("BeamSet"));
}

/// IFC4 model exercising TYPE-level parity (issue #1751): an IfcWallType
/// whose HasPropertySets carries a pset (string / boolean / real / integer)
/// and a Qto, two walls bound via IfcRelDefinesByType, and one instance pset.
const TYPE_PARITY_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('Proj0000000000000000001',$,'P',$,$,$,$,$,$);
#100=IFCWALL('Wall00000000000000001A',$,'W-A','South wall','Basic Wall',$,$,'T-100',.SOLIDWALL.);
#110=IFCWALL('Wall00000000000000001B',$,'W-B',$,$,$,$,$,.PARTITIONING.);
#200=IFCWALLTYPE('Type00000000000000001A',$,'WT-Std',$,'NotObjectType',(#210,#220),$,$,$,.STANDARD.);
#300=IFCSITE('Site000000000000000001A',$,'S','site desc',$,$,$,'LONG-NAME',.ELEMENT.,$,$,$,$,$);
#210=IFCPROPERTYSET('Pset00000000000000001A',$,'Pset_WallCommon',$,(#211,#212,#213,#214,#215));
#211=IFCPROPERTYSINGLEVALUE('Manufacturer',$,IFCLABEL('ACME'),$);
#212=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);
#213=IFCPROPERTYSINGLEVALUE('ThermalTransmittance',$,IFCREAL(0.24),$);
#214=IFCPROPERTYSINGLEVALUE('Layers',$,IFCINTEGER(3),$);
#215=IFCPROPERTYENUMERATEDVALUE('AcousticRating',$,(IFCLABEL('R1'),IFCLABEL('R2')),$);
#220=IFCELEMENTQUANTITY('Qset00000000000000001A',$,'Qto_WallBaseQuantities',$,$,(#221));
#221=IFCQUANTITYLENGTH('Width',$,$,200.);
#230=IFCRELDEFINESBYTYPE('Rdbt00000000000000001A',$,$,$,(#100,#110),#200);
#250=IFCPROPERTYSET('Pset00000000000000002A',$,'Pset_WallCommon',$,(#251,#252,#253));
#251=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('REI 120'),$);
#252=IFCPROPERTYBOUNDEDVALUE('LoadCapacity',$,IFCFORCEMEASURE(8.),IFCFORCEMEASURE(2.),$,IFCFORCEMEASURE(5.));
#253=IFCPROPERTYTABLEVALUE('Deflection',$,(IFCREAL(1.),IFCREAL(2.)),(IFCREAL(10.),IFCREAL(20.)),$,$,$,$);
#260=IFCRELDEFINESBYPROPERTIES('Rdbp00000000000000001A',$,$,$,(#100),#250);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn extracts_type_relationship_and_resolves_typed_property_values() {
    let dm = extract_data_model(TYPE_PARITY_IFC);

    // IfcRelDefinesByType survives (was dropped by the `_ => (4,5)` default):
    // relating = type #200, related = each wall.
    let dbt = |related: u32| {
        dm.relationships.iter().any(|r| {
            r.rel_type.eq_ignore_ascii_case("IFCRELDEFINESBYTYPE")
                && r.relating_id == 200
                && r.related_id == related
        })
    };
    assert!(dbt(100), "DefinesByType #200->#100 missing");
    assert!(dbt(110), "DefinesByType #200->#110 missing");

    // Type HasPropertySets are attached to the type via synthetic edges
    // (relating = set, related = type).
    let type_link = |set: u32| {
        dm.relationships.iter().any(|r| {
            r.rel_type == "TYPEHASPROPERTYSETS" && r.relating_id == set && r.related_id == 200
        })
    };
    assert!(type_link(210), "TYPEHASPROPERTYSETS #210->#200 missing");
    assert!(
        type_link(220),
        "TYPEHASPROPERTYSETS #220->#200 missing (qset)"
    );

    // Typed property values resolve to canonical strings + kinds + data_type
    // (no more Debug garbage / "unknown").
    let pset = dm
        .property_sets
        .iter()
        .find(|p| p.pset_id == 210)
        .expect("type pset #210 extracted");
    let prop = |name: &str| {
        pset.properties
            .iter()
            .find(|p| p.property_name == name)
            .unwrap()
    };

    let m = prop("Manufacturer");
    assert_eq!(m.property_value, "ACME");
    assert_eq!(m.property_type, "string");
    assert_eq!(m.data_type.as_deref(), Some("IFCLABEL"));

    let ext = prop("IsExternal");
    assert_eq!(ext.property_value, "true");
    assert_eq!(ext.property_type, "boolean");
    assert_eq!(ext.data_type.as_deref(), Some("IFCBOOLEAN"));

    let u = prop("ThermalTransmittance");
    assert_eq!(u.property_value, "0.24");
    assert_eq!(u.property_type, "real");
    assert_eq!(u.data_type.as_deref(), Some("IFCREAL"));

    // Enumerated value → joined display string (mirrors WASM `values.join(', ')`)
    // + the candidate array for IDS any-match checks (issue #1766).
    let ar = prop("AcousticRating");
    assert_eq!(ar.property_value, "R1, R2");
    assert_eq!(ar.property_type, "string");
    assert_eq!(
        ar.values.as_deref(),
        Some(&["R1".to_string(), "R2".to_string()][..])
    );

    let c = prop("Layers");
    assert_eq!(c.property_value, "3");
    assert_eq!(c.property_type, "integer");
    assert_eq!(c.data_type.as_deref(), Some("IFCINTEGER"));

    // Instance pset value also resolves (same code path); single values carry
    // no candidate array.
    let inst = dm.property_sets.iter().find(|p| p.pset_id == 250).unwrap();
    let iprop = |name: &str| {
        inst.properties
            .iter()
            .find(|p| p.property_name == name)
            .unwrap()
    };
    let fr = iprop("FireRating");
    assert_eq!(fr.property_value, "REI 120");
    assert_eq!(fr.property_type, "string");
    assert_eq!(fr.values, None);

    // Bounded: display "setPoint [lower – upper]", candidates deduped
    // lower/upper/setPoint, measure tag from the typed wrappers (#1766).
    let lc = iprop("LoadCapacity");
    assert_eq!(lc.property_value, "5 [2 \u{2013} 8]");
    assert_eq!(lc.data_type.as_deref(), Some("IFCFORCEMEASURE"));
    assert_eq!(
        lc.values.as_deref(),
        Some(&["2".to_string(), "8".to_string(), "5".to_string()][..])
    );

    // Table: defining-then-defined candidates, display "Table (N rows)".
    let df = iprop("Deflection");
    assert_eq!(df.property_value, "Table (2 rows)");
    assert_eq!(
        df.values.as_deref(),
        Some(
            &[
                "1".to_string(),
                "2".to_string(),
                "10".to_string(),
                "20".to_string()
            ][..]
        )
    );
}

#[test]
fn associations_empty_without_relationships() {
    let plain = r#"ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,$,$);
#28=IFCWALL('Wall00000000000000001',$,'W1',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
"#;
    let dm = extract_data_model(plain);
    assert!(dm.classifications.is_empty());
    assert!(dm.materials.is_empty());
    assert!(dm.documents.is_empty());
}

/// Root attributes are extracted at the SCHEMA-REGISTRY positions the WASM
/// path resolves them (issue #1765) — including the traps: IfcSite attr 7 is
/// LongName (never Tag), IfcWallType attr 4 is ApplicableOccurrence (never
/// ObjectType), and CompositionType enums must not leak into PredefinedType.
#[test]
fn extracts_root_attributes_at_schema_positions() {
    let dm = extract_data_model(TYPE_PARITY_IFC);
    let e = |id: u32| dm.entities.iter().find(|e| e.entity_id == id).unwrap();

    let wall_a = e(100);
    assert_eq!(wall_a.description.as_deref(), Some("South wall"));
    assert_eq!(wall_a.object_type.as_deref(), Some("Basic Wall"));
    assert_eq!(wall_a.tag.as_deref(), Some("T-100"));
    assert_eq!(wall_a.predefined_type.as_deref(), Some("SOLIDWALL"));

    // Unset slots stay None; the enum still resolves.
    let wall_b = e(110);
    assert_eq!(wall_b.description, None);
    assert_eq!(wall_b.object_type, None);
    assert_eq!(wall_b.tag, None);
    assert_eq!(wall_b.predefined_type.as_deref(), Some("PARTITIONING"));

    // IfcWallType: attr 4 is ApplicableOccurrence — must NOT surface as
    // ObjectType; Tag slot is $; PredefinedType is at index 9.
    let wall_type = e(200);
    assert_eq!(wall_type.object_type, None);
    assert_eq!(wall_type.tag, None);
    assert_eq!(wall_type.predefined_type.as_deref(), Some("STANDARD"));

    // IfcSite: Description resolves, attr 7 (LongName) must NOT surface as
    // Tag, and CompositionType (.ELEMENT.) must NOT surface as PredefinedType.
    let site = e(300);
    assert_eq!(site.description.as_deref(), Some("site desc"));
    assert_eq!(site.tag, None);
    assert_eq!(site.predefined_type, None);
}

/// IfcRelVoidsElement / IfcRelFillsElement both carry a SINGLE related ref
/// (not a list) at attribute 5, so the generic list-based path dropped them.
/// A wall (#10) is voided by an opening (#20), which is filled by a door (#30).
const VOID_FILL_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#10=IFCWALL('Wall00000000000000001',$,'W1',$,$,$,$,$,$);
#20=IFCOPENINGELEMENT('Open00000000000000001',$,'O1',$,$,$,$,$,$);
#30=IFCDOOR('Door00000000000000001',$,'D1',$,$,$,$,$,$,$,$,$);
#40=IFCRELVOIDSELEMENT('Voi0000000000000000001',$,$,$,#10,#20);
#50=IFCRELFILLSELEMENT('Fil0000000000000000001',$,$,$,#20,#30);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn extracts_voids_and_fills_single_ref_relationships() {
    let dm = extract_data_model(VOID_FILL_IFC);
    let has_rel = |ty: &str, relating: u32, related: u32| {
        dm.relationships.iter().any(|r| {
            r.rel_type.eq_ignore_ascii_case(ty)
                && r.relating_id == relating
                && r.related_id == related
        })
    };
    // RelVoidsElement: RelatingBuildingElement=#10 (wall), RelatedOpeningElement=#20.
    assert!(
        has_rel("IFCRELVOIDSELEMENT", 10, 20),
        "voids relationship (wall -> opening) missing: {:?}",
        dm.relationships
    );
    // RelFillsElement: RelatingOpeningElement=#20, RelatedBuildingElement=#30 (door).
    assert!(
        has_rel("IFCRELFILLSELEMENT", 20, 30),
        "fills relationship (opening -> door) missing: {:?}",
        dm.relationships
    );
}

/// Malformed voids/fills rows must be DROPPED, not panic and not emit garbage:
/// `$` in place of either ref (missing attr) and a LIST where a single ref
/// belongs (`get_ref` returns `None` for both, so `?` bails).
const MALFORMED_VOID_FILL_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#10=IFCWALL('Wall00000000000000001',$,'W1',$,$,$,$,$,$);
#20=IFCOPENINGELEMENT('Open00000000000000001',$,'O1',$,$,$,$,$,$);
#40=IFCRELVOIDSELEMENT('Voi0000000000000000001',$,$,$,$,#20);
#41=IFCRELVOIDSELEMENT('Voi0000000000000000002',$,$,$,#10,$);
#42=IFCRELVOIDSELEMENT('Voi0000000000000000003',$,$,$,#10,(#20));
#50=IFCRELFILLSELEMENT('Fil0000000000000000001',$,$,$,(#20),#10);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn drops_voids_and_fills_rows_with_missing_or_list_refs() {
    let dm = extract_data_model(MALFORMED_VOID_FILL_IFC);
    assert!(
        !dm.relationships.iter().any(|r| {
            r.rel_type.eq_ignore_ascii_case("IFCRELVOIDSELEMENT")
                || r.rel_type.eq_ignore_ascii_case("IFCRELFILLSELEMENT")
        }),
        "malformed voids/fills rows must be dropped, got: {:?}",
        dm.relationships
    );
}

/// Full Project -> Site -> Building -> Storey -> Space spatial chain (via
/// IFCRELAGGREGATES), with one element contained directly at EACH of the four
/// levels (via IFCRELCONTAINEDINSPATIALSTRUCTURE): a furnishing element in the
/// site, a door in the building, a wall in the storey, a chair in the space.
/// This pins `build_spatial_hierarchy`'s parent/level/path bookkeeping and the
/// four-way element_to_{site,building,storey,space} bucketing — none of which
/// was previously exercised end-to-end (only storey elevation was tested).
const SPATIAL_CHAIN_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('Proj0000000000000000001',$,'MyProject',$,$,$,$,$,$);
#2=IFCSITE('Site0000000000000000001',$,'MySite',$,$,$,$,$,$,$,$,$,$,$);
#3=IFCBUILDING('Bldg0000000000000000001',$,'MyBuilding',$,$,$,$,$,$,$,$,$);
#4=IFCBUILDINGSTOREY('Stor0000000000000000001',$,'MyStorey',$,$,$,$,$,$,$);
#5=IFCSPACE('Spac0000000000000000001',$,'MySpace',$,$,$,$,$,$,$);
#10=IFCFURNISHINGELEMENT('Furn0000000000000000001',$,'SiteFurniture',$,$,$,$,$);
#11=IFCDOOR('Door0000000000000000001',$,'BuildingDoor',$,$,$,$,$,$,$,$,$);
#12=IFCWALL('Wall0000000000000000001',$,'StoreyWall',$,$,$,$,$,$);
#13=IFCFURNISHINGELEMENT('Chai0000000000000000001',$,'SpaceChair',$,$,$,$,$);
#100=IFCRELAGGREGATES('Agg00000000000000000001',$,$,$,#1,(#2));
#101=IFCRELAGGREGATES('Agg00000000000000000002',$,$,$,#2,(#3));
#102=IFCRELAGGREGATES('Agg00000000000000000003',$,$,$,#3,(#4));
#103=IFCRELAGGREGATES('Agg00000000000000000004',$,$,$,#4,(#5));
#110=IFCRELCONTAINEDINSPATIALSTRUCTURE('Con00000000000000000001',$,$,$,(#10),#2);
#111=IFCRELCONTAINEDINSPATIALSTRUCTURE('Con00000000000000000002',$,$,$,(#11),#3);
#112=IFCRELCONTAINEDINSPATIALSTRUCTURE('Con00000000000000000003',$,$,$,(#12),#4);
#113=IFCRELCONTAINEDINSPATIALSTRUCTURE('Con00000000000000000004',$,$,$,(#13),#5);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn builds_spatial_hierarchy_with_correct_parent_level_and_path() {
    let dm = extract_data_model(SPATIAL_CHAIN_IFC);
    let sh = &dm.spatial_hierarchy;

    assert_eq!(sh.project_id, 1, "project id must be #1");
    let node = |id: u32| sh.nodes.iter().find(|n| n.entity_id == id).unwrap();

    let project = node(1);
    assert_eq!(project.parent_id, 0);
    assert_eq!(project.level, 0);
    assert_eq!(project.path, "MyProject");
    assert_eq!(project.children_ids, vec![2]);

    let site = node(2);
    assert_eq!(site.parent_id, 1);
    assert_eq!(site.level, 1);
    assert_eq!(site.path, "MyProject/MySite");
    assert_eq!(site.children_ids, vec![3]);

    let building = node(3);
    assert_eq!(building.parent_id, 2);
    assert_eq!(building.level, 2);
    assert_eq!(building.path, "MyProject/MySite/MyBuilding");

    let storey = node(4);
    assert_eq!(storey.parent_id, 3);
    assert_eq!(storey.level, 3);
    assert_eq!(storey.path, "MyProject/MySite/MyBuilding/MyStorey");

    let space = node(5);
    assert_eq!(space.parent_id, 4);
    assert_eq!(space.level, 4);
    assert_eq!(space.path, "MyProject/MySite/MyBuilding/MyStorey/MySpace");
}

/// Exercises the two DocumentAssociation paths never covered by
/// `extracts_classification_material_and_document_associations` (which only
/// hits a fully-populated `IfcDocumentReference` with no `ReferencedDocument`):
/// (1) `IfcRelAssociatesDocument` pointing straight at an
/// `IfcDocumentInformation` (attribute layout Identification/Name/Description/
/// Location — description and location are NOT in attribute order, the exact
/// index-swap trap), and (2) an `IfcDocumentReference` with some fields blank
/// backfilled from its `ReferencedDocument`, where already-set reference
/// fields (Identification, Location) must NOT be overwritten by the info's
/// values, even though the info carries different values at those slots.
const DOCUMENT_PATHS_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('Proj0000000000000000001',$,'P',$,$,$,$,$,$);
#28=IFCWALL('Wall00000000000000001',$,'W1',$,$,$,$,$,$);
#29=IFCCOLUMN('Col0000000000000000001',$,'C1',$,$,$,$,$,$);
/* (1) Direct IfcDocumentInformation reference. */
#50=IFCDOCUMENTINFORMATION('INFO-ID','InfoName','InfoDesc','http://info.example',$,$,$,$,$,$,$,$,$);
#51=IFCRELASSOCIATESDOCUMENT('Doc0000000000000000002',$,$,$,(#28),#50);
/* (2) IfcDocumentReference with Name/Description blank, Identification and
   Location already set — backfill must fill Name/Description ONLY, from the
   correct info slots (1 and 2), and must leave Identification/Location alone
   even though the info has different values at slots 0 and 3. */
#60=IFCDOCUMENTREFERENCE('http://ref.example','REF-ID',$,$,#61);
#61=IFCDOCUMENTINFORMATION('OTHER-ID','BackfilledName','BackfilledDesc','http://other.example',$,$,$,$,$,$,$,$,$);
#62=IFCRELASSOCIATESDOCUMENT('Doc0000000000000000003',$,$,$,(#29),#60);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn resolves_document_information_directly_at_its_own_attribute_layout() {
    let dm = extract_data_model(DOCUMENT_PATHS_IFC);
    let d = dm
        .documents
        .iter()
        .find(|d| d.element_id == 28)
        .expect("wall document association");
    assert_eq!(d.identification.as_deref(), Some("INFO-ID"));
    assert_eq!(d.name.as_deref(), Some("InfoName"));
    assert_eq!(d.description.as_deref(), Some("InfoDesc"));
    assert_eq!(d.location.as_deref(), Some("http://info.example"));
}

#[test]
fn backfills_only_missing_document_reference_fields_from_referenced_document() {
    let dm = extract_data_model(DOCUMENT_PATHS_IFC);
    let d = dm
        .documents
        .iter()
        .find(|d| d.element_id == 29)
        .expect("column document association");
    // Already-set on the reference: must survive untouched, not be
    // overwritten by the referenced info's (different) values.
    assert_eq!(d.identification.as_deref(), Some("REF-ID"));
    assert_eq!(d.location.as_deref(), Some("http://ref.example"));
    // Blank on the reference: must be backfilled from the CORRECT info slots.
    assert_eq!(d.name.as_deref(), Some("BackfilledName"));
    assert_eq!(d.description.as_deref(), Some("BackfilledDesc"));
}

/// One quantity of EACH `IfcPhysicalQuantity` subtype the extractor supports,
/// on a single Qto. Only `IFCQUANTITYLENGTH` was previously exercised (via
/// `Qto_WallBaseQuantities.Width` in `TYPE_PARITY_IFC`) — the other five
/// match arms in `extract_quantity_value`'s `quantity_type` mapping had no
/// coverage, so e.g. "area" and "volume" could be silently swapped.
const ALL_QUANTITY_KINDS_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('Proj0000000000000000001',$,'P',$,$,$,$,$,$);
#10=IFCWALL('Wall00000000000000001',$,'W1',$,$,$,$,$,$);
#20=IFCELEMENTQUANTITY('Qset00000000000000001',$,'Qto_All',$,$,(#21,#22,#23,#24,#25,#26));
#21=IFCQUANTITYLENGTH('QLen',$,$,111.);
#22=IFCQUANTITYAREA('QArea',$,$,222.);
#23=IFCQUANTITYVOLUME('QVol',$,$,333.);
#24=IFCQUANTITYCOUNT('QCount',$,$,444.);
#25=IFCQUANTITYWEIGHT('QWeight',$,$,555.);
#26=IFCQUANTITYTIME('QTime',$,$,666.);
#30=IFCRELDEFINESBYPROPERTIES('Rdbp0000000000000001',$,$,$,(#10),#20);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn maps_every_physical_quantity_subtype_to_its_own_quantity_type_string() {
    let dm = extract_data_model(ALL_QUANTITY_KINDS_IFC);
    let qset = dm
        .quantity_sets
        .iter()
        .find(|q| q.qset_id == 20)
        .expect("Qto_All extracted");
    let q = |name: &str| {
        qset.quantities
            .iter()
            .find(|q| q.quantity_name == name)
            .unwrap_or_else(|| panic!("quantity {name} missing: {:?}", qset.quantities))
    };
    assert_eq!(q("QLen").quantity_type, "length");
    assert_eq!(q("QLen").quantity_value, 111.0);
    assert_eq!(q("QArea").quantity_type, "area");
    assert_eq!(q("QArea").quantity_value, 222.0);
    assert_eq!(q("QVol").quantity_type, "volume");
    assert_eq!(q("QVol").quantity_value, 333.0);
    assert_eq!(q("QCount").quantity_type, "count");
    assert_eq!(q("QCount").quantity_value, 444.0);
    assert_eq!(q("QWeight").quantity_type, "weight");
    assert_eq!(q("QWeight").quantity_value, 555.0);
    assert_eq!(q("QTime").quantity_type, "time");
    assert_eq!(q("QTime").quantity_value, 666.0);
}

/// A wall associated DIRECTLY with an `IfcMaterial` (no layer set / usage
/// indirection) — the `"IFCMATERIAL" =>` arm of `resolve_material`, whose
/// `category` field (attribute 2) was previously not asserted anywhere: a
/// mutation dropping it to `None` passed the full suite.
const DIRECT_MATERIAL_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('Proj0000000000000000001',$,'P',$,$,$,$,$,$);
#28=IFCWALL('Wall00000000000000001',$,'W1',$,$,$,$,$,$);
#80=IFCMATERIAL('Brick',$,'Masonry');
#81=IFCRELASSOCIATESMATERIAL('Mat0000000000000000004',$,$,$,(#28),#80);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn resolves_a_direct_material_association_including_its_category() {
    let dm = extract_data_model(DIRECT_MATERIAL_IFC);
    let m = dm
        .materials
        .iter()
        .find(|m| m.element_id == 28)
        .expect("direct material association");
    assert_eq!(m.material_name, "Brick");
    assert_eq!(m.category.as_deref(), Some("Masonry"));
    assert_eq!(m.set_name, None);
    assert_eq!(m.thickness, None);
}

/// A TWO-level `IfcClassificationReference` chain (leaf -> intermediate ref ->
/// `IfcClassification`) — `resolve_classification`'s `ReferencedSource` walk
/// loop was only ever exercised at depth 1 (leaf ref pointing straight at the
/// classification); a mutation that stops walking after the first hop still
/// passed the full suite, silently losing `system_name` on any multi-level
/// classification tree (issue #900 covers only the flat case).
const NESTED_CLASSIFICATION_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('Proj0000000000000000001',$,'P',$,$,$,$,$,$);
#28=IFCWALL('Wall00000000000000001',$,'W1',$,$,$,$,$,$);
#40=IFCCLASSIFICATION('Uniclass 2015','2',$,'Uniclass 2015',$,$,$);
#41=IFCCLASSIFICATIONREFERENCE('loc-parent','PARENT','Parent Group',#40,$,$);
#42=IFCCLASSIFICATIONREFERENCE('loc-leaf','LEAF','Leaf Item',#41,$,$);
#43=IFCRELASSOCIATESCLASSIFICATION('Cls0000000000000000002',$,$,$,(#28),#42);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn walks_referenced_source_through_multiple_classification_reference_levels() {
    let dm = extract_data_model(NESTED_CLASSIFICATION_IFC);
    let c = dm
        .classifications
        .iter()
        .find(|c| c.element_id == 28)
        .expect("nested classification association");
    // The leaf reference's own fields.
    assert_eq!(c.identification.as_deref(), Some("LEAF"));
    assert_eq!(c.name.as_deref(), Some("Leaf Item"));
    assert_eq!(c.location.as_deref(), Some("loc-leaf"));
    // system_name resolved by walking THROUGH the intermediate reference (#41)
    // to the owning IfcClassification (#40) two hops away.
    assert_eq!(c.system_name.as_deref(), Some("Uniclass 2015"));
}

#[test]
fn buckets_contained_elements_by_the_correct_spatial_container_kind() {
    let dm = extract_data_model(SPATIAL_CHAIN_IFC);
    let sh = &dm.spatial_hierarchy;

    // Each element must land in EXACTLY its own container's bucket, not any
    // of the other three (the swapped/wrong-bucket mutation this pins).
    assert_eq!(sh.element_to_site, vec![(10, 2)], "site bucket");
    assert_eq!(sh.element_to_building, vec![(11, 3)], "building bucket");
    assert_eq!(sh.element_to_storey, vec![(12, 4)], "storey bucket");
    assert_eq!(sh.element_to_space, vec![(13, 5)], "space bucket");

    assert_eq!(sh.element_to_site.len(), 1);
    assert_eq!(sh.element_to_building.len(), 1);
    assert_eq!(sh.element_to_storey.len(), 1);
    assert_eq!(sh.element_to_space.len(), 1);
}
