// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

/// `extract_data_model`, plus the #3973 structural invariant
/// (`spatial::spatial_hierarchy_consistency_violations`) asserted over the
/// resulting `spatial_hierarchy` on every call. Every existing spatial
/// fixture in this file goes through this wrapper rather than calling
/// `extract_data_model` directly, so each one retroactively guards against a
/// third instance of the dangling `children_ids` / disagreeing `parent_id`
/// shape - not just the two fixtures written specifically to reproduce it.
/// `build_spatial_hierarchy` itself only runs this check via `debug_assert!`
/// (skipped in release builds); this wrapper enforces it unconditionally in
/// the test suite regardless of build profile.
fn extract_data_model_checked<T>(content: &T) -> DataModel
where
    T: AsRef<[u8]> + ?Sized,
{
    let dm = extract_data_model(content);
    let node_refs: Vec<&SpatialNode> = dm.spatial_hierarchy.nodes.iter().collect();
    let violations = spatial::spatial_hierarchy_consistency_violations(&node_refs);
    assert!(
        violations.is_empty(),
        "spatial hierarchy consistency invariant violated:\n{}",
        violations.join("\n")
    );
    dm
}

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
    let dm = extract_data_model_checked(ASSOCIATIONS_IFC);

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
    let dm = extract_data_model_checked(TYPE_PARITY_IFC);

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
    // Synthetic edges: no IfcRel entity produced them, so `rel_id` is 0 rather
    // than a borrowed id (issue #3860).
    assert!(
        dm.relationships
            .iter()
            .filter(|r| r.rel_type == "TYPEHASPROPERTYSETS")
            .all(|r| r.rel_id == 0),
        "synthetic type-set edges must not claim an IfcRel express id"
    );
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
    let dm = extract_data_model_checked(plain);
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
    let dm = extract_data_model_checked(TYPE_PARITY_IFC);
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
    let dm = extract_data_model_checked(VOID_FILL_IFC);
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
    let dm = extract_data_model_checked(MALFORMED_VOID_FILL_IFC);
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
    let dm = extract_data_model_checked(SPATIAL_CHAIN_IFC);
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
    let dm = extract_data_model_checked(DOCUMENT_PATHS_IFC);
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
    let dm = extract_data_model_checked(DOCUMENT_PATHS_IFC);
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
/// `Qto_WallBaseQuantities.Width` in `TYPE_PARITY_IFC`) — the other match
/// arms in `extract_quantity_value`'s `quantity_type` mapping had no
/// coverage, so e.g. "area" and "volume" could be silently swapped.
/// `IFCQUANTITYNUMBER` was worse than swapped: unrecognised, so `#3266`'s
/// subtype was dropped from the quantity set entirely. It is IFC4X3-only,
/// hence this fixture's schema header.
const ALL_QUANTITY_KINDS_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4X3'));
ENDSEC;
DATA;
#1=IFCPROJECT('Proj0000000000000000001',$,'P',$,$,$,$,$,$);
#10=IFCWALL('Wall00000000000000001',$,'W1',$,$,$,$,$,$);
#20=IFCELEMENTQUANTITY('Qset00000000000000001',$,'Qto_All',$,$,(#21,#22,#23,#24,#25,#26,#27));
#21=IFCQUANTITYLENGTH('QLen',$,$,111.);
#22=IFCQUANTITYAREA('QArea',$,$,222.);
#23=IFCQUANTITYVOLUME('QVol',$,$,333.);
#24=IFCQUANTITYCOUNT('QCount',$,$,444.);
#25=IFCQUANTITYWEIGHT('QWeight',$,$,555.);
#26=IFCQUANTITYTIME('QTime',$,$,666.);
#27=IFCQUANTITYNUMBER('QNumber',$,$,777.);
#30=IFCRELDEFINESBYPROPERTIES('Rdbp0000000000000001',$,$,$,(#10),#20);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn maps_every_physical_quantity_subtype_to_its_own_quantity_type_string() {
    let dm = extract_data_model_checked(ALL_QUANTITY_KINDS_IFC);
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
    assert_eq!(q("QNumber").quantity_type, "number");
    assert_eq!(q("QNumber").quantity_value, 777.0);
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
    let dm = extract_data_model_checked(DIRECT_MATERIAL_IFC);
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
    let dm = extract_data_model_checked(NESTED_CLASSIFICATION_IFC);
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
    let dm = extract_data_model_checked(SPATIAL_CHAIN_IFC);
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

