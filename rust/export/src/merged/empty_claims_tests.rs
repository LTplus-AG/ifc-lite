// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use std::collections::{HashMap, HashSet};

use super::super::super::plan::ModelIndex;
use super::StructureClaims;

fn file(entities: &str) -> String {
    format!("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n{entities}ENDSEC;\nEND-ISO-10303-21;\n")
}

fn withheld(claims: &mut StructureClaims, text: &str, remap: &[(u32, u32)], base: u32, dedupe: bool) -> HashSet<(u32, u32)> {
    let index = ModelIndex::build(text.as_bytes());
    let included: HashSet<u32> = index.order.iter().copied().collect();
    let remap: HashMap<u32, u32> = remap.iter().copied().collect();
    claims.withheld(&index, &included, &remap, base, dedupe)
}

const FIRST: &str = "#1=IFCSITE('s',$,$,$,$,$,$,$,$,$,$,$,$,$);\n#2=IFCBUILDING('b',$,$,$,$,$,$,$,$,$,$,$);\n#3=IFCRELAGGREGATES('r',$,$,$,#1,(#2));\n";

/// A later model's edge to a child that unified onto an already-parented one
/// is withheld; the first model, and a later model that does not dedupe
/// (federated), only record.
#[test]
fn withholds_only_a_later_unified_models_redundant_edge() {
    let first = file(FIRST);
    let later = file("#1=IFCSITE('t',$,$,$,$,$,$,$,$,$,$,$,$,$);\n#2=IFCBUILDING('c',$,$,$,$,$,$,$,$,$,$,$);\n#3=IFCRELAGGREGATES('q',$,$,$,#1,(#2));\n");
    for dedupe in [false, true] {
        let mut claims = StructureClaims::default();
        assert!(withheld(&mut claims, &first, &[], 0, false).is_empty());
        // Building #2 unified onto the first model's #2 (spatial remap).
        let expected = if dedupe { HashSet::from([(3, 2)]) } else { HashSet::new() };
        assert_eq!(withheld(&mut claims, &later, &[(2, 2)], 3, dedupe), expected, "dedupe={dedupe}");
    }
}

/// A member listed twice in one rel is not redundant with itself: the emit
/// loop writes that rel, so the planner must count its edge (#5802 review).
#[test]
fn a_member_listed_twice_in_one_rel_is_not_withheld() {
    let mut claims = StructureClaims::default();
    withheld(&mut claims, &file(FIRST), &[], 0, false);
    let dup = file("#1=IFCSITE('t',$,$,$,$,$,$,$,$,$,$,$,$,$);\n#2=IFCBUILDING('c',$,$,$,$,$,$,$,$,$,$,$);\n#3=IFCRELAGGREGATES('q',$,$,$,#1,(#2,#2));\n");
    assert!(withheld(&mut claims, &dup, &[], 3, true).is_empty());
}
