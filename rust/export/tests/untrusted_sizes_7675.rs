// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Allocation sized by untrusted input in `ifc-lite-export` (#7675).

use ifc_lite_export::{export_step_with_log, MutationLog, StepOptions};

const SOURCE: &str = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#1=IFCWALL('3nZ2y9nY9FExK3Wg9nLvXz',$,'Wall',$,$,$,$,$,$);\n\
#2=IFCPROPERTYSET('0nZ2y9nY9FExK3Wg9nLvXz',$,'Pset_A',$,(#3));\n\
#3=IFCPROPERTYSINGLEVALUE('P',$,IFCLABEL('v'),$);\n\
#4=IFCRELDEFINESBYPROPERTIES('1nZ2y9nY9FExK3Wg9nLvXz',$,$,$,(#1),#2);\n\
ENDSEC;\nEND-ISO-10303-21;\n";

fn export(log: &str) -> String {
    let log = MutationLog::from_json(log).expect("log parses");
    export_step_with_log(SOURCE.as_bytes(), &StepOptions::default(), &log).expect("export succeeds").0
}

fn data_section(out: &str) -> &str {
    &out[out.find("DATA;").expect("a DATA section")..]
}

/// EXPORT-STEP-8: `"@N"` is the host's positional index. The relationship
/// index re-reads an edited `IfcRelDefinesByProperties` through its effective
/// record, which grew its attribute vector to `N + 1` slots, so this log asked
/// for ~1e11 slots and aborted the process. A slot past the class's declared
/// attributes has nothing to address: both writers already skip it, and the
/// TypeScript record keeps it as a sparse entry no reader looks up.
#[test]
fn export_step_8_a_positional_index_past_the_arity_is_not_an_allocation() {
    let out = export(
        r#"{"mutations":[{"type":"UPDATE_POSITIONAL_ATTRIBUTE","entityId":4,"attributeName":"@100000000000","newValue":"$"}]}"#,
    );
    let untouched = export(r#"{"mutations":[]}"#);
    assert_eq!(data_section(&out), data_section(&untouched));
}

/// The bound is the declared arity, not a guess: an index inside it still
/// reaches the slot (`Name`, index 2 of `IfcRelDefinesByProperties`).
#[test]
fn export_step_8_a_positional_index_inside_the_arity_still_applies() {
    let out = export(
        r#"{"mutations":[{"type":"UPDATE_POSITIONAL_ATTRIBUTE","entityId":4,"attributeName":"@2","newValue":"Named"}]}"#,
    );
    assert!(out.contains("#4=IFCRELDEFINESBYPROPERTIES('1nZ2y9nY9FExK3Wg9nLvXz',$,'Named',$,(#1),#2);"), "{out}");
}
