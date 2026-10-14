// SPDX-License-Identifier: MPL-2.0
//! Tests for [`super`] (IFC terrain → LandXML). Split out under the house
//! pattern (AGENTS.md: a sibling `<name>_tests.rs` wired with `#[cfg(test)]
//! #[path]`), so the module stays under the 400-line rule.
//!
//! Expected coordinates are worked by hand from the authored numbers, and the
//! output is read back through ifc-lite's own LandXML parser rather than
//! string-matched, so an N/E swap or a dropped transform fails as numbers.

use super::{try_export_landxml_terrain, LandXmlTerrainExport, LandXmlTerrainOptions};
use ifc_lite_landxml::{parse_landxml_tin, LandXmlTinDocument};

/// A Bonsai-shaped IFC4X3 terrain (the bonsai-topo control fixture's layout),
/// each slot replaceable so one test changes one fact.
struct Model {
    unit: &'static str,
    wcs: &'static str,
    placement: &'static str,
    map_unit: &'static str,
    conversion: &'static str,
    face_set: &'static str,
    context: &'static str,
    product: &'static str,
    extra: &'static str,
}

const DEFAULT: Model = Model {
    unit: "IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)",
    wcs: "#3",
    placement: "#3",
    map_unit: "#21",
    conversion: "IFCMAPCONVERSION(#5,#12,500000.,6400000.,100.,1.,0.,1.)",
    face_set: "IFCTRIANGULATEDFACESET(#14,$,.T.,((1,2,5),(2,4,5),(4,3,5),(3,1,5)),$)",
    context: "#5",
    product: "IFCGEOGRAPHICELEMENT('0Terrain00000000000001',$,'Ground',$,$,#9,#17,$,.TERRAIN.)",
    extra: "",
};

impl Model {
    fn step(&self) -> String {
        format!(
            "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('t.ifc','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4X3_ADD2'));\nENDSEC;\nDATA;\n\
#1=IFCPROJECT('0Project00000000000001',$,'Survey site',$,$,$,$,(#5),#8);\n\
#2=IFCCARTESIANPOINT((0.,0.,0.));\n#3=IFCAXIS2PLACEMENT3D(#2,$,$);\n#4=IFCDIRECTION((0.,1.));\n\
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,{wcs},#4);\n#6={unit};\n\
#7=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);\n#8=IFCUNITASSIGNMENT((#6,#7));\n#9=IFCLOCALPLACEMENT($,{placement});\n\
#12=IFCPROJECTEDCRS('EPSG:3006','SWEREF99 TM','SWEREF99','EPSG:5613','Transverse Mercator','TM',{map_unit});\n#13={conversion};\n\
#14=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(20.,0.,1.),(0.,20.,2.),(20.,20.,3.),(10.,10.,1.5)));\n#15={face_set};\n\
#16=IFCSHAPEREPRESENTATION({context},'Body','Tessellation',(#15));\n#17=IFCPRODUCTDEFINITIONSHAPE($,$,(#16));\n#18={product};\n\
#20=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#5,$,.MODEL_VIEW.,$);\n#21=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);\n\
#22=IFCCONVERSIONBASEDUNIT(#23,.LENGTHUNIT.,'FOOT',#24);\n#23=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);\n#24=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.3048),#21);\n\
{extra}ENDSEC;\nEND-ISO-10303-21;\n",
            wcs = self.wcs, unit = self.unit, placement = self.placement, map_unit = self.map_unit,
            conversion = self.conversion, face_set = self.face_set, context = self.context,
            product = self.product, extra = self.extra,
        )
    }
}

fn options() -> LandXmlTerrainOptions {
    LandXmlTerrainOptions { date: "2026-10-14".into(), time: "12:00:00".into() }
}

fn export(model: &Model, ids: &[u32]) -> Result<LandXmlTerrainExport, String> {
    try_export_landxml_terrain(model.step().as_bytes(), ids, &options()).map_err(|error| error.to_string())
}