/// Every relationship row must carry the express id of the `IfcRel*` entity it
/// came from (issue #3860). Without it the viewer's server path fed the
/// relationship graph id 0 and a Parquet/DuckDB export wrote `RelId = 0` on
/// every row, so a server-loaded model and a locally parsed one disagreed on
/// the same relationship. The three association rels here have distinct express
/// ids (#35 / #42 / #51) that are also distinct from their relating and related
/// ids, so neither a constant nor a copy of a neighbouring column passes.
#[test]
fn relationships_carry_the_ifcrel_express_id() {
    let dm = extract_data_model_checked(ASSOCIATIONS_IFC);
    let rel_id_of = |ty: &str, relating: u32, related: u32| -> u32 {
        dm.relationships
            .iter()
            .find(|r| {
                r.rel_type.eq_ignore_ascii_case(ty)
                    && r.relating_id == relating
                    && r.related_id == related
            })
            .unwrap_or_else(|| panic!("{ty} ({relating} -> {related}) missing"))
            .rel_id
    };
    assert_eq!(rel_id_of("IFCRELASSOCIATESMATERIAL", 34, 28), 35);
    assert_eq!(rel_id_of("IFCRELASSOCIATESCLASSIFICATION", 41, 28), 42);
    assert_eq!(rel_id_of("IFCRELASSOCIATESDOCUMENT", 50, 28), 51);
}

/// The single-ref voids/fills path builds its `Relationship` in a separate arm
/// from the list path, so it can lose `rel_id` on its own.
#[test]
fn voids_and_fills_carry_the_ifcrel_express_id() {
    let dm = extract_data_model_checked(VOID_FILL_IFC);
    let rel_id_of = |ty: &str| -> u32 {
        dm.relationships
            .iter()
            .find(|r| r.rel_type.eq_ignore_ascii_case(ty))
            .unwrap_or_else(|| panic!("{ty} missing"))
            .rel_id
    };
    assert_eq!(rel_id_of("IFCRELVOIDSELEMENT"), 40);
    assert_eq!(rel_id_of("IFCRELFILLSELEMENT"), 50);
}

/// #3965: an `IfcSpace` placed under its storey via `IfcRelContainedInSpatialStructure`
/// only (the common Revit Family / Dynamo export pattern, historically reported at
/// #1075) must be promoted into its own `SpatialNode`, exactly like an aggregated one -
/// not left as a flat leaf in `element_ids` with no parent link.
const CONTAINED_SPACE_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('Proj0000000000000000001',$,'MyProject',$,$,$,$,$,$);
#2=IFCBUILDING('Bldg0000000000000000001',$,'MyBuilding',$,$,$,$,$,$,$,$,$);
#3=IFCBUILDINGSTOREY('Stor0000000000000000001',$,'MyStorey',$,$,$,$,$,$,$);
#5=IFCSPACE('Spac0000000000000000001',$,'MySpace',$,$,$,$,$,$,$);
#100=IFCRELAGGREGATES('Agg00000000000000000001',$,$,$,#1,(#2));
#101=IFCRELAGGREGATES('Agg00000000000000000002',$,$,$,#2,(#3));
#110=IFCRELCONTAINEDINSPATIALSTRUCTURE('Con00000000000000000001',$,$,$,(#5),#3);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn a_contained_not_aggregated_space_is_promoted_to_its_own_node() {
    let dm = extract_data_model_checked(CONTAINED_SPACE_IFC);
    let sh = &dm.spatial_hierarchy;

    let storey = sh
        .nodes
        .iter()
        .find(|n| n.entity_id == 3)
        .expect("storey node");
    assert_eq!(
        storey.children_ids,
        vec![5],
        "the contained space must be linked as the storey's child, not dropped"
    );

    let space = sh
        .nodes
        .iter()
        .find(|n| n.entity_id == 5)
        .expect("the contained IfcSpace must have its own SpatialNode");
    assert_eq!(space.parent_id, 3, "space's parent must be the storey that contains it");
    assert_eq!(space.type_name.to_uppercase(), "IFCSPACE");
    assert_eq!(space.level, storey.level + 1);

    // Reachable-from-project walk (what the client's buildSpatialNodeTree/hierarchy
    // panel actually does) must find the space, not just nodes_map containing it.
    let mut reachable = std::collections::HashSet::new();
    let mut stack = vec![sh.project_id];
    while let Some(id) = stack.pop() {
        if !reachable.insert(id) {
            continue;
        }
        if let Some(n) = sh.nodes.iter().find(|n| n.entity_id == id) {
            stack.extend(n.children_ids.iter().copied());
        }
    }
    assert!(
        reachable.contains(&5),
        "the contained space must be reachable from project_id via children_ids"
    );

    // It must NOT also linger as a plain leaf element on the storey.
    assert!(
        !storey.element_ids.contains(&5),
        "a promoted spatial child must not remain in element_ids as a leaf too"
    );
}

