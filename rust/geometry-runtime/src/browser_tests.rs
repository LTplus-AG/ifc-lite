// SPDX-License-Identifier: MPL-2.0
use super::*;
fn owner() -> Arc<Owner> {
    Arc::new(Owner {
        identity: next_identity(),
        live: AtomicBool::new(true),
    })
}

#[test]
fn abandoned_browser_future_retires_only_its_captured_owner() {
    let old = owner();
    let replacement = owner();
    assert_ne!(old.identity, replacement.identity);
    {
        let _flight = InFlight::new(&old);
    }
    assert_eq!(old.validate(), Err(RetainedRefusal::InvalidRuntime));
    assert!(replacement.validate().is_ok());
}
#[test]
fn completed_browser_transfer_keeps_owner_until_receipt_retirement() {
    let owner = owner();
    {
        let mut flight = InFlight::new(&owner);
        flight.disarm();
    }
    assert!(owner.validate().is_ok());
    owner.retire();
    owner.retire();
    assert_eq!(owner.validate(), Err(RetainedRefusal::InvalidRuntime));
}
