// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `IfcGridPlacement` resolution (#883) through [`resolve_chain`].

use super::*;
use crate::{Point3, Vector3};
use ifc_lite_core::{EntityDecoder, build_entity_index};
use nalgebra::Matrix4;

mod grid_placement_tests {
    use super::*;

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
        let placement = decoder
            .decode_by_id(id)
            .unwrap_or_else(|e| panic!("decode #{id}: {e:?}"));
        resolve_chain(&placement, &mut decoder)
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
        assert!((origin(&m) - Point3::new(-3.0, 2.0, 4.0)).norm() < 1e-9, "origin={:?}", origin(&m));
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
}