/// A space that is BOTH aggregated AND contained under the SAME parent (some
/// authoring tools emit both relationships for the same edge) must appear as
/// exactly one node with exactly one children_ids entry - not twice.
const DOUBLE_LINKED_SPACE_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('Proj0000000000000000001',$,'MyProject',$,$,$,$,$,$);
#3=IFCBUILDINGSTOREY('Stor0000000000000000001',$,'MyStorey',$,$,$,$,$,$,$);
#5=IFCSPACE('Spac0000000000000000001',$,'MySpace',$,$,$,$,$,$,$);
#100=IFCRELAGGREGATES('Agg00000000000000000001',$,$,$,#1,(#3));
#101=IFCRELAGGREGATES('Agg00000000000000000002',$,$,$,#3,(#5));
#110=IFCRELCONTAINEDINSPATIALSTRUCTURE('Con00000000000000000001',$,$,$,(#5),#3);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn a_space_both_aggregated_and_contained_under_the_same_parent_is_not_duplicated() {
    let dm = extract_data_model_checked(DOUBLE_LINKED_SPACE_IFC);
    let sh = &dm.spatial_hierarchy;

    let storey = sh.nodes.iter().find(|n| n.entity_id == 3).expect("storey");
    assert_eq!(
        storey.children_ids,
        vec![5],
        "the doubly-linked space must appear exactly once in children_ids"
    );

    let space_nodes: Vec<_> = sh.nodes.iter().filter(|n| n.entity_id == 5).collect();
    assert_eq!(space_nodes.len(), 1, "exactly one SpatialNode for the space, not two");
}

/// #3965's narrower gap: `IFCSPATIALZONE` was entirely absent from the spatial
/// type list, so a zone contained (not aggregated) under its storey never got a
/// node - and, per the issue's own scratch repro, anything the zone in turn
/// contained (a wall here) vanished from the hierarchy entirely, not even
/// surfacing as a leaf. `IFCMARINEPART` and `IFCFACILITYPARTCOMMON` (the
/// IFC4X3 pair the TS side carries since #3248/#3249) get the same treatment
/// under a facility.
const CONTAINED_ZONE_AND_IFC4X3_PARTS_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4X3'));
ENDSEC;
DATA;
#1=IFCPROJECT('Proj0000000000000000001',$,'MyProject',$,$,$,$,$,$);
#3=IFCBUILDINGSTOREY('Stor0000000000000000001',$,'MyStorey',$,$,$,$,$,$,$);
#6=IFCSPATIALZONE('Zone0000000000000000001',$,'MyZone',$,$,$,$,$,$);
#12=IFCWALL('Wall0000000000000000001',$,'ZoneWall',$,$,$,$,$,$);
#7=IFCFACILITY('Faci0000000000000000001',$,'MyFacility',$,$,$,$,$,$,$,$,$);
#8=IFCMARINEPART('Mari0000000000000000001',$,'MyMarinePart',$,$,$,$,$,$,$,$,$,$);
#9=IFCFACILITYPARTCOMMON('Comm0000000000000000001',$,'MyCommonPart',$,$,$,$,$,$,$,$,$,$);
#100=IFCRELAGGREGATES('Agg00000000000000000001',$,$,$,#1,(#3,#7));
#111=IFCRELCONTAINEDINSPATIALSTRUCTURE('Con00000000000000000001',$,$,$,(#6),#3);
#112=IFCRELCONTAINEDINSPATIALSTRUCTURE('Con00000000000000000002',$,$,$,(#12),#6);
#113=IFCRELCONTAINEDINSPATIALSTRUCTURE('Con00000000000000000003',$,$,$,(#8),#7);
#114=IFCRELCONTAINEDINSPATIALSTRUCTURE('Con00000000000000000004',$,$,$,(#9),#7);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn contained_spatial_zone_and_ifc4x3_facility_parts_are_promoted_to_nodes() {
    let dm = extract_data_model_checked(CONTAINED_ZONE_AND_IFC4X3_PARTS_IFC);
    let sh = &dm.spatial_hierarchy;
    let node = |id: u32| sh.nodes.iter().find(|n| n.entity_id == id);

    let zone = node(6).expect("contained IfcSpatialZone must get its own node");
    assert_eq!(zone.parent_id, 3);
    assert_eq!(zone.type_name.to_uppercase(), "IFCSPATIALZONE");
    assert!(
        zone.element_ids.contains(&12),
        "the wall the zone contains must not be lost from the hierarchy"
    );

    let marine_part = node(8).expect("contained IfcMarinePart must get its own node");
    assert_eq!(marine_part.parent_id, 7);
    assert_eq!(marine_part.type_name.to_uppercase(), "IFCMARINEPART");

    let facility_part_common =
        node(9).expect("contained IfcFacilityPartCommon must get its own node");
    assert_eq!(facility_part_common.parent_id, 7);
    assert_eq!(facility_part_common.type_name.to_uppercase(), "IFCFACILITYPARTCOMMON");
}

