// SPDX-License-Identifier: MPL-2.0
//! #7955 fixed analytic finite-domain oracles, specified before SDK execution.
use super::retained_clip::{Case, SOURCE};
const RECT: &str = "#401=IFCCARTESIANPOINT((-0.5,-1.));#402=IFCCARTESIANPOINT((0.5,-1.));#403=IFCCARTESIANPOINT((0.5,1.));#404=IFCCARTESIANPOINT((-0.5,1.));#400=IFCPOLYLINE((#401,#402,#403,#404,#401));";
pub fn polygon(boundary: &str, position: &str) -> String {
    SOURCE.replace("IFCHALFSPACESOLID(#202,.T.)", &format!("IFCPOLYGONALBOUNDEDHALFSPACE(#202,.T.,{position},#400)"))
        .replace("ENDSEC;END-ISO", &format!("{boundary}ENDSEC;END-ISO"))
}
pub fn boxed() -> String {
    SOURCE.replace("IFCHALFSPACESOLID(#202,.T.)", "IFCBOXEDHALFSPACE(#202,.T.,#400)")
        .replace("ENDSEC;END-ISO", "#401=IFCCARTESIANPOINT((-0.25,-0.5,-0.5));#400=IFCBOUNDINGBOX(#401,0.5,1.,0.75);ENDSEC;END-ISO")
}
pub fn cases() -> Vec<Case> {
    let rect = polygon(RECT,"#5");
    let l = polygon("#401=IFCCARTESIANPOINT((-0.5,-1.));#402=IFCCARTESIANPOINT((0.5,-1.));#403=IFCCARTESIANPOINT((0.5,0.));#404=IFCCARTESIANPOINT((0.,0.));#405=IFCCARTESIANPOINT((0.,1.));#406=IFCCARTESIANPOINT((-0.5,1.));#400=IFCPOLYLINE((#401,#402,#403,#404,#405,#406,#401));","#5");
    let shifted = polygon(&format!("{RECT}#410=IFCCARTESIANPOINT((0.,0.5,0.));#411=IFCDIRECTION((0.,1.,0.));#412=IFCAXIS2PLACEMENT3D(#410,$,#411);"),"#412");
    let indexed = polygon("#401=IFCCARTESIANPOINTLIST2D(((-0.5,-1.),(0.5,-1.),(0.5,1.),(-0.5,1.)));#400=IFCINDEXEDPOLYCURVE(#401,(IFCLINEINDEX((1,2,3)),IFCLINEINDEX((3,4,1))),.F.);","#5");
    let mut cases = Vec::new();
    // Independent areas/first moments, not values derived from the clip plan.
    for (name, source, volume, bounds, centroid) in [
        ("finite_rectangle",rect,2.,[-0.5,-1.,0.,0.5,1.,1.],[0.,0.,0.5]),
        ("finite_concave_l",l,1.5,[-0.5,-1.,0.,0.5,1.,1.],[-1./12.,-1./6.,0.5]),
        ("finite_polygon_placed",shifted,2.,[-1.,0.,0.,1.,1.,1.],[0.,0.5,0.5]),
        ("finite_indexed",indexed,2.,[-0.5,-1.,0.,0.5,1.,1.],[0.,0.,0.5]),
        ("finite_box",boxed(),0.25,[-0.25,-0.5,0.5,0.25,0.5,1.],[0.,0.,0.75]),
    ] {
        cases.push(Case {name,source:source.replace(".DIFFERENCE.",".INTERSECTION."),volume,bounds,centroid});
        cases.push(Case {name:match name {
            "finite_rectangle"=>"finite_rectangle_difference", "finite_concave_l"=>"finite_concave_l_difference",
            "finite_polygon_placed"=>"finite_polygon_placed_difference", "finite_indexed"=>"finite_indexed_difference",
            _=>"finite_box_difference"},source,volume:24.-volume,bounds:[-1.,-2.,0.,1.,2.,3.],
            centroid:[-volume*centroid[0]/(24.-volume),-volume*centroid[1]/(24.-volume),(36.-volume*centroid[2])/(24.-volume)]});
    }
    // Enclosure coordinates are relative to the independently rotated plane
    // placement. False agreement retains z=[1,1.25], not z=[0.5,1].
    cases.push(Case {name:"finite_box_false_rotated",source:boxed().replace(".DIFFERENCE.",".INTERSECTION.")
        .replace("#202,.T.","#202,.F.").replace("#200,#15,$", "#200,#15,#411")
        .replace("ENDSEC;END-ISO","#411=IFCDIRECTION((0.,1.,0.));ENDSEC;END-ISO"),
        volume:0.125,bounds:[-0.5,-0.25,1.,0.5,0.25,1.25],centroid:[0.,0.,1.125]});
    // Same physical object in millimetres. STEP is deliberately written afresh,
    // not a numerical rescale of the derived operation planes.
    cases.push(Case {name:"finite_box_millimetres",source:boxed().replace(".DIFFERENCE.",".INTERSECTION.")
        .replace("$,.METRE.",".MILLI.,.METRE.").replace("#15,3.","#15,3000.")
        .replace("$,$,2.,4.","$,$,2000.,4000.").replace("((0.,0.,1.));#201","((0.,0.,1000.));#201")
        .replace("((-0.25,-0.5,-0.5))","((-250.,-500.,-500.))").replace("#401,0.5,1.,0.75", "#401,500.,1000.,750."),
        volume:0.25,bounds:[-0.25,-0.5,0.5,0.25,0.5,1.],centroid:[0.,0.,0.75]});
    cases
}
