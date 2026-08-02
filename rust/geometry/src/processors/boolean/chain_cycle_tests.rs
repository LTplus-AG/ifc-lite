// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

/// A self-referential clipping result: `#10`'s FirstOperand is `#10` again,
/// with `#20` an `IfcPolygonalBoundedHalfSpace` cutter. Before the visited-id
/// guard, `collect_polygonal_chain` walked `current = first` forever.
const CYCLIC_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#10=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#10,#20);
#20=IFCPOLYGONALBOUNDEDHALFSPACE($,$,$,$);
ENDSEC;
END-ISO-10303-21;
"#;

/// Wrap a DATA-section body in a minimal STEP file.
fn wrap_ifc(data: &str) -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n\
FILE_NAME('t.ifc','2024-01-01T00:00:00',(''),(''),'','','');\n\
FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n{data}ENDSEC;\nEND-ISO-10303-21;\n"
    )
}

/// Run `collect_polygonal_chain` starting at `root_id` in a worker thread with
/// a timeout, so a regressed infinite walk fails the test instead of hanging
/// the suite. Returns `(base_id, cutter_ids)`.
fn collect_with_timeout(content: String, root_id: u32) -> (u32, Vec<u32>) {
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = std::thread::spawn(move || {
        let mut decoder = EntityDecoder::new(&content);
        let entity = decoder.decode_by_id(root_id).expect("decode root");
        let processor = BooleanClippingProcessor::new();
        let result = processor.collect_polygonal_chain(entity, &mut decoder);
        let _ = tx.send(result.map(|(base, cutters)| {
            (base.id, cutters.iter().map(|c| c.id).collect::<Vec<_>>())
        }));
    });
    let outcome = rx.recv_timeout(std::time::Duration::from_secs(10));
    assert!(outcome.is_ok(), "collect_polygonal_chain hung (walk did not terminate)");
    let _ = handle.join();
    outcome.unwrap().expect("collect_polygonal_chain returned Err")
}

#[test]
fn collect_polygonal_chain_terminates_on_cyclic_first_operand() {
    // Run in a worker thread so a regression (infinite loop + unbounded
    // `chain.push`) is observed as a timeout instead of hanging the suite.
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = std::thread::spawn(move || {
        let content = CYCLIC_IFC.to_string();
        let mut decoder = EntityDecoder::new(&content);
        let entity = decoder.decode_by_id(10).expect("decode #10");
        let processor = BooleanClippingProcessor::new();
        let result = processor.collect_polygonal_chain(entity, &mut decoder);
        let _ = tx.send(result.map(|(base, cutters)| (base.id, cutters.len())));
    });

    let outcome = rx.recv_timeout(std::time::Duration::from_secs(5));
    assert!(
        outcome.is_ok(),
        "collect_polygonal_chain hung on a cyclic FirstOperand chain"
    );
    let _ = handle.join();

    let (base_id, cutter_count) = outcome
        .unwrap()
        .expect("collect_polygonal_chain returned Err");
    // The walk bottoms out on the repeated entity and collects the single
    // PBHS cutter it saw before detecting the cycle.
    assert_eq!(base_id, 10, "cycle should bottom out on the repeated entity");
    assert_eq!(
        cutter_count, 1,
        "exactly one PBHS cutter collected before the cycle breaks"
    );
}

/// A 2-cycle where the repeated id is the ROOT: `#10 → #30 → #10`. The walk
/// must break when it re-reaches `#10`, having collected one cutter per node.
#[test]
fn collect_polygonal_chain_terminates_on_two_cycle_via_root() {
    let content = wrap_ifc(
        "#10=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#30,#20);\n\
#30=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#10,#40);\n\
#20=IFCPOLYGONALBOUNDEDHALFSPACE($,$,$,$);\n\
#40=IFCPOLYGONALBOUNDEDHALFSPACE($,$,$,$);\n",
    );
    let (base_id, cutters) = collect_with_timeout(content, 10);
    assert_eq!(base_id, 10, "2-cycle should bottom out on the repeated ROOT");
    // Reversed (innermost-first): #30's cutter #40, then #10's cutter #20.
    assert_eq!(cutters, vec![40, 20]);
}

