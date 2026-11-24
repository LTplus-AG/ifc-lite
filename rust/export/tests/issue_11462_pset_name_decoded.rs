// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Rust parity pin for #11462 (TypeScript half:
//! `packages/export/src/pset-name-directive-match.test.ts`). A source set
//! whose name needs STEP escapes must be matched by its DECODED name, so
//! editing one property replaces the source set instead of leaving it beside
//! a regenerated copy.

use ifc_lite_export::{export_step_with_log, MutationLog, StepOptions};

const NAMES: [(&str, &str, &str); 4] = [
    ("non-ASCII letter", r"Pset_\X2\0103\X0\", "Pset_ă"),
    ("apostrophe", "Pset_O''Brien", "Pset_O'Brien"),
    ("backslash", r"Pset_C:\\x", r"Pset_C:\x"),
    ("beyond the BMP", r"Pset_\X4\0001F3E0\X0\", "Pset_\u{1F3E0}"),
];

fn export(raw: &str, decoded: &str) -> String {
    let src = format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('t.ifc','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#10=IFCWALL('0wall00000000000000001',$,'W',$,$,$,$,$,$);\n\
#11=IFCPROPERTYSINGLEVALUE('Keep',$,IFCLABEL('k'),$);\n\
#12=IFCPROPERTYSINGLEVALUE('Edit',$,IFCLABEL('old'),$);\n\
#13=IFCPROPERTYSET('0pset00000000000000001',$,'{raw}',$,(#11,#12));\n\
#14=IFCRELDEFINESBYPROPERTIES('0rel000000000000000001',$,$,$,(#10),#13);\n\
ENDSEC;\nEND-ISO-10303-21;\n"
    );
    let log = serde_json::json!({"modelId":"m","exportedAt":0,"mutations":[{
        "id":"m1","type":"UPDATE_PROPERTY","timestamp":0,"modelId":"m","entityId":10,
        "psetName":decoded,"propName":"Edit","oldValue":"old","newValue":"new","valueType":0}]});
    let log = MutationLog::from_json(&log.to_string()).expect("log parses");
    let opts = StepOptions { time_stamp: Some("2020-01-01T00:00:00".into()), ..StepOptions::default() };
    export_step_with_log(src.as_bytes(), &opts, &log).expect("export succeeds").0
}

#[test]
fn editing_a_set_with_an_escaped_name_replaces_it() {
    for (label, raw, decoded) in NAMES {
        let out = export(raw, decoded);
        let sets: Vec<&str> = out.lines().filter(|l| l.contains("=IFCPROPERTYSET(")).collect();
        assert_eq!(sets.len(), 1, "{label}: exactly one set expected:\n{out}");
        assert!(out.contains("IFCLABEL('new')"), "{label}: edited value written");
        assert!(!out.contains("IFCLABEL('old')"), "{label}: old value gone");
    }
}
