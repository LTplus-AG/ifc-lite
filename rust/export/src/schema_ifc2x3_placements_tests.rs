// SPDX-License-Identifier: MPL-2.0
use std::io::Write;

use super::*;

const GRID: &str = "#1=IFCCARTESIANPOINT((0.,0.));
#2=IFCCARTESIANPOINT((12.,0.));
#3=IFCCARTESIANPOINT((0.,8.));
#4=IFCPOLYLINE((#1,#2));
#5=IFCPOLYLINE((#1,#3));
#6=IFCGRIDAXIS('A',#4,.T.);
#7=IFCGRIDAXIS('1',#5,.T.);
#20=IFCGRID('2$abcdefghijklmnopqrst1',$,$,$,$,$,$,(#7),(#6),$);
#30=IFCVIRTUALGRIDINTERSECTION((#7,#6),(4.,5.));
#40=IFCGRIDPLACEMENT(#30,$);
";

#[test]
fn reads_step_reals_as_the_typescript_twin_does() {
    for (token, value) in [("0.", Some(0.0)), ("-1.5E-3", Some(-0.0015)), (" .5 ", Some(0.5)), ("+2", Some(2.0))] {
        assert_eq!(num(token), value, "{token}");
    }
    for token in ["", ".", "-.", "1e", "0x10", "inf", "NaN", "1.0.0", "$"] {
        assert_eq!(num(token), None, "{token}");
    }
}

#[test]
fn a_file_with_no_placement_is_not_rebuilt() {
    assert!(place_each_object_once("#1=IFCCARTESIANPOINT((0.,0.));\n").is_none());
}

#[test]
fn a_dropped_record_takes_its_separator_and_keeps_what_surrounds_it() {
    let body = format!("\n{GRID}#99=IFCPROPERTYSINGLEVALUE('p',$,IFCLABEL('#40'),$);\n");
    let placed = place_each_object_once(&body).expect("a placement nothing places is not written");
    assert!(!placed.body.contains("#40=") && !placed.body.contains("#30="), "{}", placed.body);
    assert!(placed.body.starts_with("\n#1=") && placed.body.ends_with("$);\n"), "{:?}", placed.body);
    assert_eq!((placed.added, placed.removed), (0, 2));
}

#[test]
fn a_placement_named_where_no_product_or_placement_names_it_is_left_alone() {
    let body = format!("{GRID}#99=IFCRELCONNECTSELEMENTS('g',$,$,$,#40,#40,#40);\n");
    assert!(place_each_object_once(&body).is_none());
}

#[test]
fn the_held_body_passes_other_schemas_straight_through() {
    let mut out = Vec::new();
    let mut body = Body::new(&mut out, false);
    body.write_all(GRID.as_bytes()).unwrap();
    assert_eq!(body.finish().unwrap(), 0);
    assert_eq!(out, GRID.as_bytes());

    let mut out = Vec::new();
    let mut body = Body::new(&mut out, true);
    body.write_all(GRID.as_bytes()).unwrap();
    assert_eq!(body.finish().unwrap(), -2);
    assert!(!String::from_utf8(out).unwrap().contains("IFCGRIDPLACEMENT"));
}
