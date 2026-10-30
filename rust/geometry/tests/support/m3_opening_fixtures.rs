// SPDX-License-Identifier: MPL-2.0
//! #7955 regression-only variants of issue_2019; not authored-model qualification.
pub fn two_parts_two_openings() -> String {
    // Two disjoint 4 x .2 x 1.2 host parts, z=[0,1.2] and [1.8,3].
    // Both openings span z=[0,3] and intersect BOTH parts. Their XY union
    // removes area 4/15 per part (issue_2019's hand-derived AB oracle), so
    // each final part has volume 1.2 * (.8 - 4/15) = 16/25 m³.
    include_str!("../../../processing/tests/fixtures/issue_2019_wall_two_overlapping_openings.ifc")
        .replace("#26= IFCEXTRUDEDAREASOLID(#23,#25,#4,3.);",
            "#26= IFCEXTRUDEDAREASOLID(#23,#25,#4,1.2);\n\
             #201=IFCCARTESIANPOINT((0.,0.,1.8));\n\
             #202=IFCAXIS2PLACEMENT3D(#201,#4,#2);\n\
             #203=IFCEXTRUDEDAREASOLID(#23,#202,#4,1.2);")
        .replace("'SweptSolid',(#26)", "'SweptSolid',(#26,#203)")
        .replace("((0.,0.,0.3))", "((0.,0.,0.))")
        .replace("#43,#45,#4,1.2)", "#43,#45,#4,3.)")
        .replace("#63,#65,#4,1.2)", "#63,#65,#4,3.)")
        .lines().filter(|line| !line.starts_with("#82="))
        .collect::<Vec<_>>().join("\n")
}
