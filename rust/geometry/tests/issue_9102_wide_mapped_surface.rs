// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #9102 regression: WASM 12.2 dropped a product whose single mapped
//! `SurfaceModel` held 65,536+ `IfcShellBasedSurfaceModel` items (89,023 on
//! the reporting model); WASM 10.4 meshed every one. The representation walk
//! charged the first read of that wide, acyclic Items list against its fixed
//! work budget. A first read now pays only for items the walk already
//! reached; these are all distinct, so the whole product meshes.
//!
//! The fixture is the issue's synthetic reproduction: no project data. Every
//! item is a distinct surface model over one shared triangular open shell.

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::representation::MAX_WALK_LEVELS;
use ifc_lite_geometry::{GeometryRouter, Mesh};

fn source(items: usize) -> String {
    let ids: Vec<String> = (0..items).map(|i| format!("#{}", 1000 + i)).collect();
    let members: String = ids
        .iter()
        .map(|id| format!("{id}=IFCSHELLBASEDSURFACEMODEL((#7));\n"))
        .collect();
    format!(
        "ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('mapped breadth regression'),'2;1');
FILE_NAME('mapped.ifc','2026-11-06T00:00:00',(),(),'','','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCCARTESIANPOINT((1.,0.,0.));
#3=IFCCARTESIANPOINT((0.,1.,0.));
#4=IFCPOLYLOOP((#1,#2,#3));
#5=IFCFACEOUTERBOUND(#4,.T.);
#6=IFCFACE((#5));
#7=IFCOPENSHELL((#6));
#9=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,1.,$);
#10=IFCAXIS2PLACEMENT3D(#1,$,$);
#11=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,0.00001,#10,$);
#20=IFCSHAPEREPRESENTATION(#11,'Body','SurfaceModel',({}));
#21=IFCREPRESENTATIONMAP(#10,#20);
#22=IFCMAPPEDITEM(#21,#9);
#23=IFCSHAPEREPRESENTATION(#11,'Body','MappedRepresentation',(#22));
#24=IFCPRODUCTDEFINITIONSHAPE($,$,(#23));
#25=IFCFLOWTERMINAL('0000000000000000000001',$,'synthetic mapped surface',$,$,$,#24,$);
{members}ENDSEC;
END-ISO-10303-21;
",
        ids.join(",")
    )
}

#[test]
fn issue_9102_wide_mapped_surface_model_keeps_every_item() {
    let cap = MAX_WALK_LEVELS as usize;
    // The published boundary (65,535 ok, 65,536 dropped), past the cap
    // alone, and the reporting model's count.
    for items in [cap - 1, cap, cap + 1, 89_023] {
        let content = source(items);
        let mut decoder = EntityDecoder::new(&content);
        let router = GeometryRouter::with_units(&content, &mut decoder);
        let product = decoder.decode_by_id(25).unwrap();

        let parts = router.process_element_parts(&product, &mut decoder).unwrap();
        assert_eq!(
            parts.iter().map(Mesh::triangle_count).sum::<usize>(),
            items,
            "merged mesh of {items} items"
        );
        let styled = router
            .process_element_with_submeshes(&product, &mut decoder)
            .unwrap();
        assert_eq!(
            styled
                .sub_meshes
                .iter()
                .map(|sub| sub.mesh.triangle_count())
                .sum::<usize>(),
            items,
            "submeshes of {items} items"
        );
        let dropped = router.take_unsupported_items();
        assert!(dropped.is_empty(), "{items} items: {dropped:?}");
    }
}
