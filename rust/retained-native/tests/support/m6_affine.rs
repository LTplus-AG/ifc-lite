// SPDX-License-Identifier: MPL-2.0
const SOURCE: &str = include_str!("../../../../tests/fixtures/synthetic-retained/f-f-halfspaces.ifc");
pub fn affine_boxed() -> String {
    SOURCE.replace("#383=IFCSHAPEREPRESENTATION(#4,'Body','CSG',(#345));",
        "#383=IFCSHAPEREPRESENTATION(#4,'Body','MappedRepresentation',(#9004));\n\
         #9001=IFCSHAPEREPRESENTATION(#4,'Body','CSG',(#345));\n\
         #9002=IFCREPRESENTATIONMAP(#2,#9001);\n\
         #9003=IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM(#9005,#9006,#1,2.,#3,3.,1.);\n\
         #9004=IFCMAPPEDITEM(#9002,#9003);\n\
         #9005=IFCDIRECTION((-1.,0.,0.));\n\
         #9006=IFCDIRECTION((0.,1.,0.));")
}