fn refusal(model: &Model, ids: &[u32]) -> String {
    let error = export(model, ids).expect_err("export must refuse");
    assert!(error.starts_with("TERRAIN_REFUSED: "), "{error}");
    error
}

fn read_back(export: &LandXmlTerrainExport) -> LandXmlTinDocument {
    parse_landxml_tin(export.xml.as_bytes()).expect("ifc-lite reads its own LandXML back")
}

/// `(northing, easting, elevation)` and 1-based faces of surface `index`.
fn tin(document: &LandXmlTinDocument, index: usize) -> (Vec<[f64; 3]>, Vec<[usize; 3]>) {
    let surface = &document.surfaces[index];
    let points = surface.points.iter().map(|p| [p.northing, p.easting, p.elevation]).collect();
    let faces = surface.faces.iter().map(|face| face.clone().map(|id| id.parse().expect("numeric point id"))).collect();
    (points, faces)
}

#[test]
fn writes_authored_tin_as_northing_easting_elevation_in_the_map_crs() {
    let export = export(&DEFAULT, &[18]).expect("terrain exports");
    let document = read_back(&export);
    assert_eq!(document.version, "1.2");
    let units = document.units.as_ref().expect("units declared");
    assert_eq!((units.linear_scale_to_meters, units.elevation_scale_to_meters), (1.0, 1.0));
    let crs = document.coordinate_system.as_ref().expect("CRS written");
    assert_eq!(crs.epsg_code.as_deref(), Some("3006"));
    assert_eq!(crs.vertical_datum.as_deref(), Some("EPSG:5613"));
    let (points, faces) = tin(&document, 0);
    assert_eq!(points, vec![
        [6_400_000.0, 500_000.0, 100.0],
        [6_400_000.0, 500_020.0, 101.0],
        [6_400_020.0, 500_000.0, 102.0],
        [6_400_020.0, 500_020.0, 103.0],
        [6_400_010.0, 500_010.0, 101.5],
    ]);
    assert_eq!(faces, vec![[1, 2, 5], [2, 4, 5], [4, 3, 5], [3, 1, 5]]);
    assert_eq!(document.surfaces[0].name, "Ground");
    assert_eq!((export.crs_name.as_str(), export.surfaces[0].points, export.surfaces[0].faces), ("EPSG:3006", 5, 4));
    assert_eq!(export.surfaces[0].global_id.as_deref(), Some("0Terrain00000000000001"));
}

#[test]
fn composes_product_placement_then_map_rotation() {
    // Placement moves the TIN by (100, 50, 2); the map x-axis points north
    // (abscissa 0, ordinate 1), so local +x is +N and local +y is -E.
    let model = Model {
        placement: "#30",
        conversion: "IFCMAPCONVERSION(#5,#12,500000.,6400000.,100.,0.,1.,1.)",
        extra: "#30=IFCAXIS2PLACEMENT3D(#31,$,$);\n#31=IFCCARTESIANPOINT((100.,50.,2.));\n",
        ..DEFAULT
    };
    let (points, _) = tin(&read_back(&export(&model, &[18]).unwrap()), 0);
    // Vertex 2, local (20, 0, 1) → placed (120, 50, 3).
    assert_eq!(points[1], [6_400_120.0, 499_950.0, 103.0]);
}

#[test]
fn applies_combined_scale_from_project_to_map_units() {
    let model = Model {
        unit: "IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)",
        conversion: "IFCMAPCONVERSION(#5,#12,500000.,6400000.,100.,1.,0.,0.001)",
        ..DEFAULT
    };
    let (points, _) = tin(&read_back(&export(&model, &[18]).unwrap()), 0);
    assert_eq!(points[1], [6_400_000.0, 500_000.02, 100.001]);
}

