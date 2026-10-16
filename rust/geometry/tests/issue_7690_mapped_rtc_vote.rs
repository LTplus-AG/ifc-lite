// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7690 ROUTER-27: the RTC detector's `IfcMappedItem` vote.
//!
//! An origin-placed product whose only geometry is a mapped national-grid face
//! set must vote the source's first vertex carried through every map level
//! (`MappingTarget · MappingOrigin`, innermost first) and the length unit, not
//! its `(0,0,0)` placement. The nested-map walk is bounded like the mesh path's
//! mapped-item walk: the shared `MAX_MAPPED_ITEM_DEPTH` and a visited set.

use ifc_lite_core::{build_entity_index, EntityDecoder, MAX_MAPPED_ITEM_DEPTH};
use ifc_lite_geometry::GeometryRouter;

/// A MILLIMETRE model with one origin-placed proxy whose body is a chain of
/// `levels` nested maps; the innermost map holds a face set whose first vertex
/// is LV95 E 2,600,000 / N 1,200,000 / H 400 m. Every level's MappingTarget
/// adds +1000 mm in X and every MappingOrigin +2000 mm in Y, so a dropped or
/// misordered level moves the vote by whole metres. With `outer_scaled` the
/// OUTERMOST level's MappingTarget is a pure `Scale = 2` instead, so the
/// composition order is observable (translations alone commute).
fn nested_model(levels: u32, outer_scaled: bool) -> String {
    let mut data = String::from(
        "#1=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);\n#2=IFCUNITASSIGNMENT((#1));\n\
         #3=IFCCARTESIANPOINT((0.,0.,0.));\n#4=IFCAXIS2PLACEMENT3D(#3,$,$);\n\
         #5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-06,#4,$);\n\
         #6=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#5,$,.MODEL_VIEW.,$);\n\
         #7=IFCPROJECT('0Project0000000000000a',$,'p',$,$,$,$,(#5),#2);\n\
         #8=IFCCARTESIANPOINT((1000.,0.,0.));\n\
         #9=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#8,1.,$);\n\
         #10=IFCCARTESIANPOINT((0.,2000.,0.));\n#11=IFCAXIS2PLACEMENT3D(#10,$,$);\n\
         #12=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#3,2.,$);\n\
         #20=IFCCARTESIANPOINTLIST3D(((2600000000.,1200000000.,400000.),\
         (2600000012.,1200000000.,400000.),(2600000000.,1200000007.,400000.)),$);\n\
         #21=IFCTRIANGULATEDFACESET(#20,$,.T.,((1,2,3)),$);\n\
         #22=IFCSHAPEREPRESENTATION(#6,'Body','Tessellation',(#21));\n",
    );
    // Level k (1-based, innermost = 1): map #(100+3k) over representation
    // #(100+3k+1), reached through mapped item #(100+3k+2).
    let mut inner_rep = 22;
    for k in 1..=levels {
        let (map, rep, item) = (100 + 3 * k, 100 + 3 * k + 1, 100 + 3 * k + 2);
        let target = if outer_scaled && k == levels { 12 } else { 9 };
        data.push_str(&format!(
            "#{map}=IFCREPRESENTATIONMAP(#11,#{inner_rep});\n\
             #{item}=IFCMAPPEDITEM(#{map},#{target});\n\
             #{rep}=IFCSHAPEREPRESENTATION(#6,'Body','MappedRepresentation',(#{item}));\n"
        ));
        inner_rep = rep;
    }
    wrap(&format!(
        "{data}#90=IFCLOCALPLACEMENT($,#4);\n#91=IFCPRODUCTDEFINITIONSHAPE($,$,(#{inner_rep}));\n\
         #92=IFCBUILDINGELEMENTPROXY('0Proxy000000000000000a',$,'p',$,$,#90,#91,$,$);\n"
    ))
}

fn wrap(data: &str) -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\n\
         FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n{data}ENDSEC;\nEND-ISO-10303-21;\n"
    )
}

