// SPDX-License-Identifier: MPL-2.0
//! The delete fixture of [`super`]: a host and everything deleting it
//! reaches. Synthetic, like the rest.

use super::{defines_by_properties, entity_line, gid, header, local_placement_at, preamble, pset, quoted, single_value, wall, FOOTER};

/// A host wall (`#10`) with everything a delete of it reaches, and a second
/// wall (`#11`) that survives it:
///
/// - a port `#14` nested on it (`IfcRelNests` `#18`; also
///   `IfcRelConnectsPortToElement` `#19` where the schema declares it), placed
///   relative to the host's placement `#20`;
/// - its type `#40` (own set `#42`/`#41`) through `IfcRelDefinesByType` `#43`;
/// - a set `#31`/`#30` shared with `#11` through `#32`, and its own set
///   `#34`/`#33` through `#35`;
/// - its own body `#60`..`#66`;
/// - an opening `#70` voiding it through `#71`, placed at `#72`..`#74`,
///   with its own set `#76`/`#75` through `#77` (a second referrer).
pub(in crate::plan) fn host_with_port_type_and_body(schema: &str) -> Vec<u8> {
    let rooted = |id: u32| quoted(&gid(id));
    let mut data = entity_line(
        schema,
        10,
        "IFCWALL",
        &[("GlobalId", &rooted(10)), ("Name", "'Host'"), ("ObjectPlacement", "#20"), ("Representation", "#60")],
    );
    data += &wall(schema, 11, "Survivor", 23);
    data += &local_placement_at(20, 21, 22, 0.0);
    data += &local_placement_at(23, 24, 25, 1.0);
    data += &entity_line(schema, 14, "IFCDISTRIBUTIONPORT", &[("GlobalId", &rooted(14)), ("Name", "'Port'"), ("ObjectPlacement", "#15")]);
    data += "#15=IFCLOCALPLACEMENT(#20,#16);\n#16=IFCAXIS2PLACEMENT3D(#17,$,$);\n#17=IFCCARTESIANPOINT((0.5,0.,0.));\n";
    data += &entity_line(schema, 18, "IFCRELNESTS", &[("GlobalId", &rooted(18)), ("RelatingObject", "#10"), ("RelatedObjects", "(#14)")]);
    if ifc_lite_core::attribute_names_for_schema(schema, "IFCRELCONNECTSPORTTOELEMENT").is_some() {
        data += &entity_line(
            schema,
            19,
            "IFCRELCONNECTSPORTTOELEMENT",
            &[("GlobalId", &rooted(19)), ("RelatingPort", "#14"), ("RelatedElement", "#10")],
        );
    }
    data += &single_value(30, "FireRating", "IFCLABEL", "'1HR'");
    data += &pset(schema, 31, "Pset_WallCommon", 30);
    data += &defines_by_properties(schema, 32, "(#10,#11)", 31);
    data += &single_value(33, "Reference", "IFCIDENTIFIER", "'H-1'");
    data += &pset(schema, 34, "Pset_Own", 33);
    data += &defines_by_properties(schema, 35, "(#10)", 34);
    data += &entity_line(
        schema,
        40,
        "IFCWALLTYPE",
        &[("GlobalId", &rooted(40)), ("Name", "'WallType 1'"), ("HasPropertySets", "(#42)"), ("PredefinedType", ".NOTDEFINED.")],
    );
    data += &single_value(41, "FireRating", "IFCLABEL", "'2HR'");
    data += &pset(schema, 42, "Pset_WallCommon", 41);
    data += &entity_line(schema, 43, "IFCRELDEFINESBYTYPE", &[("GlobalId", &rooted(43)), ("RelatedObjects", "(#10)"), ("RelatingType", "#40")]);
    data += "#60=IFCPRODUCTDEFINITIONSHAPE($,$,(#61));\n";
    data += "#61=IFCSHAPEREPRESENTATION(#100,'Body','SweptSolid',(#62));\n";
    data += "#62=IFCEXTRUDEDAREASOLID(#63,$,#64,3.);\n";
    data += &entity_line(schema, 63, "IFCRECTANGLEPROFILEDEF", &[("ProfileType", ".AREA."), ("Position", "#65"), ("XDim", "1."), ("YDim", "1.")]);
    data += "#64=IFCDIRECTION((0.,0.,1.));\n#65=IFCAXIS2PLACEMENT2D(#66,$);\n#66=IFCCARTESIANPOINT((0.5,0.5));\n";
    data += &entity_line(schema, 70, "IFCOPENINGELEMENT", &[("GlobalId", &rooted(70)), ("Name", "'Opening'"), ("ObjectPlacement", "#72")]);
    data += &entity_line(schema, 71, "IFCRELVOIDSELEMENT", &[("GlobalId", &rooted(71)), ("RelatingBuildingElement", "#10"), ("RelatedOpeningElement", "#70")]);
    data += "#72=IFCLOCALPLACEMENT(#20,#73);\n#73=IFCAXIS2PLACEMENT3D(#74,$,$);\n#74=IFCCARTESIANPOINT((0.2,0.,0.));\n";
    data += &single_value(75, "Reference", "IFCIDENTIFIER", "'O-1'");
    data += &pset(schema, 76, "Pset_OpeningCommon", 75);
    data += &defines_by_properties(schema, 77, "(#70)", 76);
    format!("{}{}{}{}", header(schema), preamble(schema), data, FOOTER).into_bytes()
}