#[test]
fn omitted_map_unit_is_the_project_unit_and_is_written_in_metres() {
    // Feet throughout: Eastings/Northings are feet too, and LandXML gets metres.
    let model = Model {
        unit: "IFCCONVERSIONBASEDUNIT(#23,.LENGTHUNIT.,'FOOT',#24)",
        map_unit: "$",
        conversion: "IFCMAPCONVERSION(#5,#12,500000.,6400000.,100.,1.,0.,$)",
        ..DEFAULT
    };
    let (points, _) = tin(&read_back(&export(&model, &[18]).unwrap()), 0);
    assert_eq!(points[1], [1_950_720.0, 152_406.096, 30.7848]);
}

#[test]
fn resolves_the_conversion_through_the_body_subcontext() {
    let export = export(&Model { context: "#20", ..DEFAULT }, &[18]).expect("subcontext resolves to its parent");
    assert_eq!(tin(&read_back(&export), 0).0[4], [6_400_010.0, 500_010.0, 101.5]);
}

#[test]
fn resolves_pn_index_before_writing_faces() {
    let model = Model { face_set: "IFCTRIANGULATEDFACESET(#14,$,.F.,((1,2,3)),(5,2,4))", ..DEFAULT };
    let (points, faces) = tin(&read_back(&export(&model, &[18]).unwrap()), 0);
    assert_eq!(points, vec![[6_400_010.0, 500_010.0, 101.5], [6_400_000.0, 500_020.0, 101.0], [6_400_020.0, 500_020.0, 103.0]]);
    assert_eq!(faces, vec![[1, 2, 3]]);
}

#[test]
fn accepts_a_tin_without_flags_set_and_refuses_one_with() {
    let plain = "IFCTRIANGULATEDIRREGULARNETWORK(#14,$,.F.,((1,2,5),(2,4,5),(4,3,5),(3,1,5)),$,(0))";
    assert_eq!(export(&Model { face_set: plain, ..DEFAULT }, &[18]).unwrap().surfaces[0].faces, 4);
    let flagged = "IFCTRIANGULATEDIRREGULARNETWORK(#14,$,.F.,((1,2,5),(2,4,5),(4,3,5),(3,1,5)),$,(0,1,0,0))";
    assert!(refusal(&Model { face_set: flagged, ..DEFAULT }, &[18]).contains("sets Flags"));
}

#[test]
fn writes_one_surface_per_selected_terrain_with_unique_names() {
    let model = Model {
        extra: "#40=IFCGEOGRAPHICELEMENT('0Terrain00000000000002',$,'Ground',$,$,#9,#17,$,.TERRAIN.);\n",
        ..DEFAULT
    };
    let export = export(&model, &[18, 40, 18]).unwrap();
    let names: Vec<_> = read_back(&export).surfaces.iter().map(|s| s.name.clone()).collect();
    assert_eq!(names, ["Ground", "Ground (2)"]);
}

#[test]
fn refuses_what_is_not_a_triangulated_terrain() {
    let wall = Model { product: "IFCWALL('0Wall000000000000000001',$,'Wall',$,$,#9,#17,$,$)", ..DEFAULT };
    assert!(refusal(&wall, &[18]).contains("IfcWall"));
    let polygonal = Model {
        face_set: "IFCPOLYGONALFACESET(#14,$,(#41),$)",
        extra: "#41=IFCINDEXEDPOLYGONALFACE((1,2,5));\n",
        ..DEFAULT
    };
    assert!(refusal(&polygonal, &[18]).contains("no IfcTriangulatedFaceSet"));
    assert!(refusal(&DEFAULT, &[]).contains("no terrain is selected"));
    assert!(refusal(&DEFAULT, &[999]).contains("#999 does not exist"));
}

#[test]
fn refuses_faces_that_are_not_three_distinct_points() {
    let repeated = Model { face_set: "IFCTRIANGULATEDFACESET(#14,$,.F.,((1,2,2)),$)", ..DEFAULT };
    assert!(refusal(&repeated, &[18]).contains("three distinct"));
    // Distinct indices, but PnIndex points two of them at one coordinate.
    let collapsed = Model { face_set: "IFCTRIANGULATEDFACESET(#14,$,.F.,((1,2,3)),(1,2,1))", ..DEFAULT };
    assert!(refusal(&collapsed, &[18]).contains("degenerate"));
    let dangling = Model { face_set: "IFCTRIANGULATEDFACESET(#14,$,.F.,((1,2,6)),$)", ..DEFAULT };
    assert!(refusal(&dangling, &[18]).contains("three distinct, existing"));
}

