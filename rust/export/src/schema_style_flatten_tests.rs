// SPDX-License-Identifier: MPL-2.0
use super::*;

fn flatten(records: &[&str]) -> StyleFlatten {
    let content = format!("DATA;\n{}\nENDSEC;\n", records.join("\n"));
    StyleFlatten::build(content.as_bytes(), "IFC4", "IFC4X3").expect("holds an assignment")
}

#[test]
fn only_a_2x3_or_4_to_4x3_conversion_flattens() {
    for (from, to, expect) in [
        ("IFC2X3", "IFC4X3", true),
        ("IFC4", "IFC4X3", true),
        ("IFC4X3", "IFC4", false),
        ("IFC4", "IFC2X3", false),
        ("IFC2X3", "IFC4", false),
        ("IFC5", "IFC4X3", false),
    ] {
        assert_eq!(StyleFlatten::applies(from, to), expect, "{from} -> {to}");
    }
    assert!(StyleFlatten::build(b"DATA;\n#1=IFCWALL($);\nENDSEC;", "IFC4", "IFC4X3").is_none());
}

#[test]
fn an_assignment_after_its_styled_item_is_still_flattened() {
    let f = flatten(&["#1=IFCSTYLEDITEM(#9,(#2),$);", "#2=IFCPRESENTATIONSTYLEASSIGNMENT((#3,#4));"]);
    assert!(f.drops(2) && !f.drops(1));
    assert_eq!(f.rewrite("IFC4", "#1=IFCSTYLEDITEM(#9,(#2),$);"), Flat::Write("#1=IFCSTYLEDITEM(#9,(#3,#4),$);".into()));
}

#[test]
fn a_non_styled_record_is_left_alone() {
    let f = flatten(&["#2=IFCPRESENTATIONSTYLEASSIGNMENT((#3));"]);
    assert_eq!(f.rewrite("IFC4", "#7=IFCWALL('g',#2,$,$,$,$,$,$,$);"), Flat::Keep);
    assert_eq!(f.rewrite("IFC4", "#7=IFCSTYLEDITEM(#9,(#5),$);"), Flat::Keep);
}

/// A styled item left with no style is dropped; a single slot naming it is
/// written `$`, a list loses the member, nested lists too (#7801 round 3).
#[test]
fn an_emptied_styled_item_is_dropped_and_unreferenced() {
    let f = flatten(&["#1=IFCSTYLEDITEM(#9,(#2),$);", "#2=IFCPRESENTATIONSTYLEASSIGNMENT((IFCNULLSTYLE(.NULL.)));"]);
    assert!(f.drops(1) && f.drops(2));
    assert_eq!(f.rewrite("IFC4", "#1=IFCSTYLEDITEM(#9,(#2),$);"), Flat::Drop);
    assert_eq!(f.rewrite("IFC4", "#3=IFCX(#1,(#4,#1),((#1)),'#1');"), Flat::Write("#3=IFCX($,(#4),(()),'#1');".into()));
    assert_eq!(f.rewrite("IFC4", "#3=IFCX(#11,(#4,#10));"), Flat::Keep);
}

/// An edit that empties a source assignment empties its styled items too;
/// one that refills it keeps them.
#[test]
fn edits_reach_the_emptied_set() {
    let src = "DATA;\n#1=IFCSTYLEDITEM(#9,(#2),$);\n#2=IFCPRESENTATIONSTYLEASSIGNMENT((#3));\nENDSEC;\n";
    let mut f = StyleFlatten::build(src.as_bytes(), "IFC4", "IFC4X3").unwrap();
    let edits = HashMap::from([(2, std::collections::BTreeMap::from([(0, "(IFCNULLSTYLE(.NULL.))".to_string())]))]);
    f.note_edits(src.as_bytes(), &[], &edits);
    assert!(f.drops(1), "the edit empties #2, so #1 has no style left");
    let edits = HashMap::from([(1, std::collections::BTreeMap::from([(1, "(#2,#4)".to_string())]))]);
    f.note_edits(src.as_bytes(), &[], &edits);
    assert!(!f.drops(1), "#1 now names #4 too");
}

/// A list nested past `MAX_DEPTH` is left as it is rather than walked.
#[test]
fn deep_nesting_is_bounded() {
    let f = flatten(&["#1=IFCSTYLEDITEM(#9,(#2),$);", "#2=IFCPRESENTATIONSTYLEASSIGNMENT((IFCNULLSTYLE(.NULL.)));"]);
    let deep = format!("#3=IFCX({}#1{});", "(".repeat(100_000), ")".repeat(100_000));
    assert_eq!(f.rewrite("IFC4", &deep), Flat::Keep);
}
