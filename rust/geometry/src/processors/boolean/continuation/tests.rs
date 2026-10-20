// SPDX-License-Identifier: MPL-2.0
//! Continuation control: path ownership across error and unwind, and that
//! operand nesting no longer consumes native stack.
use super::*;
use std::cell::RefCell;
use std::panic::{catch_unwind, AssertUnwindSafe};

thread_local! {
    static AFTER_BASE: RefCell<Option<Box<dyn Fn()>>> = const { RefCell::new(None) };
}

/// Test seam at the one point where a spine base has been meshed and the
/// operand path holds the admissions of every open scope.
pub(super) fn after_base(_value: &Value) {
    AFTER_BASE.with(|hook| {
        if let Some(hook) = hook.borrow().as_ref() {
            hook();
        }
    });
}

fn wrap_ifc(data: &str) -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n\
FILE_NAME('t.ifc','2024-01-01T00:00:00',(''),(''),'','','');\n\
FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n{data}ENDSEC;\nEND-ISO-10303-21;\n"
    )
}

/// How many more visits the path can be charged: the budget not yet spent.
fn remaining_visits(mut path: OperandPath) -> u32 {
    let mut left = 0;
    while path.charge() {
        left += 1;
    }
    left
}

/// A path that already holds one ancestor and one spent visit.
fn caller_path() -> OperandPath {
    let mut path = OperandPath::default();
    assert!(path.insert(9_999));
    assert!(path.charge());
    path
}

#[test]
fn a_panic_returns_the_path_with_ancestors_and_spent_visits() {
    let content = wrap_ifc("#1=IFCBOOLEANRESULT(.UNION.,#2,#3);\n#2=IFCBLOCK($,1.,1.,1.);\n#3=IFCBLOCK($,1.,1.,1.);\n");
    let mut decoder = EntityDecoder::new(&content);
    let entity = decoder.decode_by_id(1).expect("decode #1");
    let processor = BooleanClippingProcessor::new();
    let mut path = caller_path();

    AFTER_BASE.with(|hook| *hook.borrow_mut() = Some(Box::new(|| panic!("injected unwind"))));
    let unwound = catch_unwind(AssertUnwindSafe(|| {
        processor.execute_boolean(&entity, &mut decoder, 0, Default::default(), &mut path)
    }));
    AFTER_BASE.with(|hook| *hook.borrow_mut() = None);

    assert!(unwound.is_err(), "the injected panic must propagate");
    assert_eq!(path.len(), 1, "only the caller's ancestor stays on the path");
    assert!(!path.insert(9_999), "the ancestor is still present");
    assert_eq!(
        remaining_visits(path),
        MAX_OPERAND_VISITS - 2,
        "the caller's visit and the entered boolean's visit both stay spent"
    );
}

#[test]
fn an_error_releases_open_scopes_but_keeps_visits_spent() {
    let content = wrap_ifc("#1=IFCBOOLEANRESULT(.UNION.,#1,#2);\n#2=IFCBLOCK($,1.,1.,1.);\n");
    let mut decoder = EntityDecoder::new(&content);
    let entity = decoder.decode_by_id(1).expect("decode #1");
    let processor = BooleanClippingProcessor::new();
    let mut path = caller_path();

    let err = processor
        .execute_boolean(&entity, &mut decoder, 0, Default::default(), &mut path)
        .expect_err("a self-referential FirstOperand is a cycle");
    assert!(err.to_string().contains("cyclic boolean FirstOperand chain"), "{err}");
    assert_eq!(path.len(), 1, "the failed node's scope is released");
    assert_eq!(remaining_visits(path), MAX_OPERAND_VISITS - 2);
}

#[test]
fn a_completed_run_returns_only_the_callers_path() {
    let content = wrap_ifc("#1=IFCBOOLEANRESULT(.UNION.,#2,#3);\n#2=IFCBLOCK($,1.,1.,1.);\n#3=IFCCARTESIANPOINT((0.,0.,0.));\n");
    let mut decoder = EntityDecoder::new(&content);
    let entity = decoder.decode_by_id(1).expect("decode #1");
    let processor = BooleanClippingProcessor::new();
    let mut path = caller_path();

    let (mesh, _) = processor
        .execute_boolean(&entity, &mut decoder, 0, Default::default(), &mut path)
        .expect("the unsupported cutter is recorded, not fatal");
    assert!(!mesh.is_empty(), "the base block survives its unsupported union operand");
    assert_eq!(path.len(), 1);
    assert_eq!(remaining_visits(path), MAX_OPERAND_VISITS - 2);
}

/// Operand nesting is held on the heap: a chain close to the path bound runs
/// on a thread whose native stack could not hold that many processor frames.
#[test]
fn operand_nesting_near_the_path_bound_does_not_use_native_stack() {
    let hops: u32 = 30;
    let mut data = String::new();
    for i in 0..hops {
        let b = 1 + i * 2;
        let c = 2 + i * 2;
        let next = if i + 1 == hops { 90_000 } else { 1 + (i + 1) * 2 };
        // The CSG hop is the operand on the FIRST side, so each level's base
        // is the next level: the path grows by two nodes per hop.
        data.push_str(&format!("#{b}=IFCBOOLEANRESULT(.UNION.,#{c},#90001);\n"));
        data.push_str(&format!("#{c}=IFCCSGSOLID(#{next});\n"));
    }
    data.push_str("#90000=IFCBLOCK($,1.,1.,1.);\n#90001=IFCCARTESIANPOINT((0.,0.,0.));\n");
    let content = wrap_ifc(&data);
    let handle = std::thread::Builder::new()
        .stack_size(256 * 1024)
        .spawn(move || {
            let mut decoder = EntityDecoder::new(&content);
            let entity = decoder.decode_by_id(1).expect("decode #1");
            let processor = BooleanClippingProcessor::new();
            let mut path = OperandPath::default();
            processor
                .execute_boolean(&entity, &mut decoder, 0, Default::default(), &mut path)
                .map(|(mesh, _)| mesh.positions.len())
                .map_err(|error| error.to_string())
        })
        .expect("spawn small-stack worker");
    let vertices = handle.join().expect("no stack overflow").expect("the chain resolves");
    assert!(vertices > 0, "the innermost block reaches the result");
}