/// #3973: a space aggregated under Storey A (#2) but ALSO contained (not
/// aggregated) under a DIFFERENT storey, Storey B (#3). Unlike the
/// same-parent case above, cross-parent dedup was never handled at all:
/// `spatial_children_map` is keyed per-parent, so both storeys' children_ids
/// listed the space, while `build_spatial_nodes_recursive` has no
/// already-inserted guard, so whichever branch the walk reached last silently
/// overwrote `nodes_map`, deciding the space's `parent_id` by relationship-list
/// iteration order rather than a rule. A client walking from Storey A would
/// find the space id but render it with Storey B's parent linkage.
///
/// Fixed behaviour: IfcRelAggregates is the canonical spatial-hierarchy
/// relationship, so the aggregated parent (Storey A) wins deterministically
/// over the merely-contained parent (Storey B); Storey B's children_ids must
/// not reference a node that isn't actually its child.
/// #3973's own comment claims aggregation-vs-containment precedence and
/// first-file-order-wins-among-ties are never decided by relationship/HashMap
/// iteration order. This is the direct check: the SAME cross-parent fixture
/// as the test below, but with its two IFCRELAGGREGATES lines re-ordered
/// relative to each other AND relative to the IFCRELCONTAINEDINSPATIALSTRUCTURE
/// line, must produce the identical tree.
const CROSS_PARENT_DUAL_LINKED_SPACE_REORDERED_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('Proj0000000000000000001',$,'MyProject',$,$,$,$,$,$);
#2=IFCBUILDINGSTOREY('StorA00000000000000001',$,'StoreyA',$,$,$,$,$,$,$);
#3=IFCBUILDINGSTOREY('StorB00000000000000001',$,'StoreyB',$,$,$,$,$,$,$);
#5=IFCSPACE('Spac0000000000000000001',$,'MySpace',$,$,$,$,$,$,$);
#110=IFCRELCONTAINEDINSPATIALSTRUCTURE('Con00000000000000000001',$,$,$,(#5),#3);
#101=IFCRELAGGREGATES('Agg00000000000000000002',$,$,$,#2,(#5));
#100=IFCRELAGGREGATES('Agg00000000000000000001',$,$,$,#1,(#2,#3));
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn reordering_the_same_relationships_in_the_file_produces_an_identical_tree() {
    let ordered = extract_data_model_checked(CROSS_PARENT_DUAL_LINKED_SPACE_IFC);
    let reordered = extract_data_model_checked(CROSS_PARENT_DUAL_LINKED_SPACE_REORDERED_IFC);

    let mut ordered_nodes = ordered.spatial_hierarchy.nodes.clone();
    let mut reordered_nodes = reordered.spatial_hierarchy.nodes.clone();
    ordered_nodes.sort_by_key(|n| n.entity_id);
    reordered_nodes.sort_by_key(|n| n.entity_id);

    assert_eq!(
        ordered_nodes.len(),
        reordered_nodes.len(),
        "reordering relationship lines must not change how many nodes are built"
    );
    for (a, b) in ordered_nodes.iter().zip(reordered_nodes.iter()) {
        assert_eq!(a.entity_id, b.entity_id);
        assert_eq!(
            a.parent_id, b.parent_id,
            "entity {} got a different parent depending on file order",
            a.entity_id
        );
        assert_eq!(a.level, b.level, "entity {} got a different level depending on file order", a.entity_id);
        assert_eq!(
            a.children_ids, b.children_ids,
            "entity {} got different children_ids depending on file order",
            a.entity_id
        );
    }
}

