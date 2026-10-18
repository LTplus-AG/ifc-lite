// SPDX-License-Identifier: MPL-2.0
//! Round-two preservation: unwind restores the real caller's spent path state.
use super::*;
use crate::kernel::mesh_volume::mesh_volume;
use std::cell::Cell;
use std::panic::{catch_unwind, AssertUnwindSafe};

thread_local! {
    static PANIC_AFTER_BASE: Cell<bool> = const { Cell::new(false) };
}

pub(super) fn after_base(value: &Value) {
    if PANIC_AFTER_BASE.with(|armed| armed.replace(false)) {
        // The injected unwind follows actual entered Boolean control and owned
        // block construction, rather than a mock executor or fabricated result.
        assert!((mesh_volume(&value.0).abs() - 8.).abs() < 1e-6);
        std::panic::panic_any("round-two reached-base unwind");
    }
}
struct PanicAfterBase;
impl PanicAfterBase {
    fn arm() -> Self {
        PANIC_AFTER_BASE.with(|armed| assert!(!armed.replace(true)));
        Self
    }
}
impl Drop for PanicAfterBase {
    fn drop(&mut self) { PANIC_AFTER_BASE.with(|armed| armed.set(false)); }
}

fn ancestor_path() -> OperandPath {
    let mut path = OperandPath::default();
    assert!(path.insert(900));
    for _ in 0..7 { assert!(path.charge()); }
    path
}
fn assert_spent(path: &mut OperandPath, spent: u32) {
    for _ in spent..MAX_OPERAND_VISITS { assert!(path.charge()); }
    assert!(!path.charge(), "spent visits cannot be refunded");
}

#[test]
fn round_two_unwind_after_real_base_restores_ancestors_active_path_and_spent_visits() {
    let mut decoder = EntityDecoder::new("#1=IFCBLOCK($,2.,2.,2.);#2=IFCBOOLEANRESULT(.UNION.,#1,#1);");
    let root = decoder.decode_by_id(2).unwrap();
    let recorder = BooleanClippingProcessor::new();
    let mut path = ancestor_path();
    let injection = PanicAfterBase::arm();
    let panic = catch_unwind(AssertUnwindSafe(|| recorder.execute_boolean(
        &root, &mut decoder, 0, TessellationQuality::Medium, &mut path))).unwrap_err();
    drop(injection);
    assert_eq!(panic.downcast_ref::<&str>(), Some(&"round-two reached-base unwind"));
    assert_eq!(path.len(), 2, "baseline retains the active node on panic");
    assert!(!path.insert(900), "enclosing ancestor survives unwind");
    assert!(!path.insert(2), "entered current node survives unwind");
    assert_spent(&mut path, 8);
    assert!(recorder.take_failures().is_empty());
}

#[test]
fn round_two_normal_result_exits_only_child_memberships_and_never_refunds_visits() {
    for fail in [false, true] {
        // Every RHS enters after constructing its real block base. The last
        // entered Boolean exceeds contextual depth, exercising late Err cleanup.
        let mut source = "#1=IFCBLOCK($,2.,2.,2.);".to_owned();
        let count = if fail { 12 } else { 2 };
        for index in 0..count {
            let id = 10 + index;
            let next = if index + 1 == count { 1 } else { id + 1 };
            source.push_str(&format!("#{id}=IFCBOOLEANRESULT(.UNION.,#1,#{next});"));
        }
        let mut decoder = EntityDecoder::new(&source);
        let root = decoder.decode_by_id(10).unwrap();
        let recorder = BooleanClippingProcessor::new();
        let mut path = ancestor_path();
        let result = recorder.execute_boolean(&root, &mut decoder, 0,
            TessellationQuality::Medium, &mut path);
        if fail {
            assert!(result.unwrap_err().to_string().contains("depth 11 exceeds limit 10"));
        } else {
            assert!((mesh_volume(&result.unwrap().0).abs() - 8.).abs() < 1e-6);
        }
        assert_eq!(path.len(), 1);
        assert!(!path.insert(900));
        assert_spent(&mut path, 7 + count);
        assert!(recorder.take_failures().is_empty());
    }
}
