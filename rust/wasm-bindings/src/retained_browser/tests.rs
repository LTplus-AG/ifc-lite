// SPDX-License-Identifier: MPL-2.0
//! Target-neutral ownership bookkeeping. The actual Worker paths are covered
//! by `bridge_tests.rs` under wasm-bindgen-test in a real browser.
use super::*;

fn owner() -> Arc<Owner> {
    Arc::new(Owner {
        identity: next_identity().unwrap(),
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
    assert_eq!(old.validate(), Err(BrowserError::WrongWorker));
    assert!(replacement.validate().is_ok());
}

#[test]
fn completed_transfer_keeps_owner_until_explicit_retirement() {
    let owner = owner();
    {
        let mut flight = InFlight::new(&owner);
        flight.disarm();
    }
    assert!(owner.validate().is_ok());
    owner.retire();
    owner.retire();
    assert_eq!(owner.validate(), Err(BrowserError::WrongWorker));
}

#[test]
fn cancellation_observes_only_its_captured_owner() {
    let worker = BrowserWorker {
        owner: owner(),
        regions_qualified: false,
        disks_qualified: false,
    };
    let cancellation = worker.cancellation();
    let other = BrowserWorker {
        owner: owner(),
        regions_qualified: false,
        disks_qualified: false,
    };
    assert!(cancellation.same_worker(&worker) && !cancellation.same_worker(&other));
    assert_eq!(cancellation.incarnation(), Some(worker.incarnation()));
    other.cancellation().retire();
    assert_ne!(worker.incarnation(), 0);
    cancellation.retire();
    assert_eq!((worker.incarnation(), cancellation.incarnation()), (0, None));
    assert_ne!(other.owner.identity, worker.owner.identity);
}

#[test]
fn invalid_limits_are_refused_before_any_submission() {
    for (chord, angle, bytes) in [
        (0., 5., 1),
        (-0.001, 5., 1),
        (f64::NAN, 5., 1),
        (f64::INFINITY, 5., 1),
        (0.001, 0., 1),
        (0.001, -5., 1),
        (0.001, f64::NAN, 1),
        (0.001, 181., 1),
        (0.001, 5., 0),
    ] {
        assert_eq!(evaluation_limits(chord, angle, bytes), Err(BrowserError::InvalidLimits));
    }
    assert_eq!(evaluation_limits(0.001, 180., 1), Ok(()));
}

#[test]
fn capability_bits_never_qualify_curved_families_alone() {
    use ifc_lite_geometry::document::RegionQualification as Family;
    let unqualified = BrowserCapabilities::select(7, SWEEP_REGION_BIT | SWEEP_DISK_BIT, false, false);
    assert!(unqualified.admits(Family::Rectangle));
    assert!(!unqualified.admits(Family::OrderedRegion) && !unqualified.admits(Family::RationalDisk));
    let qualified = BrowserCapabilities::select(7, SWEEP_REGION_BIT | SWEEP_DISK_BIT, true, true);
    assert!(qualified.admits(Family::OrderedRegion) && qualified.admits(Family::RationalDisk));
    // Witnesses cannot open a format the actual adapter does not implement.
    let missing = BrowserCapabilities::select(7, 0, true, true);
    assert!(!missing.admits(Family::Rectangle) && !missing.admits(Family::OrderedRegion));
    assert!(!missing.admits(Family::RationalDisk));
    assert!(!BrowserCapabilities::select(7, SWEEP_REGION_BIT, true, true).admits(Family::RationalDisk));
}
