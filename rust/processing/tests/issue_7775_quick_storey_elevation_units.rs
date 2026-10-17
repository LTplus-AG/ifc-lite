// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! PROCESSING-18 (#7775): the quick-metadata bootstrap reports a storey's
//! elevation in METRES, like every other number on the response and like the
//! server data model and the TS parser. It used to ship file units: a
//! millimetre file said `elevation: 3000.0` for a storey three metres up.

mod common;

use common::quick_metadata::{bootstrap, child, tree};

/// A project whose length unit carries the `IfcSIUnit` prefix token `prefix`
/// (`$` for metres), one building and two storeys with the given `Elevation`s.
fn file(prefix: &str, storey_a: &str, storey_b: &str) -> String {
    format!(
        "ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-7775 elevation units'),'2;1');
FILE_NAME('elev.ifc','2026-10-17T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('7775Project00000000001',$,'P',$,$,$,$,$,#3);
#3=IFCUNITASSIGNMENT((#6));
#6=IFCSIUNIT(*,.LENGTHUNIT.,{prefix},.METRE.);
#21=IFCBUILDING('7775Building0000000001',$,'B',$,$,$,$,$,.ELEMENT.,$,$,$);
#30=IFCBUILDINGSTOREY('7775StoreyA00000000001',$,'A',$,$,$,$,$,.ELEMENT.,{storey_a});
#31=IFCBUILDINGSTOREY('7775StoreyB00000000001',$,'B',$,$,$,$,$,.ELEMENT.,{storey_b});
#90=IFCRELAGGREGATES('7775Agg1000000000000001',$,$,$,#1,(#21));
#91=IFCRELAGGREGATES('7775Agg2000000000000002',$,$,$,#21,(#30,#31));
ENDSEC;
END-ISO-10303-21;
"
    )
}

fn elevation_of(ifc: &str, storey: u32) -> Option<f64> {
    let bootstrap = bootstrap(ifc);
    child(child(tree(&bootstrap), 21), storey).summary.elevation
}

#[test]
fn millimetre_storey_elevation_is_in_metres() {
    let ifc = file(".MILLI.", "3000.", "-1500.");
    assert_eq!(elevation_of(&ifc, 30), Some(3.0));
    assert_eq!(elevation_of(&ifc, 31), Some(-1.5));
}

#[test]
fn metre_storey_elevation_is_unchanged() {
    let ifc = file("$", "3.", "-1.5");
    assert_eq!(elevation_of(&ifc, 30), Some(3.0));
    assert_eq!(elevation_of(&ifc, 31), Some(-1.5));
}

#[test]
fn the_local_coordinate_fallback_compares_in_metres() {
    // `Elevation` is `$`, so the first numeric attribute inside the
    // large-coordinate threshold is taken. 1 200 000 mm is 1.2 km, a world
    // coordinate, and is skipped; 2500 mm is 2.5 m, a local one. Compared in
    // raw file units, 2500 > 1000 was rejected too and the scan took nothing
    // (or whatever smaller number came first).
    let mut ifc = file(".MILLI.", "$", "$");
    ifc = ifc.replace(
        "#31=IFCBUILDINGSTOREY('7775StoreyB00000000001',$,'B',$,$,$,$,$,.ELEMENT.,$);",
        "#31=IFCBUILDINGSTOREY('7775StoreyB00000000001',$,'B',$,$,1200000.,2500.,$,.ELEMENT.,$);",
    );
    assert_eq!(elevation_of(&ifc, 31), Some(2.5));
}
