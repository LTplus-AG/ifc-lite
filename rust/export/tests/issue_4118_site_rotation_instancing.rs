// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #4118 part B, end to end: IFC bytes in, GLB out, on a model whose `IfcSite`
//! placement carries a 30 degree yaw.
//!
//! Two `IfcBuildingElementProxy` occurrences share one `IfcRepresentationMap`
//! six metres apart. Before this change the pipeline dropped their
//! `InstanceMeta` at `element_mesh_build.rs` because the site rotated, so the
//! exporter had nothing to group and shipped the box twice. This runs the whole
//! chain the reporter's file runs — placement resolution, the `site_local` tier
//! selection, `convert_mesh_to_site_local`, collation, and the glTF assembler —
//! rather than any one layer of it, which is the only way to catch a factor
//! that is right in one module and never reaches the next.
//!
//! The un-yawed sibling is the control: it shared before this change and must
//! still share, so a fix that traded one tier for another shows up here.

use ifc_lite_export::{try_export_glb_with_stats, GltfOptions};

/// Site placement translation (metres); zero rotation (RefDirection omitted).
const SITE_T: (f64, f64, f64) = (10.0, 20.0, 0.0);

/// 30 degree yaw about Z, as an `IfcDirection` RefDirection on the site's
/// `IfcAxis2Placement3D`.
const SITE_ROTATION_30DEG: &str = "#31=IFCDIRECTION((0.,0.,1.));\n#32=IFCDIRECTION((0.866,0.5,0.));";

/// Two `IfcBuildingElementProxy` occurrences of ONE `IfcRepresentationMap`
/// (a 4 x 1 x 2 box), under an `IfcSite` translated by `SITE_T` and, when
/// `rotation` is `Some`, additionally yawed about Z.
fn model(rotation: Option<&str>) -> String {
    let (axis_refdir, site_placement) = match rotation {
        Some(dirs) => (dirs, "#33=IFCAXIS2PLACEMENT3D(#30,#31,#32);"),
        None => ("", "#33=IFCAXIS2PLACEMENT3D(#30,$,$);"),
    };
    format!(
        r##"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('','2026-01-01T00:00:00',(''),(''),'test','test','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#2=IFCUNITASSIGNMENT((#1));
#3=IFCCARTESIANPOINT((0.,0.,0.));
#4=IFCAXIS2PLACEMENT3D(#3,$,$);
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-06,#4,$);
#6=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#5,$,.MODEL_VIEW.,$);
#7=IFCPROJECT('11tEAnIV5BixApwp1YzpwS',$,'t',$,$,$,$,(#5),#2);
#30=IFCCARTESIANPOINT(({tx}.,{ty}.,{tz}.));
{axis_refdir}
{site_placement}
#34=IFCLOCALPLACEMENT($,#33);
#35=IFCSITE('1s1tEAnIV5BixApwp1Yzp0',$,'site',$,$,#34,$,$,.ELEMENT.,$,$,$,$,$);
#8=IFCCARTESIANPOINT((0.,0.));
#9=IFCCARTESIANPOINT((4.,0.));
#10=IFCCARTESIANPOINT((4.,1.));
#11=IFCCARTESIANPOINT((0.,1.));
#12=IFCPOLYLINE((#8,#9,#10,#11,#8));
#13=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#12);
#14=IFCCARTESIANPOINT((0.,0.,0.));
#15=IFCAXIS2PLACEMENT3D(#14,$,$);
#16=IFCDIRECTION((0.,0.,1.));
#17=IFCEXTRUDEDAREASOLID(#13,#15,#16,2.);
#18=IFCSHAPEREPRESENTATION(#6,'Body','SweptSolid',(#17));
#19=IFCCARTESIANPOINT((0.,0.,0.));
#20=IFCAXIS2PLACEMENT3D(#19,$,$);
#21=IFCREPRESENTATIONMAP(#20,#18);
#40=IFCCARTESIANPOINT((0.,0.,0.));
#41=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#40,$,$);
#42=IFCMAPPEDITEM(#21,#41);
#43=IFCSHAPEREPRESENTATION(#6,'Body','MappedRepresentation',(#42));
#44=IFCPRODUCTDEFINITIONSHAPE($,$,(#43));
#45=IFCCARTESIANPOINT((0.,0.,0.));
#46=IFCAXIS2PLACEMENT3D(#45,$,$);
#47=IFCLOCALPLACEMENT(#34,#46);
#48=IFCBUILDINGELEMENTPROXY('36FTsOKg956eWgO6DwnT8U',$,'box1',$,$,#47,#44,$,$);
#50=IFCCARTESIANPOINT((0.,0.,0.));
#51=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#50,$,$);
#52=IFCMAPPEDITEM(#21,#51);
#53=IFCSHAPEREPRESENTATION(#6,'Body','MappedRepresentation',(#52));
#54=IFCPRODUCTDEFINITIONSHAPE($,$,(#53));
#55=IFCCARTESIANPOINT((6.,0.,0.));
#56=IFCAXIS2PLACEMENT3D(#55,$,$);
#57=IFCLOCALPLACEMENT(#34,#56);
#58=IFCBUILDINGELEMENTPROXY('36FTsOKg956eWgO6DwnT8V',$,'box2',$,$,#57,#54,$,$);
ENDSEC;
END-ISO-10303-21;
"##,
        tx = SITE_T.0,
        ty = SITE_T.1,
        tz = SITE_T.2,
    )
}


fn glb_stats(rotation: Option<&str>) -> ifc_lite_export::GltfStats {
    let ifc = model(rotation);
    let (_glb, stats) =
        try_export_glb_with_stats(ifc.as_bytes(), &GltfOptions::default()).expect("has geometry");
    stats
}

/// The repeated box must be ONE mesh in the GLB whether or not the site yaws.
#[test]
fn a_yawed_site_still_shares_its_repeated_box_end_to_end() {
    let flat = glb_stats(None);
    assert_eq!(
        flat.meshes, 1,
        "control: a translated-only site already shared this box before #4118 \
         part B (#4176), so if this is not 1 the fixture stopped exercising \
         instancing at all and the assertion below proves nothing"
    );

    let yawed = glb_stats(Some(SITE_ROTATION_30DEG));
    assert_eq!(
        yawed.meshes, 1,
        "two occurrences of one IfcRepresentationMap under a 30 degree yawed \
         IfcSite must share ONE mesh in the GLB; {} means the group was \
         rejected and the geometry shipped once per occurrence",
        yawed.meshes
    );
    assert_eq!(
        yawed.vertices, flat.vertices,
        "the yawed export must ship the same vertex count as the unrotated \
         one — that count IS the saving this issue measured"
    );
    assert_eq!(
        yawed.unverified_instance_groups, 0,
        "the in-memory assembler verifies every group it instances; a non-zero \
         count here means a group was shipped without the reconstruction check"
    );
}
