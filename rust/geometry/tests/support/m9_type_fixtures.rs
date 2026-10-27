// SPDX-License-Identifier: MPL-2.0
//! #7955 M9 inline sources. Boxes are 1 x 1 x 1 m; union overlaps by 0.5 m.
#![allow(dead_code)] // The native, browser and scheduler witnesses use different variants.
pub const SOURCE: &str = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);
#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);#4=IFCUNITASSIGNMENT((#3));
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#2,$);
#6=IFCDIRECTION((0.,0.,1.));#7=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,1.,1.);
#8=IFCEXTRUDEDAREASOLID(#7,#2,#6,1.);
#9=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#8));
#10=IFCREPRESENTATIONMAP(#2,#9);
#11=IFCPROJECT('p',$,$,$,$,$,$,(#5),#4);
#20=IFCBOILERTYPE('t',$,'Orphan',$,$,$,(#10),$,$,.NOTDEFINED.);
ENDSEC;END-ISO-10303-21;";
pub fn insert(source: &str, records: &str) -> String {
    source.replace("ENDSEC;END-ISO", &format!("{records}ENDSEC;END-ISO"))
}
pub fn rotated() -> String {
    insert(&SOURCE.replace("#10=IFCREPRESENTATIONMAP(#2,#9)", "#10=IFCREPRESENTATIONMAP(#32,#9)"),
        "#30=IFCCARTESIANPOINT((2600000.,1200000.,0.));#31=IFCDIRECTION((0.8660254037844386,0.5,0.));#32=IFCAXIS2PLACEMENT3D(#30,#6,#31);")
}
pub fn boolean() -> String {
    insert(&SOURCE.replace("'SweptSolid',(#8)", "'CSG',(#33)"),
        "#30=IFCCARTESIANPOINT((0.5,0.,0.));#31=IFCAXIS2PLACEMENT3D(#30,$,$);#32=IFCEXTRUDEDAREASOLID(#7,#31,#6,1.);#33=IFCBOOLEANRESULT(.UNION.,#8,#32);")
}
pub fn mirrored() -> String {
    insert(&SOURCE.replace("'SweptSolid',(#8)", "'MappedRepresentation',(#34)"),
        "#30=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#8));#31=IFCREPRESENTATIONMAP(#2,#30);#32=IFCDIRECTION((-1.,0.,0.));#35=IFCDIRECTION((0.,1.,0.));#33=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#32,#35,#1,1.,#6);#34=IFCMAPPEDITEM(#31,#33);")
}
pub fn unsupported_second() -> String {
    insert(&SOURCE.replace("(#10),$,$,.NOTDEFINED.", "(#10,#32),$,$,.NOTDEFINED."),
        "#30=IFCPOLYGONALFACESET($,$,$,$);#31=IFCSHAPEREPRESENTATION(#5,'Body','Tessellation',(#30));#32=IFCREPRESENTATIONMAP(#2,#31);")
}
pub fn curves() -> String {
    insert(&SOURCE.replace("'Body','SweptSolid',(#8)", "'Annotation','Annotation2D',(#31)"),
        "#30=IFCPOLYLINE((#1,#1));#31=IFCGEOMETRICCURVESET((#30));")
}
pub fn instanced() -> String {
    insert(SOURCE, "#30=IFCWALL('w',$,$,$,$,$,$,$,$);#31=IFCRELDEFINESBYTYPE('r',$,$,$,(#30),#20);")
}