fn anchor(content: &str) -> Option<(f64, f64, f64)> {
    let mut decoder = EntityDecoder::with_index(content, build_entity_index(content));
    let router = GeometryRouter::with_units(content, &mut decoder);
    router.detect_rtc_anchor_for_file(content.as_bytes(), &mut decoder)
}

fn assert_near(actual: (f64, f64, f64), expected: (f64, f64, f64), what: &str) {
    let d = [
        actual.0 - expected.0,
        actual.1 - expected.1,
        actual.2 - expected.2,
    ];
    assert!(
        d.iter().all(|c| c.abs() < 1e-6),
        "{what}: voted {actual:?}, expected {expected:?}"
    );
}

/// One map and a three-deep chain: each level contributes its +1 m target and
/// +2 m origin, in metres after the millimetre unit. Before the fix both voted
/// the proxy's `(0,0,0)` placement.
#[test]
fn router_27_a_mapped_item_votes_its_source_vertex_through_every_level() {
    for levels in [1, 3] {
        let n = f64::from(levels);
        assert_near(
            anchor(&nested_model(levels, false)).expect("one usable sample"),
            (2_600_000.0 + n, 1_200_000.0 + 2.0 * n, 400.0),
            &format!("{levels}-level map"),
        );
    }
    // Outer Scale 2 over inner (+1 m, +2 m) and outer origin (+2 m in Y):
    // 2 * (v + (1, 2, 0) + (0, 2, 0)) = 2v + (2, 8, 0). Composing the levels
    // the other way round votes 2v + (1, 6, 0).
    assert_near(
        anchor(&nested_model(2, true)).expect("one usable sample"),
        (5_200_002.0, 2_400_008.0, 800.0),
        "scaled outer level over a translated inner level",
    );
}

/// The chain is walked to the router's own mapped-item cap and no further: a
/// chain the mesh path meshes still votes its vertex, one level deeper (which
/// the mesh path refuses) abstains back to the placement vote.
#[test]
fn router_27_the_mapped_vote_stops_at_the_shared_mapped_item_depth() {
    let at_cap = anchor(&nested_model(MAX_MAPPED_ITEM_DEPTH, false)).expect("sample");
    assert!(
        at_cap.0 > 2_600_000.0,
        "{MAX_MAPPED_ITEM_DEPTH} levels: voted {at_cap:?}"
    );
    let past_cap = anchor(&nested_model(MAX_MAPPED_ITEM_DEPTH + 1, false)).expect("sample");
    assert_near(past_cap, (0.0, 0.0, 0.0), "one level past the cap");
}

/// A self-referencing map (its representation holds the item that maps it)
/// terminates on the visited set and abstains to the placement vote.
#[test]
fn router_27_a_cyclic_map_terminates_and_abstains() {
    let content = wrap(
        "#1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);\n#2=IFCUNITASSIGNMENT((#1));\n\
         #3=IFCCARTESIANPOINT((0.,0.,0.));\n#4=IFCAXIS2PLACEMENT3D(#3,$,$);\n\
         #5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-06,#4,$);\n\
         #6=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#5,$,.MODEL_VIEW.,$);\n\
         #7=IFCPROJECT('0Project0000000000000a',$,'p',$,$,$,$,(#5),#2);\n\
         #30=IFCREPRESENTATIONMAP(#4,#31);\n\
         #31=IFCSHAPEREPRESENTATION(#6,'Body','MappedRepresentation',(#32));\n\
         #32=IFCMAPPEDITEM(#30,$);\n\
         #90=IFCLOCALPLACEMENT($,#4);\n#91=IFCPRODUCTDEFINITIONSHAPE($,$,(#31));\n\
         #92=IFCBUILDINGELEMENTPROXY('0Proxy000000000000000a',$,'p',$,$,#90,#91,$,$);\n",
    );
    assert_near(
        anchor(&content).expect("sample"),
        (0.0, 0.0, 0.0),
        "cyclic map",
    );
}
