// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! IfcGridPlacement resolution tests (#883, #6232 F2).

use super::*;
use ifc_lite_core::build_entity_index;

// Grid axes: P = horizontal line y=0, Q = vertical line x=0 (intersect at
// origin). S = horizontal line y=5. Two ref-direction flavours plus an
// offset case exercise the full IfcGridPlacementDirectionSelect coverage.
const CONTENT: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4X3_ADD2'));
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.));
#2=IFCCARTESIANPOINT((10.,0.));
#3=IFCPOLYLINE((#1,#2));
#4=IFCGRIDAXIS('P',#3,.T.);
#5=IFCCARTESIANPOINT((0.,10.));
#6=IFCPOLYLINE((#1,#5));
#7=IFCGRIDAXIS('Q',#6,.T.);
#8=IFCVIRTUALGRIDINTERSECTION((#4,#7),(0.,0.,0.));
#9=IFCCARTESIANPOINT((0.,5.));
#10=IFCCARTESIANPOINT((10.,5.));
#11=IFCPOLYLINE((#9,#10));
#12=IFCGRIDAXIS('S',#11,.T.);
#13=IFCVIRTUALGRIDINTERSECTION((#7,#12),(0.,0.,0.));
#20=IFCGRIDPLACEMENT($,#8,#13);
#21=IFCDIRECTION((0.,1.,0.));
#22=IFCGRIDPLACEMENT($,#8,#21);
#23=IFCGRIDPLACEMENT($,#8,$);
#30=IFCVIRTUALGRIDINTERSECTION((#4,#7),(2.,3.,4.));
#31=IFCGRIDPLACEMENT($,#30,$);
#40=IFCDIRECTION((0.,0.,1.));
#41=IFCDIRECTION((1.,0.,0.));
#42=IFCCARTESIANPOINT((100.,200.,300.));
#43=IFCAXIS2PLACEMENT3D(#42,#40,#41);
#44=IFCLOCALPLACEMENT($,#43);
#45=IFCGRIDPLACEMENT(#44,#8,$);
ENDSEC;
END-ISO-10303-21;
"#;

fn transform_of(id: u32) -> Matrix4<f64> {
    let content = CONTENT.to_string();
    let ei = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, ei);
    let router = GeometryRouter::new();
    let placement = decoder
        .decode_by_id(id)
        .unwrap_or_else(|e| panic!("decode #{id}: {e:?}"));
    router
        .get_placement_transform(&placement, &mut decoder)
        .unwrap_or_else(|e| panic!("transform #{id}: {e:?}"))
}

fn x_axis(m: &Matrix4<f64>) -> Vector3<f64> {
    Vector3::new(m[(0, 0)], m[(1, 0)], m[(2, 0)])
}
fn origin(m: &Matrix4<f64>) -> Point3<f64> {
    Point3::new(m[(0, 3)], m[(1, 3)], m[(2, 3)])
}

#[test]
fn ref_direction_as_ifc_direction_sets_local_x() {
    let m = transform_of(22);
    assert!((x_axis(&m) - Vector3::new(0.0, 1.0, 0.0)).norm() < 1e-9);
    assert!((origin(&m) - Point3::new(0.0, 0.0, 0.0)).norm() < 1e-9);
}

#[test]
fn ref_direction_as_virtual_intersection_points_x_toward_it() {
    // Location is (0,0); ref intersection #13 is (0,5) → +X must be +Y.
    let m = transform_of(20);
    assert!((x_axis(&m) - Vector3::new(0.0, 1.0, 0.0)).norm() < 1e-9);
    assert!((origin(&m) - Point3::new(0.0, 0.0, 0.0)).norm() < 1e-9);
}

#[test]
fn null_ref_direction_stays_axis_aligned() {
    let m = transform_of(23);
    assert!((x_axis(&m) - Vector3::new(1.0, 0.0, 0.0)).norm() < 1e-9);
    assert!((origin(&m) - Point3::new(0.0, 0.0, 0.0)).norm() < 1e-9);
}

#[test]
fn offset_distances_shift_the_intersection() {
    // off_u=2 (perp to P → +Y), off_v=3 (perp to Q → -X), elevation=4.
    let m = transform_of(31);
    assert!(
        (origin(&m) - Point3::new(-3.0, 2.0, 4.0)).norm() < 1e-9,
        "origin={:?}",
        origin(&m)
    );
}