const CROSS_PARENT_DUAL_LINKED_SPACE_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('Proj0000000000000000001',$,'MyProject',$,$,$,$,$,$);
#2=IFCBUILDINGSTOREY('StorA00000000000000001',$,'StoreyA',$,$,$,$,$,$,$);
#3=IFCBUILDINGSTOREY('StorB00000000000000001',$,'StoreyB',$,$,$,$,$,$,$);
#5=IFCSPACE('Spac0000000000000000001',$,'MySpace',$,$,$,$,$,$,$);
#100=IFCRELAGGREGATES('Agg00000000000000000001',$,$,$,#1,(#2,#3));
#101=IFCRELAGGREGATES('Agg00000000000000000002',$,$,$,#2,(#5));
#110=IFCRELCONTAINEDINSPATIALSTRUCTURE('Con00000000000000000001',$,$,$,(#5),#3);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn a_space_aggregated_under_one_storey_and_contained_under_another_picks_one_canonical_parent() {
    let dm = extract_data_model_checked(CROSS_PARENT_DUAL_LINKED_SPACE_IFC);
    let sh = &dm.spatial_hierarchy;

    let storey_a = sh.nodes.iter().find(|n| n.entity_id == 2).expect("storey A");
    let storey_b = sh.nodes.iter().find(|n| n.entity_id == 3).expect("storey B");

    // Exactly one SpatialNode for the space, ever.
    let space_nodes: Vec<_> = sh.nodes.iter().filter(|n| n.entity_id == 5).collect();
    assert_eq!(
        space_nodes.len(),
        1,
        "exactly one SpatialNode for the cross-parent space, not one per parent"
    );

    // The aggregation edge (Storey A) is the canonical relationship and must win,
    // deterministically - never decided by relationship/HashMap iteration order.
    assert_eq!(
        space_nodes[0].parent_id, 2,
        "the aggregated parent (Storey A) must win over the merely-contained parent (Storey B)"
    );

    assert_eq!(
        storey_a.children_ids,
        vec![5],
        "Storey A (the real aggregation parent) must list the space as its child"
    );
    assert!(
        !storey_b.children_ids.contains(&5),
        "Storey B must not reference a node that is not actually its child - \
         a dangling children_ids entry lets a client render the space with the wrong parent's data"
    );
}

