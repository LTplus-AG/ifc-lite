// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Mesh-level golden lock for the canonical default-color table (issue #913,
//! plan §6.2 / §2.2). `styling_parity.rs` locks the *table* at unit level;
//! this proves the table actually reaches rendered meshes through
//! `process_geometry`, for the four types whose default diverged between the
//! historical `wasm` and `processing` tables (the union decision §8.1).
//!
//! Because `wasm-bindings` now delegates colour resolution to
//! `ifc_lite_processing::style` (Phase 2e), locking the backend's per-mesh
//! colour here is simultaneously the cross-consumer parity guarantee: there is
//! one resolver, so a green test means every live consumer agrees.
//!
//! Each element carries a bare `IfcTriangulatedFaceSet` body with **no**
//! `IfcStyledItem` and **no** material, so the only colour source is the
//! per-type default. Placement is attr 5 and representation attr 6 on every
//! `IfcProduct`, so the uniform 9-attribute form resolves geometry regardless
//! of the concrete subtype's full schema arity.

use ifc_lite_processing::{default_color_for_type, process_geometry};
use ifc_lite_core::IfcType;

const DEFAULTS_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-913 default-colour mesh fixture'),'2;1');
FILE_NAME('defaults.ifc','2026-06-04T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#15=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));

#10=IFCWALL('1WallDefaultColour0001',$,'Wall',$,$,#11,#12,$,$);
#11=IFCLOCALPLACEMENT($,#5);
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#13=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#14));
#14=IFCTRIANGULATEDFACESET(#15,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);

#20=IFCCURTAINWALL('1CurtainWallColour001',$,'Curtain',$,$,#21,#22,$,$);
#21=IFCLOCALPLACEMENT($,#5);
#22=IFCPRODUCTDEFINITIONSHAPE($,$,(#23));
#23=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#24));
#24=IFCTRIANGULATEDFACESET(#15,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);

#30=IFCFURNISHINGELEMENT('1FurnishingColour0001',$,'Furniture',$,$,#31,#32,$,$);
#31=IFCLOCALPLACEMENT($,#5);
#32=IFCPRODUCTDEFINITIONSHAPE($,$,(#33));
#33=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#34));
#34=IFCTRIANGULATEDFACESET(#15,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);

#40=IFCBUILDINGELEMENTPROXY('1ProxyDefaultColour01',$,'Proxy',$,$,#41,#42,$,$);
#41=IFCLOCALPLACEMENT($,#5);
#42=IFCPRODUCTDEFINITIONSHAPE($,$,(#43));
#43=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#44));
#44=IFCTRIANGULATEDFACESET(#15,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);

#50=IFCSTAIRFLIGHT('1StairFlightColour001',$,'Flight',$,$,#51,#52,$,$);
#51=IFCLOCALPLACEMENT($,#5);
#52=IFCPRODUCTDEFINITIONSHAPE($,$,(#53));
#53=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#54));
#54=IFCTRIANGULATEDFACESET(#15,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
ENDSEC;
END-ISO-10303-21;
"#;

fn approx_eq(a: [f32; 4], b: [f32; 4]) -> bool {
    a.iter().zip(b.iter()).all(|(x, y)| (x - y).abs() < 1e-4)
}

#[test]
fn bare_elements_render_the_canonical_default_color() {
    let result = process_geometry(DEFAULTS_IFC);

    // (express id, IFC type) — includes the four contested types (§2.2) plus a
    // wall as an uncontested control.
    let cases = [
        (10u32, IfcType::IfcWall),
        (20, IfcType::IfcCurtainWall),
        (30, IfcType::IfcFurnishingElement),
        (40, IfcType::IfcBuildingElementProxy),
        (50, IfcType::IfcStairFlight),
    ];

    let seen: Vec<(u32, &str, [f32; 4])> = result
        .meshes
        .iter()
        .map(|m| (m.express_id, m.ifc_type.as_str(), m.color))
        .collect();

    for (id, ty) in cases {
        let mesh = result
            .meshes
            .iter()
            .find(|m| m.express_id == id)
            .unwrap_or_else(|| panic!("element #{id} ({ty:?}) produced no mesh; got: {seen:?}"));

        let expected = default_color_for_type(ty).to_array();
        assert!(
            approx_eq(mesh.color, expected),
            "#{id} {ty:?}: expected canonical default {expected:?}, got {:?}",
            mesh.color
        );
    }

    // The contested types must carry their *agreed* values end-to-end, not the
    // pre-union ones. Curtain wall is the clearest: it was the neutral gray
    // default in the old `processing` table and must now be the glass blue.
    let curtain = result.meshes.iter().find(|m| m.express_id == 20).unwrap();
    assert!(
        approx_eq(curtain.color, [0.5, 0.7, 0.9, 0.5]),
        "curtain wall must render glass blue, got {:?}",
        curtain.color
    );
    assert_ne!(
        curtain.color,
        [0.8, 0.8, 0.8, 1.0],
        "curtain wall fell back to the old neutral-gray default"
    );
}
