// SPDX-License-Identifier: MPL-2.0
//! Entry debits measure one traversal domain, while real children and effects
//! remain finite. Nested wrappers must select their own occurrence ancestry.
use super::*;

#[test]
fn nested_shared_domain_keeps_real_work_finite_and_terminal_without_envelope_multiplication() {
    let root=RetainedWalk::root(10);root.set_test_work_limit(3);
    let outer=root.scope().unwrap();
    let child=RetainedWalk::child(20).unwrap();
    assert_eq!(root.spent_for_test(),2,"one domain entry and one real child");
    {
        let _child=child.scope().unwrap();
        assert_eq!(current().unwrap().path.as_slice(),&[10,20]);
        {
            let _parent=root.scope().unwrap();
            assert_eq!(current().unwrap().path.as_slice(),&[10]);
            charge(1).unwrap();
        }
        assert_eq!(current().unwrap().path.as_slice(),&[10,20]);
        assert_eq!(root.spent_for_test(),3,"numerical/output work is still spent once");
        let stop=charge(1).unwrap_err();
        assert!(matches!(stop,crate::Error::ProgramStopped(ProgramStop::ResourceRefused(f))
            if f.dimension==Dimension::Work && f.requested==1 && f.remaining==0));
        let expected=root.check().unwrap_err();
        assert_eq!(child.scope().err(),Some(expected),"nested entry cannot hide a terminal root");
        assert_eq!(root.scope().err(),Some(expected));
        assert_eq!(root.spent_for_test(),3);
    }
    assert_eq!(current().unwrap().path.as_slice(),&[10]);drop(outer);
    assert!(current().is_none());assert_eq!(root.scope().err(),root.check().err());
}

#[test]
fn foreign_budget_entries_charge_each_domain_and_restore_ancestry_after_unwind() {
    let root=RetainedWalk::root(10);let foreign=RetainedWalk::root(90);
    let outer=root.scope().unwrap();
    let panic=std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _foreign=foreign.scope().unwrap();
        assert_eq!(current().unwrap().path.as_slice(),&[90]);
        {
            let _back=root.scope().unwrap();
            assert_eq!(current().unwrap().path.as_slice(),&[10]);
            assert_eq!(root.spent_for_test(),2,"reentering across a different domain charges entry");
        }
        assert_eq!(current().unwrap().path.as_slice(),&[90]);
        std::panic::panic_any("original scope unwind");
    })).unwrap_err();
    assert_eq!(panic.downcast_ref::<&str>(),Some(&"original scope unwind"));
    assert_eq!(foreign.spent_for_test(),1);assert_eq!(foreign.check(),Ok(()));
    assert_eq!(current().unwrap().path.as_slice(),&[10]);
    drop(outer);assert!(current().is_none());
    drop(root.scope().unwrap());assert_eq!(root.spent_for_test(),3,"a later external poll spends a new entry");
    assert!(current().is_none());
}

#[test]
fn same_domain_wrapper_does_not_remove_path_cycle_detection() {
    let root=RetainedWalk::root(10);let outer=root.scope().unwrap();
    let child=RetainedWalk::child(20).unwrap();let nested=child.scope().unwrap();
    let stop=RetainedWalk::child(10).err().expect("real ancestor reference must refuse");
    assert!(matches!(stop,crate::Error::ProgramStopped(ProgramStop::ResourceRefused(f))
        if f.dimension==Dimension::Representation));
    assert!(root.check().is_err());assert!(child.scope().is_err());
    assert_eq!(current().unwrap().path.as_slice(),&[10,20]);
    drop(nested);assert_eq!(current().unwrap().path.as_slice(),&[10]);
    drop(outer);assert!(current().is_none());
}