/// #3973: `Storey A` aggregates `Storey B` via `IfcRelAggregates`, and `Storey B`
/// "contains" `Storey A` via `IfcRelContainedInSpatialStructure` (this PR's own
/// promotion puts a contained spatial-structure target into
/// `spatial_children_map`, same as an aggregated one). That produces
/// `spatial_children_map == {A: [B], B: [A]}`, and the unguarded recursive walk
/// in `build_spatial_nodes_recursive` recurses A -> B -> A -> B -> ... without
/// bound. Because the crate builds with `panic = 'abort'`, the resulting stack
/// overflow is not a catchable panic - it SIGABRTs the whole process. That
/// cannot be observed with a normal `#[test]` (it would kill the test runner
/// too), so this spawns the reproduction in a fresh child process and asserts
/// the child exits successfully rather than being killed by a signal.
#[test]
fn cyclic_aggregate_and_containment_edges_do_not_abort_the_process() {
    const CYCLIC_STOREY_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('Proj0000000000000000001',$,'MyProject',$,$,$,$,$,$);
#2=IFCBUILDINGSTOREY('StorA00000000000000001',$,'StoreyA',$,$,$,$,$,$,$);
#3=IFCBUILDINGSTOREY('StorB00000000000000001',$,'StoreyB',$,$,$,$,$,$,$);
#100=IFCRELAGGREGATES('Agg00000000000000000001',$,$,$,#1,(#2));
#101=IFCRELAGGREGATES('Agg00000000000000000002',$,$,$,#2,(#3));
#110=IFCRELCONTAINEDINSPATIALSTRUCTURE('Con00000000000000000001',$,$,$,(#2),#3);
ENDSEC;
END-ISO-10303-21;
"#;

    const REPRO_ENV_VAR: &str = "IFC_LITE_SPATIAL_CYCLE_REPRO";

    if std::env::var(REPRO_ENV_VAR).is_ok() {
        // Child process: run the exact reproduction (on a small dedicated
        // thread stack, so an unguarded cycle overflows fast rather than
        // eating gigabytes of stack first) and exit cleanly if it survives.
        let handle = std::thread::Builder::new()
            .stack_size(256 * 1024)
            .spawn(|| {
                let dm = extract_data_model_checked(CYCLIC_STOREY_IFC);
                dm.spatial_hierarchy.nodes.len()
            })
            .expect("failed to spawn repro thread");
        let node_count = handle.join().expect("repro thread panicked/aborted");
        eprintln!("cyclic repro produced {node_count} spatial nodes without aborting");
        std::process::exit(0);
    }

    let exe = std::env::current_exe().expect("current test exe");
    // NOT `module_path!()` - it is crate-qualified (`ifc_lite_server::...`),
    // while libtest's own `--exact` names are not (confirmed via `--list`).
    let test_name =
        "services::data_model::tests::cyclic_aggregate_and_containment_edges_do_not_abort_the_process";
    let output = std::process::Command::new(&exe)
        .args([test_name, "--exact", "--nocapture"])
        .env(REPRO_ENV_VAR, "1")
        .output()
        .expect("failed to spawn child test process");

    assert!(
        output.status.success(),
        "a spatial hierarchy with a Storey-A-aggregates-Storey-B / \
         Storey-B-contains-Storey-A cycle must not abort the process; \
         child exit status = {:?}\n--- child stdout ---\n{}\n--- child stderr ---\n{}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

/// #3973 follow-up: a chain nested past `MAX_SPATIAL_TREE_DEPTH` (100) must
/// have its excluded subtree dropped CLEANLY, not resurrected as corrupted
/// fake roots. The pre-fix "orphan-fill" loop only checked `nodes_map`, which
/// is empty both for a depth-capped entity and for its never-visited
/// descendants, so it reinserted every one of them at `parent_id: 0, level:
/// 0` while the last surviving ancestor's `children_ids` still (for the
/// entity directly at the boundary) named the dropped id as a child - two
/// representations of the same entity's place in the tree disagreeing, and
/// exactly the shape `apps/server/src/services/parquet_data_model.rs` reads
/// `parent_id` as authoritative for, so the exported Parquet spatial table
/// would show spurious extra roots instead of a dropped subtree.
#[test]
fn entities_past_the_depth_cap_are_dropped_cleanly_not_resurrected_as_fake_roots() {
    // Chain of 110 nested IFCBUILDINGSTOREY entities, each aggregated under
    // the previous one, starting from IFCPROJECT (#1). Project is level 0,
    // so entity id 2+i sits at level i+1; the cap (level > 100) first excludes
    // id 102 (level 101).
    let mut data = String::new();
    data.push_str("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n");
    data.push_str("#1=IFCPROJECT('Proj0000000000000000001',$,'MyProject',$,$,$,$,$,$);\n");
    let n = 110u32;
    for i in 0..n {
        let id = 2 + i;
        data.push_str(&format!(
            "#{id}=IFCBUILDINGSTOREY('Stor{id:0>19}',$,'Storey{id}',$,$,$,$,$,$,$);\n"
        ));
    }
    let mut rel_id = 1000u32;
    data.push_str(&format!(
        "#{rel_id}=IFCRELAGGREGATES('Agg{rel_id:0>19}',$,$,$,#1,(#2));\n"
    ));
    for i in 0..(n - 1) {
        rel_id += 1;
        let parent = 2 + i;
        let child = 3 + i;
        data.push_str(&format!(
            "#{rel_id}=IFCRELAGGREGATES('Agg{rel_id:0>19}',$,$,$,#{parent},(#{child}));\n"
        ));
    }
    data.push_str("ENDSEC;\nEND-ISO-10303-21;\n");

    let dm = extract_data_model_checked(&data);
    let sh = &dm.spatial_hierarchy;
    let node = |id: u32| sh.nodes.iter().find(|n| n.entity_id == id);

    let last_kept = node(101).expect("the last node within the depth cap must survive");
    assert_eq!(last_kept.level, 100);
    assert!(
        last_kept.children_ids.is_empty(),
        "the depth-capped child (102) must not remain in its parent's children_ids: {:?}",
        last_kept.children_ids
    );

    for dropped_id in [102u32, 103, 110, 111] {
        assert!(
            node(dropped_id).is_none(),
            "entity {dropped_id} is past the depth cap and must not appear as a node at all \
             (in particular, never as a fake root with parent_id 0)"
        );
    }

    // No node anywhere may reference a child that has no SpatialNode of its own.
    let existing_ids: std::collections::HashSet<u32> =
        sh.nodes.iter().map(|n| n.entity_id).collect();
    for node in &sh.nodes {
        for &child in &node.children_ids {
            assert!(
                existing_ids.contains(&child),
                "node {} (level {}) lists child {child}, which has no SpatialNode",
                node.entity_id,
                node.level
            );
        }
    }
}

/// Follow-up to #3973's own fix: `Site` is never aggregated by `Project` (a
/// malformed but real truncated-export shape), so it is genuinely unreachable
/// from the root and rescued by the orphan-fill loop as a fake root
/// (`parent_id: 0, level: 0`) - correctly, per this PR's own rule, since it
/// has no canonical parent of its own. But `Site` DOES canonically parent
/// `Building` via `IfcRelAggregates`, so `Building` is skipped by the
/// orphan-fill loop's `canonical_parent` check (it does have a parent) and
/// never gets its own `SpatialNode` - while the orphan-fill loop populated
/// the rescued `Site` node's `children_ids` straight from
/// `spatial_children_map`, without the same filtering
/// `build_spatial_nodes_recursive` applies to its own descent. The rescued
/// `Site` therefore names `Building` as a child with no `SpatialNode` of its
/// own: the exact dangling-reference shape this fix set out to eliminate,
/// reappearing one level removed in the orphan-fill path itself.
const DISCONNECTED_SITE_AGGREGATES_BUILDING_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('Proj0000000000000000009',$,'MyProject',$,$,$,$,$,$);
#2=IFCSITE('Site0000000000000000001',$,'MySite',$,$,$,$,$,$,$,$,$,$,$);
#3=IFCBUILDING('Bldg0000000000000000001',$,'MyBuilding',$,$,$,$,$,$,$,$,$);
#101=IFCRELAGGREGATES('Agg00000000000000000009',$,$,$,#2,(#3));
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn a_rescued_orphans_children_ids_never_names_a_node_that_was_not_itself_rescued() {
    let dm = extract_data_model_checked(DISCONNECTED_SITE_AGGREGATES_BUILDING_IFC);
    let site = dm
        .spatial_hierarchy
        .nodes
        .iter()
        .find(|n| n.entity_id == 2)
        .expect("Site is genuinely unreachable and has no canonical parent, so it must be rescued as a fake root");
    assert_eq!(site.parent_id, 0);
    let building_has_node = dm.spatial_hierarchy.nodes.iter().any(|n| n.entity_id == 3);
    assert!(
        !site.children_ids.contains(&3) || building_has_node,
        "Site's children_ids names Building (#3) as a child, but Building has \
         no SpatialNode of its own - a dangling reference identical in shape \
         to the one this fix eliminated for the recursive-descent path"
    );
}

/// Fixture for issue #3964: a `IfcSystem` grouping a wall via
/// `IfcRelAssignsToGroup`, an `IfcZone` grouping the same wall via
/// `IfcRelAssignsToGroupByFactor` (adds a proportional Factor, e.g. zone
/// occupancy share, but shares the same RelatedObjects/RelatingGroup
/// membership semantics as its supertype), a door decomposed into a panel via
/// `IfcRelNests` (a decomposition edge some IFC4 exporters use instead of
/// `IfcRelAggregates`, e.g. feature/fastener nesting), and two walls joined
/// end-to-end via `IfcRelConnectsPathElements` (the "connected walls" edge the
/// Properties panel reads via `extractRelationshipsOnDemand`). None of these
/// four types were extracted before this fix.
const NEW_REL_TYPES_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,$,$);
#10=IFCWALL('Wall00000000000000001',$,'W1',$,$,$,$,$,$);
#11=IFCWALL('Wall00000000000000002',$,'W2',$,$,$,$,$,$);
#20=IFCSYSTEM('Sys0000000000000000001',$,'HVAC-1',$,$);
#21=IFCRELASSIGNSTOGROUP('Grp0000000000000000001',$,$,$,(#10),$,#20);
#25=IFCZONE('Zon0000000000000000001',$,'Zone-A',$,$);
#26=IFCRELASSIGNSTOGROUPBYFACTOR('Grf0000000000000000001',$,$,$,(#10),$,#25,0.5);
#30=IFCDOOR('Doo0000000000000000001',$,'D1',$,$,$,$,$,$);
#31=IFCDOOR('Doo0000000000000000002',$,'D2',$,$,$,$,$,$);
#32=IFCRELNESTS('Nst0000000000000000001',$,$,$,#30,(#31));
#40=IFCRELCONNECTSPATHELEMENTS('Con0000000000000000001',$,$,$,$,#10,#11,$,$,.ATEND.,.ATSTART.);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn extracts_assigns_to_group_relationship_orientation() {
    let dm = extract_data_model_checked(NEW_REL_TYPES_IFC);
    // RelatingGroup=#20 (IfcSystem), RelatedObjects=(#10) (the wall).
    assert!(
        dm.relationships.iter().any(|r| {
            r.rel_type.eq_ignore_ascii_case("IFCRELASSIGNSTOGROUP")
                && r.relating_id == 20
                && r.related_id == 10
        }),
        "IFCRELASSIGNSTOGROUP (system -> wall) missing or misoriented: {:?}",
        dm.relationships
    );
}

