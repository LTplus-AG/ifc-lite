// SPDX-License-Identifier: MPL-2.0
use super::*;
use std::sync::atomic::AtomicBool;

#[test]
fn displaced_source_payload_destructs_outside_active_source_lock() {
    struct Payload {
        state: std::sync::Weak<State>,
        unlocked: Arc<AtomicBool>,
    }
    impl Drop for Payload {
        fn drop(&mut self) {
            let state = self.state.upgrade().unwrap();
            self.unlocked
                .store(state.active_source.try_lock().is_ok(), Ordering::Release);
        }
    }
    let owner = ExecutionOwner::default();
    let mut lease = owner.try_lease().unwrap();
    let state = lease.state.clone();
    let work = lease.begin_synchronous_work(owner.identity()).unwrap();
    let unlocked = Arc::new(AtomicBool::new(false));
    let context = SourceResourceContext::new(Arc::new(Payload {
        state: Arc::downgrade(&state),
        unlocked: unlocked.clone(),
    }));
    let scope = work.source_borrow_scope_with_resources(Some(context));
    drop(scope);
    assert!(
        unlocked.load(Ordering::Acquire),
        "final context destruction must not run under source lock"
    );
}

fn stack_ids(state: &State) -> Vec<u64> {
    state
        .active_source
        .lock()
        .unwrap()
        .iter()
        .map(|(id, _)| *id)
        .collect()
}

#[test]
fn lifo_scopes_restore_enclosing_authority() {
    let owner = ExecutionOwner::default();
    let mut lease = owner.try_lease().unwrap();
    let state = lease.state.clone();
    let work = lease.begin_synchronous_work(owner.identity()).unwrap();
    let a = work.source_borrow_scope();
    let b = work.source_borrow_scope();
    let ids = stack_ids(&state);
    assert_eq!(ids.len(), 2);
    drop(b);
    assert_eq!(stack_ids(&state), &ids[..1]);
    drop(a);
    assert!(stack_ids(&state).is_empty());
}

#[test]
fn non_lifo_scope_drop_keeps_later_scope_and_leaves_no_stale_authority() {
    let owner = ExecutionOwner::default();
    let mut lease = owner.try_lease().unwrap();
    let state = lease.state.clone();
    let work = lease.begin_synchronous_work(owner.identity()).unwrap();
    let a = work.source_borrow_scope();
    let b = work.source_borrow_scope();
    let ids = stack_ids(&state);
    drop(a);
    assert_eq!(stack_ids(&state), &ids[1..], "B stays active after A drops");
    drop(b);
    assert!(stack_ids(&state).is_empty(), "no stale A authority remains");
}

#[test]
fn stop_propagation_follows_active_chain_across_non_lifo_drops() {
    use crate::resource_stop::ProgramStop;
    let mut decoder = crate::EntityDecoder::new("#1=IFCWALL();\n");
    let mut root = decoder.try_execution_lease().unwrap();
    let work = root
        .begin_synchronous_work(decoder.execution_identity())
        .unwrap();
    let a = work.source_borrow_scope();
    let a_handle = a.resource_stop_handle();
    let mut child = decoder.try_source_execution_lease().unwrap().unwrap();
    let child_work = child
        .begin_synchronous_work(decoder.execution_identity())
        .unwrap();
    let b = child_work.source_borrow_scope();
    let handle = b.resource_stop_handle();
    drop(a); // out of order: B must remain the active source
    assert!(decoder.try_source_execution_lease().unwrap().is_some());
    assert_eq!(handle.stop(ProgramStop::Cancelled), ProgramStop::Cancelled);
    assert_eq!(a_handle.check(), Err(ProgramStop::Cancelled));
    drop(b);
    assert!(decoder.try_source_execution_lease().unwrap().is_none());
}