#[test]
fn placement_rel_to_composes_with_the_grid_placement() {
    // PlacementRelTo #44 sits at (100,200,300); the intersection is local
    // (0,0). The composed transform must land at the grid's world offset —
    // this is the parent ∘ local path that positions a real grid relative
    // to its storey/site (and the reporter's grid at (-17000,16000,0)).
    let m = transform_of(45);
    assert!(
        (origin(&m) - Point3::new(100.0, 200.0, 300.0)).norm() < 1e-9,
        "origin={:?}",
        origin(&m)
    );
    assert!((x_axis(&m) - Vector3::new(1.0, 0.0, 0.0)).norm() < 1e-9);
}

// ---------------------------------------------------------------------------
// #6232 F2: a column on a grid intersection, in each schema's own layout.
//
// The grid sits at (100, 200, 0) turned +90° about Z (grid +X = world +Y,
// grid +Y = world -X). Axis '1' is the grid line x = 4, axis 'A' the line
// y = 3 and axis 'B' the line y = 8, so '1'/'A' is grid-local (4, 3) and
// world (100 - 3, 200 + 4) = (97, 204). The column is a 0.2 (local X) by
// 0.4 (local Y) rectangle extruded 3 up, centred on its placement.
//
// IFC2X3/IFC4 `IfcGridPlacement` is (PlacementLocation, PlacementRefDirection)
// and takes its frame from the grid that owns the axes; IFC4X3 prepends the
// inherited PlacementRelTo, which points at the grid's placement.
// ---------------------------------------------------------------------------

/// How `PlacementRefDirection` is written.
#[derive(Clone, Copy, Debug)]
enum RefDir {
    /// `$`: local +X follows the grid's +X (world +Y here).
    Null,
    /// An `IfcDirection` (IFC4+) along grid +Y (world -X).
    Direction,
    /// A second `IfcVirtualGridIntersection` ('1'/'B', grid-local (4, 8)), so
    /// local +X points along grid +Y (world -X) as well.
    Intersection,
}

fn column_on_grid(schema: &str, ref_dir: RefDir) -> String {
    let is_ifc4x3 = schema.starts_with("IFC4X3");
    let predefined = if schema == "IFC2X3" { "" } else { ",$" };
    let ref_attr = match ref_dir {
        RefDir::Null => "$",
        RefDir::Direction => "#61",
        RefDir::Intersection => "#62",
    };
    let placement = if is_ifc4x3 {
        format!("#70=IFCGRIDPLACEMENT(#20,#60,{ref_attr});")
    } else {
        format!("#70=IFCGRIDPLACEMENT(#60,{ref_attr});")
    };
    format!(
        "ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('{schema}'));
ENDSEC;
DATA;
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#23,$);
#20=IFCLOCALPLACEMENT($,#23);
#21=IFCCARTESIANPOINT((100.,200.,0.));
#22=IFCDIRECTION((0.,1.,0.));
#24=IFCDIRECTION((0.,0.,1.));
#23=IFCAXIS2PLACEMENT3D(#21,#24,#22);
#30=IFCCARTESIANPOINT((4.,-1.));
#31=IFCCARTESIANPOINT((4.,10.));
#32=IFCPOLYLINE((#30,#31));
#33=IFCGRIDAXIS('1',#32,.T.);
#34=IFCCARTESIANPOINT((-1.,3.));
#35=IFCCARTESIANPOINT((10.,3.));
#36=IFCPOLYLINE((#34,#35));
#37=IFCGRIDAXIS('A',#36,.T.);
#38=IFCCARTESIANPOINT((-1.,8.));
#39=IFCCARTESIANPOINT((10.,8.));
#40=IFCPOLYLINE((#38,#39));
#41=IFCGRIDAXIS('B',#40,.T.);
#50=IFCGRID('0M7tQ9Jbj1BAeHd7rqnDmP',$,'Grid',$,$,#20,$,(#33),(#37,#41),${predefined});
#60=IFCVIRTUALGRIDINTERSECTION((#33,#37),(0.,0.));
#61=IFCDIRECTION((0.,1.,0.));
#62=IFCVIRTUALGRIDINTERSECTION((#33,#41),(0.,0.));
{placement}
#80=IFCCARTESIANPOINT((0.,0.));
#81=IFCAXIS2PLACEMENT2D(#80,$);
#82=IFCRECTANGLEPROFILEDEF(.AREA.,$,#81,0.2,0.4);
#83=IFCCARTESIANPOINT((0.,0.,0.));
#84=IFCAXIS2PLACEMENT3D(#83,$,$);
#85=IFCEXTRUDEDAREASOLID(#82,#84,#24,3.);
#86=IFCSHAPEREPRESENTATION(#10,'Body','SweptSolid',(#85));
#87=IFCPRODUCTDEFINITIONSHAPE($,$,(#86));
#90=IFCCOLUMN('1kTvXnbbzCWw8lcMd1dR4o',$,'C1',$,$,#70,#87,${predefined});
ENDSEC;
END-ISO-10303-21;
"
    )
}

