// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #4118: a `site_local`-tier model whose `IfcSite` placement is a pure
//! translation (no rotation) must NOT discard instancing metadata — the
//! guard in `element.rs` used to key off `site_local_rotation.is_some()`,
//! which is true for every `site_local` model regardless of whether its site
//! placement actually rotates anything, so a translated-but-unrotated site
//! (the common case for a model imported with a georeferenced offset) lost
//! instancing for no reason.
//!
//! Two `IfcBuildingElementProxy` occurrences share one `IfcRepresentationMap`
//! via `IfcMappedItem`, placed under a translated (non-rotated) `IfcSite`.
//! With `enable_instancing` armed, the pipeline's #1623 don't-bake plan should
//! materialize ONE template mesh carrying `MeshData.instance` and leave the
//! second occurrence as a non-template ref that collates against it — proving
//! instancing metadata survived the site-local tier.

use ifc_lite_processing::{
    process_geometry_streaming_filtered_with_options, MeshData, OpeningFilterMode,
    StreamingOptions,
};

/// Site placement translation (metres); zero rotation (RefDirection omitted).
const SITE_T: (f64, f64, f64) = (10.0, 20.0, 0.0);

/// 30 degree yaw about Z, as an `IfcDirection` RefDirection on the site's
/// `IfcAxis2Placement3D` — the same fixture rotation used by
/// `site_rotation.rs`'s `ROTATED_SITE_PLACEMENT`.
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

fn run(rotation: Option<&str>) -> Vec<MeshData> {
    let ifc = model(rotation);
    let options = StreamingOptions {
        initial_batch_size: usize::MAX,
        throughput_batch_size: usize::MAX,
        enable_instancing: true,
        retain_emitted_meshes: true,
        ..StreamingOptions::default()
    };
    let result = process_geometry_streaming_filtered_with_options(
        ifc.as_bytes(),
        OpeningFilterMode::Default,
        options,
        |_, _, _| {},
        |_| {},
        |_| {},
    );
    assert_eq!(
        result.mesh_coordinate_space.as_deref(),
        Some("site_local"),
        "a translated IfcSite must select the site_local tier"
    );
    result.meshes
}

/// #4118 regression: a translated-but-unrotated site must not lose instancing.
/// Of the two occurrences of the shared box, at least one mesh must carry
/// `instance` metadata — the #1623 don't-bake template/occurrence split only
/// happens when instancing metadata survives `produce_element_meshes`.
#[test]
fn translated_only_site_keeps_instancing_metadata() {
    let meshes = run(None);
    let proxy_meshes: Vec<&MeshData> = meshes
        .iter()
        .filter(|m| m.express_id == 48 || m.express_id == 58)
        .collect();
    assert!(
        !proxy_meshes.is_empty(),
        "expected meshes for the two box proxies (#48, #58)"
    );
    let carries_instance = proxy_meshes.iter().any(|m| m.instance.is_some());
    assert!(
        carries_instance,
        "translated-only site_local model must retain instancing metadata \
         on at least one occurrence of the shared representation map; \
         got instance=None on every mesh: {:?}",
        proxy_meshes
            .iter()
            .map(|m| (m.express_id, m.instance.is_some()))
            .collect::<Vec<_>>()
    );

    // Strengthened: for this site_local fixture, BOTH occurrences of the
    // shared IfcRepresentationMap materialize as meshes (the don't-bake
    // instancing_plan is forced to None for site_local coord spaces, so
    // there is no `result.instances` fallback path here — see
    // `processor/mod.rs`'s SITE_LOCAL_MESH_COORDINATE_SPACE guard). The two
    // assertions above pass on #48 alone, so a regression that dropped #58
    // — or produced it without `InstanceMeta` — would slip past them
    // undetected. Require both express ids to be present, each carrying
    // `instance.is_some()`.
    let by_id: std::collections::BTreeMap<u32, bool> = proxy_meshes
        .iter()
        .map(|m| (m.express_id, m.instance.is_some()))
        .collect();
    assert_eq!(
        by_id,
        std::collections::BTreeMap::from([(48, true), (58, true)]),
        "expected both box proxies (#48, #58) to appear in result.meshes, \
         each carrying instance metadata; got: {:?}",
        by_id
    );
}

/// #4118 counterpart: a genuinely ROTATED site must still drop instancing —
/// this is the property the guard exists to preserve. `site_rotation.rs`
/// proves a rotated site still rotates positions but never checks `instance`;
/// the sibling test above proves a translated-only site keeps instancing but
/// never checks a rotated one. Neither alone can catch the guard being
/// deleted or inverted; this pins the missing corner.
#[test]
fn rotated_site_drops_instancing_metadata() {
    let meshes = run(Some(SITE_ROTATION_30DEG));
    let proxy_meshes: Vec<&MeshData> = meshes
        .iter()
        .filter(|m| m.express_id == 48 || m.express_id == 58)
        .collect();
    assert!(
        !proxy_meshes.is_empty(),
        "expected meshes for the two box proxies (#48, #58)"
    );
    for m in &proxy_meshes {
        assert!(
            m.instance.is_none(),
            "a 30-degree-yawed site must drop instancing metadata on \
             express_id {} — a site-local rotation re-transforms positions/origin \
             and would invalidate the captured instance transform if kept",
            m.express_id
        );
    }
}