#[test]
fn refuses_missing_or_ambiguous_georeferencing() {
    let none = Model { conversion: "IFCCARTESIANPOINT((0.,0.,0.))", ..DEFAULT };
    assert!(refusal(&none, &[18]).contains("no IfcMapConversion"));
    let two = Model { extra: "#42=IFCMAPCONVERSION(#5,#12,0.,0.,0.,1.,0.,1.);\n", ..DEFAULT };
    assert!(refusal(&two, &[18]).contains("2 IfcMapConversion"));
    let unscaled = Model {
        unit: "IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)",
        conversion: "IFCMAPCONVERSION(#5,#12,500000.,6400000.,100.,1.,0.,$)",
        ..DEFAULT
    };
    assert!(refusal(&unscaled, &[18]).contains("omits Scale"));
    let zero_scale = Model { conversion: "IFCMAPCONVERSION(#5,#12,500000.,6400000.,100.,1.,0.,0.)", ..DEFAULT };
    assert!(refusal(&zero_scale, &[18]).contains("Scale must be positive"));
    let shifted = Model {
        wcs: "#43",
        extra: "#43=IFCAXIS2PLACEMENT3D(#44,$,$);\n#44=IFCCARTESIANPOINT((10.,0.,0.));\n",
        ..DEFAULT
    };
    assert!(refusal(&shifted, &[18]).contains("non-identity WorldCoordinateSystem"));
}

#[test]
fn refuses_terrains_in_different_coordinate_systems() {
    let model = Model {
        extra: "#50=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#3,$);\n\
#51=IFCPROJECTEDCRS('EPSG:3008','SWEREF99 13 30',$,$,$,$,#21);\n#52=IFCMAPCONVERSION(#50,#51,0.,0.,0.,1.,0.,1.);\n\
#53=IFCSHAPEREPRESENTATION(#50,'Body','Tessellation',(#15));\n#54=IFCPRODUCTDEFINITIONSHAPE($,$,(#53));\n\
#55=IFCGEOGRAPHICELEMENT('0Terrain00000000000003',$,'Other',$,$,#9,#54,$,.TERRAIN.);\n",
        ..DEFAULT
    };
    assert!(refusal(&model, &[18, 55]).contains("one coordinate system"));
}

/// The bonsai-topo control pair: the same synthetic terrain authored as IFC4X3
/// and as LandXML 1.2 by the same producer. Exporting the IFC must reproduce
/// the LandXML's TIN point for point and face for face.
#[test]
fn bonsai_control_terrain_matches_its_landxml_twin() {
    let ifc = fixture_or_skip!("landxml/federation/bonsai-topo-control-v1/terrain.ifc");
    let twin = fixture_or_skip!("landxml/federation/bonsai-topo-control-v1/terrain.xml");
    let export = try_export_landxml_terrain(&ifc, &[18], &options()).expect("Bonsai terrain exports");
    let ours = read_back(&export);
    let theirs = parse_landxml_tin(&twin).expect("twin parses");
    assert_eq!(tin(&ours, 0), tin(&theirs, 0));
    let (ours_crs, theirs_crs) = (ours.coordinate_system.unwrap(), theirs.coordinate_system.unwrap());
    assert_eq!((ours_crs.epsg_code, ours_crs.vertical_datum), (theirs_crs.epsg_code, theirs_crs.vertical_datum));
}

#[test]
fn writes_metres_at_micrometre_resolution_without_float_noise() {
    use super::number;
    assert_eq!(number(5_516_087.398_800_001), "5516087.3988");
    assert_eq!(number(-0.000_000_1), "0");
    assert_eq!(number(100.0), "100");
    assert_eq!(number(-12.5), "-12.5");
    assert_eq!(number(1e-6), "0.000001");
}
