// SPDX-License-Identifier: MPL-2.0
use super::*;
use std::sync::atomic::AtomicBool;

#[test]
fn displaced_source_payload_destructs_outside_active_source_lock() {
    struct Payload { state: std::sync::Weak<State>, unlocked: Arc<AtomicBool> }
    impl Drop for Payload {
        fn drop(&mut self) {
            let state = self.state.upgrade().unwrap();
            self.unlocked.store(state.active_source.try_lock().is_ok(), Ordering::Release);
        }
    }
    let owner = ExecutionOwner::default();
    let mut lease = owner.try_lease().unwrap();
    let state = lease.state.clone();
    let work = lease.begin_synchronous_work(owner.identity()).unwrap();
    let unlocked = Arc::new(AtomicBool::new(false));
    let context = SourceResourceContext::new(Arc::new(Payload {
        state: Arc::downgrade(&state), unlocked: unlocked.clone(),
    }));
    let scope = work.source_borrow_scope_with_resources(Some(context));
    drop(scope);
    assert!(unlocked.load(Ordering::Acquire), "final context destruction must not run under source lock");
}
