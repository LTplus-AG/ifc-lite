// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use ifc_lite_core::EntityScanner;
use ifc_lite_export::{export_step, export_step_to_writer, export_step_with_stats, export_step_with_log,
    export_step_with_log_to_writer, MutationLog, StepOptions};

/// #7541: a real canonical index can retain valid later records while omitting
/// malformed input. That partial index must not become a successful export.
#[test]
fn malformed_multi_record_export_refuses_before_any_writer_output_7541() {
    for (name, source) in [
        ("bad apostrophe", "#1=A('it's');\n#2=B($);\n#3=C($);\n"),
        ("missing terminator", "#1=A($)\n#2=B($);\n#3=C($);\n"),
    ] {
        let bytes = source.as_bytes();
        let mut scanner = EntityScanner::new(bytes);
        let mut retained = Vec::new();
        while let Some((id, _, _, _)) = scanner.next_entity() { retained.push(id); }
        let incomplete = scanner.malformed_record_start().is_some();
        eprintln!("7541 actual export prerequisite: case={name}, ids={retained:?}, malformed={incomplete}");
        assert_eq!(retained, vec![2, 3], "the actual source must retain later valid records");
        assert!(incomplete, "the canonical source producer must report the omission");
        let options = StepOptions::default();
        let mut output = Vec::new();
        let result = export_step_to_writer(bytes, &options, &mut output);
        assert!(result.is_err(), "7541 incomplete-source writer must refuse, not export retained subset");
        assert_eq!(result.err().expect("malformed source must refuse").kind(), std::io::ErrorKind::InvalidData);
        assert!(output.is_empty(), "no header or partial entity output may reach the real writer");
        assert_eq!(export_step(bytes, &options).unwrap_err().kind(), std::io::ErrorKind::InvalidData);
        assert_eq!(export_step_with_stats(bytes, &options).err().expect("malformed source must refuse").kind(), std::io::ErrorKind::InvalidData);
    }
}

#[test]
fn valid_multi_record_export_preserves_doubled_quotes_and_all_entry_points_7541() {
    let source = b"#1=A('it''s');\n#2=B($);\n#3=C($);\n";
    let options = StepOptions::default();
    let expected = export_step(source, &options).unwrap();
    let (with_stats, _) = export_step_with_stats(source, &options).unwrap();
    let mut written = Vec::new();
    export_step_to_writer(source, &options, &mut written).unwrap();
    assert_eq!(with_stats, expected);
    assert_eq!(String::from_utf8(written).unwrap(), expected);
    assert!(expected.contains("#1=A('it''s');"));
    assert!(expected.contains("#2=B($);"));
    assert!(expected.contains("#3=C($);"));
}

/// #7541: the mutation-log exporter has its own canonical source index. The
/// actual partial producer must not become a successful save through that path.
#[test]
fn malformed_log_export_refuses_before_replay_or_writer_output_7541() {
    for (name, source) in [
        ("bad apostrophe", "#1=A('it's');\n#2=B($);\n#3=C($);\n"),
        ("missing terminator", "#1=A($)\n#2=B($);\n#3=C($);\n"),
    ] {
        let mut scanner = EntityScanner::new(source.as_bytes());
        let mut retained = Vec::new();
        while let Some((id, _, _, _)) = scanner.next_entity() { retained.push(id); }
        let incomplete = scanner.malformed_record_start().is_some();
        eprintln!("7541 actual log export prerequisite: case={name}, ids={retained:?}, malformed={incomplete}");
        assert_eq!(retained, vec![2, 3]);
        assert!(incomplete);
        let mut written = Vec::new();
        let result = export_step_with_log_to_writer(source.as_bytes(), &StepOptions::default(), &MutationLog::default(), &mut written);
        assert!(result.is_err(), "7541 incomplete-source log writer must refuse the retained subset");
        assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::InvalidData);
        assert!(written.is_empty(), "the log writer must not write a header or partial entities");
        assert_eq!(export_step_with_log(source.as_bytes(), &StepOptions::default(), &MutationLog::default()).unwrap_err().kind(), std::io::ErrorKind::InvalidData);
    }
}

#[test]
fn valid_log_export_applies_actual_name_edit_without_losing_clean_source_7541() {
    let source = include_str!("../../../tests/fixtures/step-apostrophe-pair.ifc")
        .replace("it's", "it''s").replace("Bob's", "Bob''s");
    let log = MutationLog::from_json(r#"{"mutations":[{"type":"UPDATE_ATTRIBUTE","entityId":21,"attributeName":"Name","newValue":"Authored edit"}]}"#).unwrap();
    let (exported, _) = export_step_with_log(source.as_bytes(), &StepOptions::default(), &log).unwrap();
    let mut written = Vec::new();
    export_step_with_log_to_writer(source.as_bytes(), &StepOptions::default(), &log, &mut written).unwrap();
    assert_eq!(String::from_utf8(written).unwrap(), exported);
    assert!(exported.contains("'Authored edit'"));
    let mut scanner = EntityScanner::new(exported.as_bytes());
    let mut retained = Vec::new();
    while let Some((id, _, _, _)) = scanner.next_entity() { retained.push(id); }
    assert_eq!(retained, vec![1, 2, 3, 20, 21, 22, 30, 31]);
    assert_eq!(scanner.malformed_record_start(), None);
}
