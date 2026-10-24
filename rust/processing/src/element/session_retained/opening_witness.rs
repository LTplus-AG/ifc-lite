// SPDX-License-Identifier: MPL-2.0
//! Source-derived fixed-tolerance oracles shared by actual native and Worker tests.
pub(super) const OVERLAP: &str =
    include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../processing/tests/fixtures/issue_2019_wall_two_overlapping_openings.ifc"));
pub(super) const TRAP: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../processing/tests/fixtures/issue_3641_voiding_trap.ifc"));
pub(super) mod analytic;
mod source;
mod physical;
pub(super) use source::oracle;
pub(super) fn repeated_mapped_source() -> String {
    // A stated multiplicity invariant over the existing #2019 authored solids:
    // two distinct host item/style identities and a reused two-occurrence opening body.
    OVERLAP
        .replace("'SweptSolid',(#26)", "'SweptSolid',(#26,#126)")
        .replace("'SweptSolid',(#46)", "'MappedRepresentation',(#201,#202)")
        .replace(
            "ENDSEC;\nEND-ISO-10303-21;",
            "
#126=IFCEXTRUDEDAREASOLID(#23,#25,#4,3.);
#200=IFCREPRESENTATIONMAP(#5,#203);
#201=IFCMAPPEDITEM(#200,#205);#202=IFCMAPPEDITEM(#200,#206);
#203=IFCSHAPEREPRESENTATION(#7,'Body','SweptSolid',(#46));
#204=IFCCARTESIANPOINT((0.2,0.,0.));
#205=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,1.,$);
#206=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#204,1.,$);
ENDSEC;END-ISO-10303-21;",
        )
}
pub(super) fn empty_host_source() -> String {
    OVERLAP
        .replace("'SweptSolid',(#26)", "'CSG',(#110)")
        .replace("'SweptSolid',(#46)", "'SweptSolid',(#999)")
        .replace(
            "ENDSEC;\nEND-ISO-10303-21;",
            "
#110=IFCBOOLEANRESULT(.DIFFERENCE.,#26,#26);
ENDSEC;END-ISO-10303-21;",
        )
}
pub(super) fn reference_source() -> String {
    OVERLAP.replace(
        "'Body','SweptSolid',(#46)",
        "'Reference','GeometricSet',(#46)",
    )
}

pub(super) const TRANSLATION: [f64; 3] = [3_000_000., 4_000_000., 100.];
pub(super) fn translated_source() -> String {
    OVERLAP.replace("#8= IFCLOCALPLACEMENT($,#5);", "#8= IFCLOCALPLACEMENT($,#300);")
        .replace("ENDSEC;\nEND-ISO-10303-21;", "#300=IFCAXIS2PLACEMENT3D(#301,#4,#2);\n#301=IFCCARTESIANPOINT((3000000.,4000000.,100.));\nENDSEC;END-ISO-10303-21;")
}

// #7955 J2-R1: a real authored cutter survives beside each inserted member.
// The bool identifies malformed source; the count is the number of cuts before
// refusal (or all three authored cuts for a legitimate non-body sibling).
pub(super) fn representation_sibling_sources() -> Vec<(String, bool, usize)> {
    let wrong = "#147=IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,'wrong representation target',#148,(#148));#148=IFCPOLYLINE((#1,#24,#44,#1));";
    [
        (48, 47, false, wrong, true, 0),
        (48, 47, true, wrong, true, 0),
        (68, 67, false, wrong, true, 1),
        (48, 47, false, "#147=IFCSHAPEREPRESENTATION(#7,'Reference','GeometricSet',(#148));#148=IFCGEOMETRICSET((#1));", false, 3),
        (48, 47, false, "#147=IFCSHAPEREPRESENTATION(#7,'Box','BoundingBox',(#148));#148=IFCBOUNDINGBOX(#1,1.,1.,1.);", false, 3),
        (48, 47, false, "#147=IFCTOPOLOGYREPRESENTATION(#7,'Reference','Vertex',(#148));#148=IFCVERTEXPOINT(#1);", false, 3),
    ].into_iter().map(|(shape, valid, wrong_first, member, malformed, cuts)| {
        let members = if wrong_first { format!("#147,#{valid}") } else { format!("#{valid},#147") };
        let source = OVERLAP.replace(
            &format!("#{shape}= IFCPRODUCTDEFINITIONSHAPE($,$,(#{valid}));"),
            &format!("#{shape}= IFCPRODUCTDEFINITIONSHAPE($,$,({members}));"),
        ).replace("ENDSEC;\nEND-ISO-10303-21;", &format!("{member}\nENDSEC;END-ISO-10303-21;"));
        (source, malformed, cuts)
    }).collect()
}

// #7955: independent rectangular containment witnesses. The original host is
// [0,4] x [0,.2] x [0,3]; the replacement cutter is [-1,5] x [-.2,.4] x [-1,4].
pub(super) fn removal_sources() -> Vec<String> {
    let full = OVERLAP.replace("((1.5,0.1))", "((2.,0.1))")
        .replace("#42,1.,0.4)", "#42,6.,0.6)")
        .replace("((0.,0.,0.3))", "((0.,0.,-1.))")
        .replace("#43,#45,#4,1.2)", "#43,#45,#4,5.)");
    let placed = full.replace("#8= IFCLOCALPLACEMENT($,#5);", "#8= IFCLOCALPLACEMENT($,#300);")
        .replace("ENDSEC;\nEND-ISO-10303-21;", "#300=IFCAXIS2PLACEMENT3D(#301,#4,#2);#301=IFCCARTESIANPOINT((32.,64.,8.));\nENDSEC;END-ISO-10303-21;");
    let multi = full.replace("'SweptSolid',(#26)", "'SweptSolid',(#26,#126)")
        .replace("ENDSEC;\nEND-ISO-10303-21;", "#126=IFCEXTRUDEDAREASOLID(#23,#25,#4,3.);\nENDSEC;END-ISO-10303-21;");
    vec![full, placed, multi]
}
