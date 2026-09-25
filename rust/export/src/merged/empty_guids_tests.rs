// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use std::collections::{HashMap, HashSet};

use super::super::super::plan::ModelIndex;
use super::{GuidModel, PlannerGuids};

fn file(entities: &str) -> String {
    format!("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n{entities}ENDSEC;\nEND-ISO-10303-21;\n")
}

const WALL: &str = "#7=IFCWALL('0aBcDeFgHiJkLmNoPqRsT1',$,'W',$,$,$,$,$,$);\n";

/// Plan `text` as model `first`/later, compatible, at `base`, returning the unifications.
fn plan(guids: &mut PlannerGuids, text: &str, first: bool, base: u32, converting: bool, hidden: &[u32]) -> HashMap<u32, u32> {
    let index = ModelIndex::build(text.as_bytes());
    let included: HashSet<u32> = index.order.iter().copied().filter(|id| !hidden.contains(id)).collect();
    let remap = HashMap::new();
    guids.plan(&GuidModel { index: &index, included: &included, remap: &remap, first, compatible: true, base, scale: 1.0, converting })
}

/// #5937: a later model's entity repeating a GlobalId an earlier model wrote
/// resolves onto that entity's final id.
#[test]
fn resolves_a_later_entity_onto_the_written_one() {
    let mut guids = PlannerGuids::new(1.0);
    assert!(plan(&mut guids, &file(WALL), true, 0, false, &[]).is_empty());
    assert_eq!(plan(&mut guids, &file(WALL), false, 10, false, &[]), HashMap::from([(7, 7)]));
}

/// Never where the emit loop's verdict is out of sight: a hidden writer, a
/// converted model (a placeholder may replace the GlobalId), or a GlobalId a
/// model repeats. Each keeps the later entity apart.
#[test]
fn resolves_nothing_it_cannot_see() {
    let twice = file(&format!("{WALL}#8=IFCWALL('0aBcDeFgHiJkLmNoPqRsT1',$,'W',$,$,$,$,$,$);\n"));
    for (writer, converting, hidden) in [(file(WALL), false, vec![7]), (file(WALL), true, vec![]), (twice, false, vec![])] {
        let mut guids = PlannerGuids::new(1.0);
        plan(&mut guids, &writer, true, 0, converting, &hidden);
        assert!(plan(&mut guids, &file(WALL), false, 10, false, &[]).is_empty(), "converting={converting} hidden={hidden:?}");
    }
}

/// A container unifies only onto a container: an element reusing a
/// container's GlobalId stays apart (the container may be dropped).
#[test]
fn keeps_a_non_container_off_a_container_s_globalid() {
    let mut guids = PlannerGuids::new(1.0);
    plan(&mut guids, &file("#3=IFCBUILDING('0aBcDeFgHiJkLmNoPqRsT1',$,$,$,$,$,$,$,$,$,$,$);\n"), true, 0, false, &[]);
    assert!(plan(&mut guids, &file(WALL), false, 10, false, &[]).is_empty());
}
