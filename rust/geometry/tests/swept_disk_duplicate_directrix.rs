// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #5191: an `IfcSweptDiskSolid` whose directrix repeats a point meshed to an
//! all-NaN tube. The zero-length finite difference at the duplicate sample
//! normalised to NaN, and the rotation-minimising frame's refresh guard
//! (`axis_norm > 1e-9 && cos_a < ...`) is false for NaN, so the poisoned frame
//! latched into every later ring. Driven end to end through `GeometryRouter`
//! so the pin is the mesh a consumer actually receives.

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::{GeometryRouter, Mesh};

const FIXTURE: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('swept_disk_duplicate_directrix.ifc','2026-09-23T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#5=IFCUNITASSIGNMENT((#1));
#10=IFCCARTESIANPOINT((0.,0.,0.));
#11=IFCDIRECTION((0.,0.,1.));
#12=IFCDIRECTION((1.,0.,0.));
#13=IFCAXIS2PLACEMENT3D(#10,#11,#12);
#14=IFCDIRECTION((0.,1.));
#15=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#13,#14);
#16=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#15,$,.MODEL_VIEW.,$);
#20=IFCPROJECT('0000000000000000000001',$,'SweptDiskDuplicateDirectrix',$,$,$,$,(#15),#5);
#30=IFCLOCALPLACEMENT($,#13);
#40=IFCCARTESIANPOINT((0.,0.,0.));
#41=IFCCARTESIANPOINT((1000.,0.,0.));
#42=IFCCARTESIANPOINT((1000.,1000.,0.));
#43=IFCPOLYLINE((#10,#40,#41,#41,#41,#42,#42));
#44=IFCSWEPTDISKSOLID(#43,50.,$,$,$);
#45=IFCSHAPEREPRESENTATION(#16,'Body','AdvancedSweptSolid',(#44));
#46=IFCPRODUCTDEFINITIONSHAPE($,$,(#45));
#50=IFCBUILDINGELEMENTPROXY('0000000000000000000002',$,'BentBarWithRepeats',$,$,#30,#46,$,$);
#60=IFCPOLYLINE((#10,#40,#10));
#61=IFCSWEPTDISKSOLID(#60,50.,$,$,$);
#62=IFCSHAPEREPRESENTATION(#16,'Body','AdvancedSweptSolid',(#61));
#63=IFCPRODUCTDEFINITIONSHAPE($,$,(#62));
#70=IFCBUILDINGELEMENTPROXY('0000000000000000000003',$,'ZeroLengthBar',$,$,#30,#63,$,$);
ENDSEC;
END-ISO-10303-21;
"#;

fn mesh_element(id: u32) -> Mesh {
    let entity_index = ifc_lite_core::build_entity_index(FIXTURE);
    let mut decoder = EntityDecoder::with_index(FIXTURE, entity_index);
    let router = GeometryRouter::with_units(FIXTURE, &mut decoder);
    let element = decoder
        .decode_by_id(id)
        .unwrap_or_else(|e| panic!("decode #{id}: {e}"));
    router
        .process_element(&element, &mut decoder)
        .unwrap_or_else(|e| panic!("process #{id}: {e}"))
}

#[test]
fn issue_5191_repeated_directrix_points_mesh_finite() {
    let mesh = mesh_element(50);
    assert!(mesh.triangle_count() > 0, "the bent bar meshed to nothing");
    let bad = mesh.positions.iter().filter(|v| !v.is_finite()).count();
    assert_eq!(bad, 0, "{bad} of {} position components are non-finite", mesh.positions.len());
    let bad_n = mesh.normals.iter().filter(|v| !v.is_finite()).count();
    assert_eq!(bad_n, 0, "{bad_n} normal components are non-finite");

    // The tube still spans the whole L-shaped directrix (1 m along X, then
    // 1 m along Y, radius 50 mm), not a collapsed or fabricated shape.
    let (mut min, mut max) = ([f32::MAX; 3], [f32::MIN; 3]);
    for v in mesh.positions.chunks_exact(3) {
        for k in 0..3 {
            min[k] = min[k].min(v[k]);
            max[k] = max[k].max(v[k]);
        }
    }
    let close = |a: f32, b: f32| (a - b).abs() < 1e-3;
    assert!(close(max[0] - min[0], 1.05) && close(max[1] - min[1], 1.05), "{min:?}..{max:?}");
    assert!(close(max[2] - min[2], 0.1), "{min:?}..{max:?}");
}

#[test]
fn issue_5191_zero_extent_directrix_meshes_nothing() {
    // #10 and #40 are distinct entities at the same coordinate: every sample
    // coincides, so there is no direction to sweep along. Before #5191 this
    // meshed NaN; it must not fabricate a disc from the two end caps either.
    let mesh = mesh_element(70);
    assert!(
        mesh.positions.iter().all(|v| v.is_finite()),
        "zero-extent directrix produced non-finite positions"
    );
    assert_eq!(mesh.triangle_count(), 0, "zero-extent directrix produced geometry");
}
