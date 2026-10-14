// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use ifc_lite_core::EntityScanner;

#[test]
fn malformed_apostrophe_pair_retains_intervening_records_and_original_spans_7541() {
    let content = "#20=IFCWALL('id20',$,'it's',$);\n#21=IFCWALL('id21',$,'W2',$);\n#22=IFCWALL('id22',$,$,$);\n#30=IFCDOOR('id30',$,'Bob's',$);\n#31=IFCWALL('id31',$,'W4',$);";
    for bytes in [false, true] {
        let mut scanner = if bytes { EntityScanner::new(content.as_bytes()) }
            else { EntityScanner::new(content) };
        let mut returned = Vec::new();
        while let Some((id, _, start, end)) = scanner.next_entity() { returned.push((id, start, end)); }
        let ids: Vec<_> = returned.iter().map(|&(id, _, _)| id).collect();
        eprintln!("7541 actual pair scanner: ids={ids:?}, malformed={}", scanner.malformed_record_start().is_some());
        for (id, start, end) in returned {
            assert_eq!(&content[start..end], content.lines().find(|r| r.starts_with(&format!("#{id}="))).unwrap());
        }
        assert_eq!(ids, [21, 22, 31]);
        assert!(scanner.malformed_record_start().is_some());
    }
}

#[test]
fn valid_multiline_and_record_like_literals_are_not_resynchronized_7541() {
    for literal in ["'it''s'", "'it'\n's'", "'text;\n#999=IFCWALL(''text'');'"] {
        let record = format!("#20=IFCWALL('id20',$,{literal},$);");
        let input = format!("{record}\n#21=IFCWALL($);");
        let mut scanner = EntityScanner::new(&input);
        let (id, _, start, end) = scanner.next_entity().unwrap();
        assert_eq!(id, 20);
        assert_eq!(&input[start..end], record);
        assert_eq!(scanner.next_entity().unwrap().0, 21);
        assert!(scanner.next_entity().is_none());
        assert_eq!(scanner.malformed_record_start(), None);
    }
}

#[test]
fn conservative_quote_recovery_cannot_mint_an_entity_from_later_literal_text_7541() {
    for (content, expected) in [
        ("#1=A('it's','valid;\n#999=B($);');\n#2=B($);", vec![2]),
        ("#1=A('it's','valid ''quote'';\n#999=B($);');\n#2=B($);", vec![2]),
        ("#1=A('it's','also bad'quote;\n#999=B($);');\n#2=B($);", vec![]),
        ("#1=A('it's','unclosed;\n#999=B($);\n#2=B($);", vec![]),
    ] {
        let mut scanner = EntityScanner::new(content);
        let mut ids = Vec::new();
        while let Some((id, _, _, _)) = scanner.next_entity() { ids.push(id); }
        eprintln!("7541 actual recovery scanner: ids={ids:?}, malformed={}", scanner.malformed_record_start().is_some());
        assert_eq!(ids, expected);
        assert!(scanner.malformed_record_start().is_some());
    }
}

#[test]
fn quote_suffix_unclosed_comment_cannot_enter_recovery_and_mint_ghost_entities_7541() {
    for (content, expected, malformed) in [
        ("#1=A('a' /* 'ghost',\n#999=B($);\n#2=B($);", vec![], true),
        ("#1=A('a' /* 'ghost',\n#999=B($); */,$);\n#2=B($);", vec![1, 2], false),
    ] {
        let mut scanner = EntityScanner::new(content);
        let mut ids = Vec::new();
        while let Some((id, _, _, _)) = scanner.next_entity() { ids.push(id); }
        assert_eq!(ids, expected);
        assert_eq!(scanner.malformed_record_start().is_some(), malformed);
    }
}
