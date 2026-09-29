// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #6232 F2: an element on an `IfcGridPlacement` lands on the grid
//! intersection, with the grid's rotation, in IFC2X3, IFC4 and IFC4X3.
//! IFC2X3/IFC4 used to be read with the IFC4X3 attribute slots, which put
//! every such element at the world origin.

use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::{GeometryRouter, Point3};

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
    bounds(&mesh.positions)
}

fn bounds(positions: &[f32]) -> (Point3<f64>, Point3<f64>) {
    assert!(!positions.is_empty(), "column produced no geometry");
    let mut min = Point3::new(f64::MAX, f64::MAX, f64::MAX);
    let mut max = Point3::new(f64::MIN, f64::MIN, f64::MIN);
    for p in positions.chunks_exact(3) {
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

/// A second element on the same IFC4 grid lands on its own intersection, and
/// the owning grid's frame is memoised under the axis id for it (#33 is axis
/// '1', which both locations share).
#[test]
fn ifc4_second_element_on_the_grid_reuses_the_grid_frame() {
    let content = column_on_grid("IFC4", RefDir::Null).replace(
        "ENDSEC;\nEND-ISO",
        "#71=IFCGRIDPLACEMENT(#62,$);\n\
#91=IFCCOLUMN('2kTvXnbbzCWw8lcMd1dR4o',$,'C2',$,$,#71,#87,$);\nENDSEC;\nEND-ISO",
    );
    let mut decoder = EntityDecoder::with_index(&content, build_entity_index(&content));
    let router = GeometryRouter::new();
    for (id, y) in [(90, 204.0), (91, 204.0)] {
        let column = decoder.decode_by_id(id).expect("decode column");
        let mesh = router
            .process_element(&column, &mut decoder)
            .expect("mesh column");
        let (min, max) = bounds(&mesh.positions);
        // '1'/'B' is grid-local (4, 8): world (100 - 8, 200 + 4) = (92, 204).
        let x = if id == 90 { 97.0 } else { 92.0 };
        let centre = Point3::new((min.x + max.x) / 2.0, (min.y + max.y) / 2.0, 0.0);
        assert!(
            (centre - Point3::new(x, y, 0.0)).norm() < 1e-4,
            "#{id} centre={centre:?}"
        );
    }
    assert!(
        decoder.get_placement_transform_cached(33).is_some(),
        "grid frame memoised under axis #33"
    );
}
