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
