// SPDX-License-Identifier: MPL-2.0
//! #7955 R1: exact-authored counterexamples; no runtime tolerance is an oracle.
use super::OVERLAP;
fn records(changes: &[(u32, &str)]) -> String {
    OVERLAP.lines().map(|line| {
        changes.iter().find(|(id,_)| line.starts_with(&format!("#{id}=")))
            .map(|(_,record)| *record).unwrap_or(line)
    }).collect::<Vec<_>>().join("\n")
}
pub(in super::super) fn equality() -> String {
    records(&[
        (26,"#26=IFCEXTRUDEDAREASOLID(#23,#25,#4,3.0000000000000001);"),
        (41,"#41=IFCCARTESIANPOINT((2.,0.1));"),
        (43,"#43=IFCRECTANGLEPROFILEDEF(.AREA.,'OpeningAProfile',#42,4.,0.2);"),
        (44,"#44=IFCCARTESIANPOINT((0.,0.,0.));"),
        (46,"#46=IFCEXTRUDEDAREASOLID(#43,#45,#4,3.);")])
}
pub(in super::super) fn cancellation() -> String {
    records(&[
        (21,"#21=IFCCARTESIANPOINT((-10000000000000000.,0.1));"),
        (23,"#23=IFCRECTANGLEPROFILEDEF(.AREA.,'WallProfile',#22,1.,0.2);"),
        (24,"#24=IFCCARTESIANPOINT((10000000000000000.4,0.,0.));"),
        (41,"#41=IFCCARTESIANPOINT((-10000000000000000.,0.1));"),
        (43,"#43=IFCRECTANGLEPROFILEDEF(.AREA.,'OpeningAProfile',#42,1.2,0.4);"),
        (44,"#44=IFCCARTESIANPOINT((10000000000000000.,0.,-1.));"),
        (46,"#46=IFCEXTRUDEDAREASOLID(#43,#45,#4,5.);")])
}
pub(in super::super) fn coframe() -> String {
    // Equal decoded translation 3, unequal authored origins by 10^-16.
    equality().replace("3.0000000000000001);", "3.);")
        .replace("#29= IFCLOCALPLACEMENT(#8,#5);", "#29=IFCLOCALPLACEMENT(#8,#300);")
        .replace("#49= IFCLOCALPLACEMENT(#8,#5);", "#49=IFCLOCALPLACEMENT(#8,#302);")
        .replace("ENDSEC;\nEND-ISO-10303-21;", "#300=IFCAXIS2PLACEMENT3D(#301,#4,#2);#301=IFCCARTESIANPOINT((3.0000000000000001,0.,0.));\n#302=IFCAXIS2PLACEMENT3D(#303,#4,#2);#303=IFCCARTESIANPOINT((3.,0.,0.));\nENDSEC;END-ISO-10303-21;")
}
pub(in super::super) fn cases() -> [(&'static str, String); 3] {
    [("J2_DECIMAL_EQUALITY",equality()),("J2_DECIMAL_CANCELLATION",cancellation()),("J2_DECIMAL_COFRAME",coframe())]
}
