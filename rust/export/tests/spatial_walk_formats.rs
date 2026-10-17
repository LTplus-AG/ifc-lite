// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! C6-10 (D48, EXPORT-DATA-16): CSV, IFCX and USD list the spatial tree in one
//! order, source order with the first parent owning a shared child.

use ifc_lite_export::{export_csv, export_ifc5, export_usd, CsvMode, CsvOptions, Ifc5Options, UsdOptions};

/// Project #1 holds site #2, which holds buildings #3 and #4 (in that order).
/// Wall #5 is contained in both buildings; #6 only in #4. A stack walk that
/// pushes siblings in source order lists #4 before #3.
const FILE: &str = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#1=IFCPROJECT('0Project000000000000001',$,'Pj',$,$,$,$,$,$);\n\
#2=IFCSITE('0Site00000000000000002',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);\n\
#3=IFCBUILDING('0Bldg00000000000000003',$,'BuildingOne',$,$,$,$,$,.ELEMENT.,$,$,$);\n\
#4=IFCBUILDING('0Bldg00000000000000004',$,'BuildingTwo',$,$,$,$,$,.ELEMENT.,$,$,$);\n\
#5=IFCWALL('0Wall00000000000000005',$,'WallShared',$,$,$,$,$,$);\n\
#6=IFCWALL('0Wall00000000000000006',$,'WallSecond',$,$,$,$,$,$);\n\
#10=IFCRELAGGREGATES('0Agg100000000000000010',$,$,$,#1,(#2));\n\
#11=IFCRELAGGREGATES('0Agg200000000000000011',$,$,$,#2,(#3,#4));\n\
#12=IFCRELCONTAINEDINSPATIALSTRUCTURE('0Cont1000000000000012',$,$,$,(#5),#3);\n\
#13=IFCRELCONTAINEDINSPATIALSTRUCTURE('0Cont2000000000000013',$,$,$,(#5,#6),#4);\n\
ENDSEC;\nEND-ISO-10303-21;\n";

const EXPECTED: [u32; 6] = [1, 2, 3, 5, 4, 6];

#[test]
fn csv_lists_source_order_and_the_first_parent_owns_the_shared_wall() {
    let csv = export_csv(FILE.as_bytes(), CsvMode::SpatialHierarchy, &CsvOptions::default());
    let rows: Vec<Vec<&str>> = csv.lines().skip(1).map(|l| l.split(',').collect()).collect();
    let ids: Vec<u32> = rows.iter().map(|r| r[0].parse().unwrap()).collect();
    assert_eq!(ids, EXPECTED);
    let wall = rows.iter().find(|r| r[0] == "5").unwrap();
    assert_eq!((wall[4], wall[5]), ("3", "3"), "parent and level: {csv}");
}

#[test]
fn ifcx_lists_the_same_order() {
    let doc: serde_json::Value = serde_json::from_str(&export_ifc5(FILE.as_bytes(), &Ifc5Options::default())).unwrap();
    let paths: Vec<&str> = doc["data"].as_array().unwrap().iter().map(|n| n["path"].as_str().unwrap()).collect();
    // The project's path is generated; every other node is its GlobalId.
    assert_eq!(paths.len(), 6, "{paths:?}");
    let tail: Vec<&str> = paths[1..].iter().map(|p| &p[..8]).collect();
    assert_eq!(tail, ["0Site000", "0Bldg000", "0Wall000", "0Bldg000", "0Wall000"], "{paths:?}");
    assert_eq!(paths[2..].iter().map(|p| p.chars().last().unwrap()).collect::<String>(), "3546");
}

/// USD nests recursively and was already source-order, first-parent-wins; on a
/// real tree its prim order must be CSV's row order.
#[test]
fn usd_prims_follow_the_csv_walk() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../geometry/tests/fixtures/mapped_instances_synthetic.ifc");
    let content = std::fs::read(path).unwrap_or_else(|e| panic!("in-tree fixture {path}: {e}"));
    let csv = export_csv(&content, CsvMode::SpatialHierarchy, &CsvOptions::default());
    let csv_ids: Vec<u32> = csv.lines().skip(1).map(|l| l.split(',').next().unwrap().parse().unwrap()).collect();
    let usd = export_usd(&content, &UsdOptions::default()).expect("usd");
    let usd_ids: Vec<u32> = usd
        .lines()
        .filter(|l| l.contains("def Xform"))
        .filter_map(|l| l.rsplit_once('_')?.1.trim_end_matches('"').parse().ok())
        .collect();
    let in_both = |ids: &[u32], other: &[u32]| ids.iter().copied().filter(|i| other.contains(i)).collect::<Vec<_>>();
    let (csv_common, usd_common) = (in_both(&csv_ids, &usd_ids), in_both(&usd_ids, &csv_ids));
    assert!(csv_common.len() >= 3, "anti-vacuity: {csv_ids:?} / {usd_ids:?}");
    assert_eq!(csv_common, usd_common);
}