/// A cycle on an INTERIOR node: `#10 → #30 → #30`. The repeat is detected at
/// `#30`, not the root.
#[test]
fn collect_polygonal_chain_terminates_on_interior_self_loop() {
    let content = wrap_ifc(
        "#10=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#30,#20);\n\
#30=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#30,#40);\n\
#20=IFCPOLYGONALBOUNDEDHALFSPACE($,$,$,$);\n\
#40=IFCPOLYGONALBOUNDEDHALFSPACE($,$,$,$);\n",
    );
    let (base_id, cutters) = collect_with_timeout(content, 10);
    assert_eq!(base_id, 30, "interior self-loop should bottom out on #30");
    assert_eq!(cutters, vec![40, 20]);
}

/// A legitimate 1000-deep left-spine chain with NO cycle must still be walked
/// to the bottom — the visited-set guard must not cap finite depth (the walk
/// is iterative precisely so deep chains bypass MAX_BOOLEAN_DEPTH, #960).
#[test]
fn collect_polygonal_chain_walks_thousand_deep_chain() {
    const DEPTH: u32 = 1000;
    let mut data = String::new();
    for i in 1..=DEPTH {
        let first = if i == DEPTH { 20000 } else { i + 1 };
        data.push_str(&format!(
            "#{i}=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#{first},#{cutter});\n",
            cutter = 10000 + i
        ));
    }
    for i in 1..=DEPTH {
        data.push_str(&format!(
            "#{}=IFCPOLYGONALBOUNDEDHALFSPACE($,$,$,$);\n",
            10000 + i
        ));
    }
    data.push_str("#20000=IFCEXTRUDEDAREASOLID($,$,$,$);\n");

    let (base_id, cutters) = collect_with_timeout(wrap_ifc(&data), 1);
    assert_eq!(base_id, 20000, "deep chain must bottom out on the base solid");
    assert_eq!(cutters.len() as u32, DEPTH, "every cutter must be collected");
    // Innermost-first ordering: the deepest node's cutter comes first.
    assert_eq!(cutters[0], 10000 + DEPTH);
    assert_eq!(*cutters.last().unwrap(), 10001);
}

/// A dangling FirstOperand (`#999` does not exist) must stop the walk cleanly
/// at the node that references it — no panic, no hang.
#[test]
fn collect_polygonal_chain_stops_on_dangling_first_operand() {
    let content = wrap_ifc(
        "#10=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#999,#20);\n\
#20=IFCPOLYGONALBOUNDEDHALFSPACE($,$,$,$);\n",
    );
    let (base_id, cutters) = collect_with_timeout(content, 10);
    assert_eq!(
        base_id, 10,
        "walk should stop at the node whose FirstOperand dangles"
    );
    assert_eq!(cutters, vec![20]);
}

/// A `$` (null) FirstOperand must also stop the walk cleanly.
#[test]
fn collect_polygonal_chain_stops_on_null_first_operand() {
    let content = wrap_ifc(
        "#10=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,$,#20);\n\
#20=IFCPOLYGONALBOUNDEDHALFSPACE($,$,$,$);\n",
    );
    let (base_id, cutters) = collect_with_timeout(content, 10);
    assert_eq!(base_id, 10);
    assert_eq!(cutters, vec![20]);
}

/// The FULL `process()` path on a self-referential boolean must terminate
/// (via the cycle guard + MAX_BOOLEAN_DEPTH recursion cap), returning a
/// Result — Ok or Err both acceptable — instead of hanging the worker.
#[test]
fn full_process_terminates_on_cyclic_boolean() {
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = std::thread::spawn(move || {
        let content = CYCLIC_IFC.to_string();
        let mut decoder = EntityDecoder::new(&content);
        let entity = decoder.decode_by_id(10).expect("decode #10");
        let processor = BooleanClippingProcessor::new();
        let schema = IfcSchema::new();
        let result = processor.process(
            &entity,
            &mut decoder,
            &schema,
            TessellationQuality::Medium,
        );
        let _ = tx.send(result.is_ok());
    });
    let outcome = rx.recv_timeout(std::time::Duration::from_secs(10));
    assert!(outcome.is_ok(), "full process() hung on a cyclic boolean chain");
    let _ = handle.join();
}
