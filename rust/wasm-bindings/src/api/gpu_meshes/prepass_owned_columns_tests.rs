// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

fn scan(content: &[u8]) -> (Vec<u32>, Vec<u32>, Vec<u32>, Vec<u8>) {
    let (records, classes, _, _) =
        ifc_lite_processing::scan_shard_classified_with_refusals(content, 0, content.len());
    let ids = records.iter().map(|&(id, _, _)| id).collect();
    let starts = records.iter().map(|&(_, start, _)| start as u32).collect();
    let lengths = records.iter().map(|&(_, start, end)| (end - start) as u32).collect();
    (ids, starts, lengths, classes)
}

#[test]
fn issue_6537_sorted_owned_columns_retain_all_three_original_allocations() {
    let content = b"DATA;\n#1=IFCCARTESIANPOINT((0.,0.,0.));\n#2=IFCDIRECTION((0.,0.,1.));\nENDSEC;";
    let (ids, starts, lengths, classes) = scan(content);
    assert_eq!(ids, [1, 2]);
    let pointers = (ids.as_ptr(), starts.as_ptr(), lengths.as_ptr());
    let (index, discovery) = ShardedColumns::owned(ids, starts, lengths, &classes).unwrap()
        .discover_and_build(content, &Default::default()).unwrap();
    assert_eq!((index.ids().as_ptr(), index.starts().as_ptr(), index.lengths().as_ptr()), pointers,
        "the production seam must adopt ABI columns rather than clone them");
    assert!(discovery.buffered_jobs.is_empty());
    assert!(index.lookup(1).is_some());
}

#[test]
fn issue_6537_discovery_keeps_file_order_classes_and_occurrences_before_dedup() {
    // Distinct classes for the repeated id, descending project/site ids, and
    // mixed geometry/style rows make sorting the discovery input observable.
    let content = b"DATA;\n#90=IFCPROJECT($,$,$,$,$,$,$,(),$);\n#70=IFCSITE($,$,$,$,$,$,$,$,$,$,$,$,$,$);\n#50=IFCWALL($,$,$,$,$,$,$,$,$);\n#10=IFCPROJECT($,$,$,$,$,$,$,(),$);\n#5=IFCSITE($,$,$,$,$,$,$,$,$,$,$,$,$,$);\n#3=IFCSTYLEDITEM($,(),$);\n#50=IFCSPACE($,$,$,$,$,$,$,$,$,$,$);\nENDSEC;";
    let (ids, starts, lengths, classes) = scan(content);
    assert_eq!(ids, [90, 70, 50, 10, 5, 3, 50]);
    let last = (starts[6] as usize, (starts[6] + lengths[6]) as usize);
    let (borrowed_index, borrowed) = ShardedColumns::borrowed(&ids, &starts, &lengths, &classes).unwrap()
        .discover_and_build(content, &Default::default()).unwrap();
    let (owned_index, owned) = ShardedColumns::owned(ids, starts, lengths, &classes).unwrap()
        .discover_and_build(content, &Default::default()).unwrap();
    assert_eq!(owned.project_id, Some(90));
    assert_eq!(owned.site_position.map(|site| site.0), Some(70));
    assert_eq!(owned.buffered_jobs.iter().map(|job| job.0).collect::<Vec<_>>(), [70, 50, 5, 50]);
    assert_eq!(owned.buffered_jobs[1].3, ifc_lite_core::IfcType::IfcWall);
    assert_eq!(owned.buffered_jobs[3].3, ifc_lite_core::IfcType::IfcSpace);
    assert_eq!(owned.prepass_spans.styled_items.iter().map(|row| row.0).collect::<Vec<_>>(), [3]);
    assert_eq!(owned.buffered_jobs, borrowed.buffered_jobs);
    assert_eq!(owned_index.lookup(50), Some(last), "lookup keeps the LAST duplicate span");
    assert_eq!(owned_index.ids(), borrowed_index.ids());
    assert_eq!(owned_index.starts(), borrowed_index.starts());
    assert_eq!(owned_index.lengths(), borrowed_index.lengths());
}

#[test]
fn issue_6537_owned_discovery_honors_disabled_types_and_type_candidates() {
    let content = b"DATA;\n#8=ifcwall($,$,$,$,$,$,$,$,$);\n#2=IFCWALLTYPE($,$,$,$,$,(),(),$,$,$);\n#4=IFCSPACE($,$,$,$,$,$,$,$,$,$,$);\nENDSEC;";
    let (ids, starts, lengths, classes) = scan(content);
    let disabled = ["IFCWALL".to_owned()].into_iter().collect();
    let (_, discovery) = ShardedColumns::owned(ids, starts, lengths, &classes).unwrap()
        .discover_and_build(content, &disabled).unwrap();
    assert_eq!(discovery.buffered_jobs.iter().map(|row| row.0).collect::<Vec<_>>(), [4]);
    assert_eq!(discovery.type_candidate_spans.iter().map(|row| row.0).collect::<Vec<_>>(), [2]);
}

#[test]
fn issue_6537_owned_and_borrowed_refuse_each_column_length_before_discovery() {
    for ids in [0, 2] {
        for starts in [0, 1, 2, 3] {
            for lengths in [0, 1, 2, 3] {
                for classes in [0, 1, 2, 3] {
                    let input = (vec![1; ids], vec![0; starts], vec![0; lengths], vec![0; classes]);
                    let owned = ShardedColumns::owned(input.0.clone(), input.1.clone(), input.2.clone(), &input.3);
                    let borrowed = ShardedColumns::borrowed(&input.0, &input.1, &input.2, &input.3);
                    assert_eq!(owned.is_ok(), borrowed.is_ok());
                    match (owned, borrowed) {
                        (Err(actual), Err(expected)) => {
                            assert_eq!(actual, expected);
                            if classes != ids {
                                assert_eq!(actual, format!("buildPrePassStreamingSharded: entity index columns disagree in length: ids {ids}, classes {classes}"));
                            } else {
                                assert_eq!(actual, refuse(ifc_lite_core::ColumnLengthMismatch { ids, starts, lengths }));
                            }
                        }
                        (Ok(_), Ok(_)) => assert!(ids == starts && ids == lengths && ids == classes),
                        _ => panic!("owned and borrowed refusal diverged"),
                    }
                }
            }
        }
    }
}

#[test]
fn issue_6537_empty_owned_columns_build_an_empty_index_and_discovery() {
    let (index, discovery) = ShardedColumns::owned(Vec::new(), Vec::new(), Vec::new(), &[]).unwrap()
        .discover_and_build(b"", &Default::default()).unwrap();
    assert!(index.is_empty());
    assert_eq!(discovery.total_jobs, 0);
    assert_eq!(discovery.project_id, None);
    assert!(discovery.buffered_jobs.is_empty());
}