#[test]
fn extracts_assigns_to_group_by_factor_relationship_orientation() {
    let dm = extract_data_model_checked(NEW_REL_TYPES_IFC);
    // RelatingGroup=#25 (IfcZone), RelatedObjects=(#10) (the wall).
    assert!(
        dm.relationships.iter().any(|r| {
            r.rel_type.eq_ignore_ascii_case("IFCRELASSIGNSTOGROUPBYFACTOR")
                && r.relating_id == 25
                && r.related_id == 10
        }),
        "IFCRELASSIGNSTOGROUPBYFACTOR (zone -> wall) missing or misoriented: {:?}",
        dm.relationships
    );
}

#[test]
fn extracts_nests_relationship_orientation() {
    let dm = extract_data_model_checked(NEW_REL_TYPES_IFC);
    // RelatingObject=#30 (door), RelatedObjects=(#31) (the nested panel).
    assert!(
        dm.relationships.iter().any(|r| {
            r.rel_type.eq_ignore_ascii_case("IFCRELNESTS")
                && r.relating_id == 30
                && r.related_id == 31
        }),
        "IFCRELNESTS (door -> panel) missing or misoriented: {:?}",
        dm.relationships
    );
}

#[test]
fn extracts_connects_path_elements_relationship_orientation() {
    let dm = extract_data_model_checked(NEW_REL_TYPES_IFC);
    // RelatingElement=#10 (wall 1), RelatedElement=#11 (wall 2).
    assert!(
        dm.relationships.iter().any(|r| {
            r.rel_type.eq_ignore_ascii_case("IFCRELCONNECTSPATHELEMENTS")
                && r.relating_id == 10
                && r.related_id == 11
        }),
        "IFCRELCONNECTSPATHELEMENTS (wall -> wall) missing or misoriented: {:?}",
        dm.relationships
    );
}

/// Control: a fixture with none of the four new types must extract exactly as
/// before — none of them should ever appear for a model that never wrote
/// them, so a future change to the new-type match arms can't silently start
/// matching an unrelated type.
#[test]
fn fixture_without_new_types_is_unaffected() {
    let dm = extract_data_model_checked(ASSOCIATIONS_IFC);
    assert!(
        !dm.relationships.iter().any(|r| {
            matches!(
                r.rel_type.to_uppercase().as_str(),
                "IFCRELASSIGNSTOGROUP"
                    | "IFCRELASSIGNSTOGROUPBYFACTOR"
                    | "IFCRELNESTS"
                    | "IFCRELCONNECTSPATHELEMENTS"
            )
        }),
        "fixture has none of the new types, but one was extracted: {:?}",
        dm.relationships
    );
}
