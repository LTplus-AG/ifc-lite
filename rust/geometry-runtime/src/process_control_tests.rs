// SPDX-License-Identifier: MPL-2.0
use super::*;

#[cfg(unix)]
#[test]
fn spontaneous_exit_reaps_and_invalidates_all_shared_authorities() {
    let child = std::process::Command::new("sh")
        .args(["-c", "exit 0"])
        .spawn()
        .unwrap();
    let control = ProcessControl::new(child);
    let other = control.clone();
    let owner = crate::RuntimeOwner::new(other, 17);
    let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while control.is_live() {
        assert!(std::time::Instant::now() < until);
        std::thread::yield_now();
    }
    assert_eq!(owner.incarnation(), None);
    #[cfg(target_os = "linux")]
    assert!(!std::path::Path::new(&format!("/proc/{}", control.id())).exists());
    control.terminate().unwrap();
}