/// World-space AABB of the meshed column: `(min, max)`.
fn column_bounds(content: &str) -> (Point3<f64>, Point3<f64>) {
    let mut decoder = EntityDecoder::with_index(content, build_entity_index(content));
    let router = GeometryRouter::new();
    let column = decoder.decode_by_id(90).expect("decode column");
    let mesh = router
        .process_element(&column, &mut decoder)
        .expect("mesh column");
    assert!(!mesh.positions.is_empty(), "column produced no geometry");
    let mut min = Point3::new(f64::MAX, f64::MAX, f64::MAX);
    let mut max = Point3::new(f64::MIN, f64::MIN, f64::MIN);
    for p in mesh.positions.chunks_exact(3) {
        for axis in 0..3 {
            min[axis] = min[axis].min(p[axis] as f64);
            max[axis] = max[axis].max(p[axis] as f64);
        }
    }
    (min, max)
}

fn assert_column_at(schema: &str, ref_dir: RefDir, half_x: f64, half_y: f64) {
    let (min, max) = column_bounds(&column_on_grid(schema, ref_dir));
    let want_min = Point3::new(97.0 - half_x, 204.0 - half_y, 0.0);
    let want_max = Point3::new(97.0 + half_x, 204.0 + half_y, 3.0);
    assert!(
        (min - want_min).norm() < 1e-4 && (max - want_max).norm() < 1e-4,
        "{schema} {ref_dir:?}: column spans {min:?}..{max:?}, want {want_min:?}..{want_max:?}"
    );
}

// Grid +X is world +Y, so an unoriented column's 0.2 local X runs along world Y.
const ALONG_GRID_X: (f64, f64) = (0.2, 0.1);
// Oriented along grid +Y (world -X): the 0.2 local X runs along world X.
const ALONG_GRID_Y: (f64, f64) = (0.1, 0.2);

#[test]
fn ifc2x3_column_lands_on_the_rotated_grid_intersection() {
    let (hx, hy) = ALONG_GRID_X;
    assert_column_at("IFC2X3", RefDir::Null, hx, hy);
}

#[test]
fn ifc2x3_ref_direction_intersection_orients_the_column() {
    let (hx, hy) = ALONG_GRID_Y;
    assert_column_at("IFC2X3", RefDir::Intersection, hx, hy);
}

#[test]
fn ifc4_column_lands_on_the_rotated_grid_intersection() {
    let (hx, hy) = ALONG_GRID_X;
    assert_column_at("IFC4", RefDir::Null, hx, hy);
}

#[test]
fn ifc4_ref_direction_orients_the_column_either_way() {
    let (hx, hy) = ALONG_GRID_Y;
    assert_column_at("IFC4", RefDir::Direction, hx, hy);
    assert_column_at("IFC4", RefDir::Intersection, hx, hy);
}

#[test]
fn ifc4x3_column_lands_on_the_rotated_grid_intersection() {
    let (hx, hy) = ALONG_GRID_X;
    assert_column_at("IFC4X3_ADD2", RefDir::Null, hx, hy);
}

#[test]
fn ifc4x3_ref_direction_orients_the_column_either_way() {
    let (hx, hy) = ALONG_GRID_Y;
    assert_column_at("IFC4X3_ADD2", RefDir::Direction, hx, hy);
    assert_column_at("IFC4X3_ADD2", RefDir::Intersection, hx, hy);
}

/// The owning-grid frame is memoised under the axis id, so a second element on
/// the same grid must read the same world transform from a warm decoder.
#[test]
fn ifc4_grid_frame_memo_serves_a_second_placement() {
    let content = column_on_grid("IFC4", RefDir::Null).replace(
        "ENDSEC;\nEND-ISO",
        "#71=IFCGRIDPLACEMENT(#62,$);\nENDSEC;\nEND-ISO",
    );
    let mut decoder = EntityDecoder::with_index(&content, build_entity_index(&content));
    let router = GeometryRouter::new();
    for (id, want) in [
        (70, Point3::new(97.0, 204.0, 0.0)),
        (71, Point3::new(92.0, 204.0, 0.0)),
    ] {
        let placement = decoder.decode_by_id(id).expect("decode placement");
        let m = router
            .get_placement_transform(&placement, &mut decoder)
            .expect("transform");
        assert!(
            (origin(&m) - want).norm() < 1e-9,
            "#{id} origin={:?}",
            origin(&m)
        );
        assert!((x_axis(&m) - Vector3::new(0.0, 1.0, 0.0)).norm() < 1e-9);
    }
    assert!(
        decoder.get_placement_transform_cached(33).is_some(),
        "grid frame memoised under axis #33"
    );
}
