// SPDX-License-Identifier: MPL-2.0
//! #7955 effects must follow the entire acceptance callback, including owner commit.
use super::*;
#[test]
fn removal_effect_waits_for_acceptance_and_unwind() {
    let router = GeometryRouter::new();
    let result = router.commit_removed_host(30, || Err::<(),_>("owner commit rejected"));
    assert!(result.is_err());
    assert!(!router.host_consumed_by_void(30),"J2_TERMINAL_ATOMIC");
    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = router.commit_removed_host(30, || -> Result<(), &str> { panic!("final hook") });
    }));
    assert!(panic.is_err());
    assert!(!router.host_consumed_by_void(30),"J2_TERMINAL_ATOMIC");
    router.commit_removed_host(30, || Ok::<_, &str>(())).unwrap();
    assert!(router.host_consumed_by_void(30));
    assert!(router.commit_removed_host(30, || Ok::<_, &str>(())).is_err());
}
