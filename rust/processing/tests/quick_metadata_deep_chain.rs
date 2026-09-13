// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #4689: an acyclic `IfcRelAggregates` chain nests the quick-metadata spatial
//! tree once per link. The builder recursed per level, and so do the derived
//! `Clone`, `Serialize` and `Drop` of `QuickMetadataSpatialNode`, so a chain of
//! 100 000 spaces overflowed the stack, which aborts the process. The tree now
//! stops descending at a fixed depth and reports each edge it cut.

mod common;

use common::quick_metadata::{bootstrap, tree};
use ifc_lite_processing::{
    QuickMetadataBootstrap, QuickMetadataPrunedEdge, QuickMetadataPrunedEdgeKind,
    QuickMetadataSpatialNode,
};
use std::fmt::Write as _;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

const CHAIN: u32 = 100_000;
const FIRST_SPACE: u32 = 10;

/// `IfcProject` #1 aggregates space #10, and each space aggregates the next.
fn deep_chain_ifc() -> String {
    let mut ifc = String::from(
        "ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-4689 deep aggregate chain'),'2;1');
FILE_NAME('chain.ifc','2026-09-13T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('4689ChainProject00001',$,'P',$,$,$,$,$,$);
",
    );
    let rel_base = FIRST_SPACE + CHAIN;
    for i in 0..CHAIN {
        let id = FIRST_SPACE + i;
        let parent = if i == 0 { 1 } else { id - 1 };
        writeln!(
            ifc,
            "#{id}=IFCSPACE('4689Chain{id:012}',$,'S{i}',$,$,$,$,$,.ELEMENT.,.INTERNAL.,$);"
        )
        .unwrap();
        writeln!(
            ifc,
            "#{rel}=IFCRELAGGREGATES('4689ChainRel{id:09}',$,$,$,#{parent},(#{id}));",
            rel = rel_base + i
        )
        .unwrap();
    }
    ifc.push_str("ENDSEC;\nEND-ISO-10303-21;\n");
    ifc
}

/// Levels in the tree, counted without recursion so the measurement cannot
/// overflow where the tree itself did not.
fn levels(root: &QuickMetadataSpatialNode) -> usize {
    let mut deepest = 0;
    let mut stack = vec![(root, 1usize)];
    while let Some((node, level)) = stack.pop() {
        deepest = deepest.max(level);
        stack.extend(node.children.iter().map(|child| (child, level + 1)));
    }
    deepest
}

#[test]
fn deep_aggregate_chain_builds_serialises_and_drops() {
    let (tx, rx) = mpsc::channel();
    // The wasm bundles link with an 8 MiB stack; give the walk the same budget.
    thread::Builder::new()
        .stack_size(8 << 20)
        .spawn(move || {
            // `bootstrap` clones the tree out of the callback, so Clone runs too.
            let bootstrap = bootstrap(&deep_chain_ifc());
            let json = serde_json::to_string(&bootstrap).expect("bootstrap serialises");
            // serde_json refuses input nested deeper than 128, and each tree
            // level nests twice, so a deeper cap would emit a bootstrap this
            // crate cannot read back.
            let read_back = serde_json::from_str::<QuickMetadataBootstrap>(&json)
                .map(|back| back.pruned_aggregate_edges == bootstrap.pruned_aggregate_edges)
                .map_err(|err| err.to_string());
            let summary = (
                levels(tree(&bootstrap)),
                bootstrap.pruned_aggregate_edges.clone(),
                read_back,
            );
            drop(bootstrap);
            tx.send(summary).unwrap();
        })
        .unwrap();
    // A stack overflow aborts the test binary; a hang fails here.
    let (levels, pruned, read_back) = rx
        .recv_timeout(Duration::from_secs(120))
        .expect("the deep chain finishes building, serialising and dropping");

    // The project plus 60 nested spaces: depth 0 to 60 inclusive.
    assert_eq!(levels, 61, "the tree nests to the cap and no further");
    // The one cut edge: the space at depth 60 to its child.
    let capped = FIRST_SPACE + 59;
    assert_eq!(
        pruned,
        [QuickMetadataPrunedEdge {
            parent_express_id: capped,
            child_express_id: capped + 1,
            kind: QuickMetadataPrunedEdgeKind::DepthLimit,
        }]
    );
    assert_eq!(
        read_back,
        Ok(true),
        "the capped bootstrap reads back through serde_json"
    );
}
