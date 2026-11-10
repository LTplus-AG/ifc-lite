// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Store behaviour: private files, symlink refusal, crash leftovers, writer
//! races, readers during replacement, generation-checked removal, eviction.

use super::store::{ReadError, Store, NAMESPACE};
use super::PublishOutcome;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

const KEY_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const KEY_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const KEY_C: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

fn temp_root(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("ifc-lite-rc-{tag}-{}-{:?}", std::process::id(), SystemTime::now()));
    let _ = fs::remove_dir_all(&root);
    root
}

fn store(root: &Path) -> Store {
    Store::open(root, true, 1 << 30, 1 << 20).expect("store opens")
}

fn read_bytes(store: &Store, key: &str) -> Option<Vec<u8>> {
    match store.read(key) {
        Ok(entry) => entry.map(|e| e.bytes),
        Err(ReadError::Io(e)) => panic!("read failed: {e}"),
        Err(ReadError::Oversized(n)) => panic!("oversized {n}"),
    }
}

#[test]
fn publish_then_read_with_private_modes() {
    let root = temp_root("modes");
    let s = store(&root);
    assert_eq!(s.publish(KEY_A, b"entry-a"), PublishOutcome::Published { bytes: 7 });
    assert_eq!(read_bytes(&s, KEY_A).as_deref(), Some(&b"entry-a"[..]));
    assert_eq!(s.publish(KEY_A, b"entry-a"), PublishOutcome::AlreadyPresent);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: PathBuf| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(root.join(NAMESPACE)), 0o700);
        assert_eq!(mode(root.join(NAMESPACE).join(format!("{KEY_A}.ifcr"))), 0o600);
        // A group-writable entry is not trusted.
        let entry = root.join(NAMESPACE).join(format!("{KEY_A}.ifcr"));
        fs::set_permissions(&entry, fs::Permissions::from_mode(0o620)).unwrap();
        assert!(matches!(s.read(KEY_A), Err(ReadError::Io(_))));
        // A non-private namespace directory refuses to open.
        fs::set_permissions(root.join(NAMESPACE), fs::Permissions::from_mode(0o750)).unwrap();
        assert!(Store::open(&root, true, 1 << 30, 1 << 20).is_err());
    }
    let _ = fs::remove_dir_all(&root);
}

#[cfg(unix)]
#[test]
fn symlinked_entries_are_not_followed() {
    let root = temp_root("symlink");
    let s = store(&root);
    let target = root.join("elsewhere");
    fs::write(&target, b"planted").unwrap();
    std::os::unix::fs::symlink(&target, s.dir().join(format!("{KEY_A}.ifcr"))).unwrap();
    assert!(matches!(s.read(KEY_A), Err(ReadError::Io(_))), "a symlink must not be followed");
    // Publishing replaces the link itself, never writes through it.
    assert!(matches!(s.publish(KEY_A, b"real"), PublishOutcome::Published { .. }));
    assert_eq!(fs::read(&target).unwrap(), b"planted");
    assert_eq!(read_bytes(&s, KEY_A).as_deref(), Some(&b"real"[..]));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn oversized_entries_are_neither_read_nor_written() {
    let root = temp_root("oversized");
    let s = Store::open(&root, true, 1 << 30, 8).unwrap();
    assert!(matches!(s.publish(KEY_A, &[0u8; 9]), PublishOutcome::SkippedOversized { bytes: 9, .. }));
    fs::write(s.dir().join(format!("{KEY_A}.ifcr")), [0u8; 9]).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(s.dir().join(format!("{KEY_A}.ifcr")), fs::Permissions::from_mode(0o600)).unwrap();
    }
    assert!(matches!(s.read(KEY_A), Err(ReadError::Oversized(9))));
    let _ = fs::remove_dir_all(&root);
}

/// A writer that died before its rename leaves a temp file that no reader
/// opens and that eviction later removes once its key lock is free.
#[test]
fn crash_before_rename_leaves_no_hit_and_is_cleaned_up() {
    let root = temp_root("crash");
    let s = store(&root);
    let orphan = s.dir().join(format!("{KEY_A}.4242.0.tmp"));
    fs::write(&orphan, b"complete-looking but never renamed").unwrap();
    assert!(read_bytes(&s, KEY_A).is_none(), "a temp file is never a hit");
    let old = SystemTime::now() - Duration::from_secs(3600);
    fs::File::options().write(true).open(&orphan).unwrap().set_modified(old).unwrap();
    // The next publish (any key) sweeps it.
    assert!(matches!(s.publish(KEY_B, b"b"), PublishOutcome::Published { .. }));
    assert!(!orphan.exists(), "stale orphan temp removed");
    let _ = fs::remove_dir_all(&root);
}

/// Several writers race on one key: exactly the published bytes end up
/// stored, every writer reports a coherent outcome, and no temp is left.
#[test]
fn racing_writers_store_one_complete_entry() {
    let root = temp_root("race");
    let payload: Vec<u8> = (0..200_000u32).flat_map(|v| v.to_le_bytes()).collect();
    let outcomes: Vec<PublishOutcome> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..8).map(|_| scope.spawn(|| store(&root).publish(KEY_A, &payload))).collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    assert!(outcomes.iter().any(|o| matches!(o, PublishOutcome::Published { .. })));
    for outcome in &outcomes {
        assert!(matches!(
            outcome,
            PublishOutcome::Published { .. } | PublishOutcome::AlreadyPresent | PublishOutcome::SkippedConcurrentWriter
        ), "{outcome:?}");
    }
    let s = store(&root);
    assert_eq!(read_bytes(&s, KEY_A).as_deref(), Some(payload.as_slice()));
    let temps = fs::read_dir(s.dir()).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"));
    assert_eq!(temps.count(), 0);
    let _ = fs::remove_dir_all(&root);
}

/// Readers racing a writer that keeps replacing the entry see one whole
/// generation or the other, never a prefix or a mix.
#[test]
fn readers_during_replacement_see_whole_generations() {
    let root = temp_root("readers");
    let s = store(&root);
    let a: Vec<u8> = vec![0xaa; 300_000];
    let b: Vec<u8> = vec![0xbb; 500_000];
    assert!(matches!(s.publish(KEY_A, &a), PublishOutcome::Published { .. }));
    let stop = Arc::new(AtomicBool::new(false));
    std::thread::scope(|scope| {
        let writer_stop = stop.clone();
        let writer_root = root.clone();
        let (wa, wb) = (a.clone(), b.clone());
        scope.spawn(move || {
            let w = store(&writer_root);
            for i in 0..60 {
                // Different bytes each time, so `AlreadyPresent` never short-cuts.
                let next = if i % 2 == 0 { &wb } else { &wa };
                assert!(matches!(w.publish(KEY_A, next), PublishOutcome::Published { .. }));
            }
            writer_stop.store(true, Ordering::Release);
        });
        for _ in 0..3 {
            scope.spawn(|| {
                let r = store(&root);
                let mut seen = 0;
                while !stop.load(Ordering::Acquire) || seen == 0 {
                    let bytes = read_bytes(&r, KEY_A).expect("an entry is always present");
                    assert!(bytes == a || bytes == b, "read a torn entry of {} bytes", bytes.len());
                    seen += 1;
                }
            });
        }
    });
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn corrupt_entry_removal_spares_a_newer_generation() {
    let root = temp_root("generation");
    let s = store(&root);
    s.publish(KEY_A, b"old-corrupt");
    let seen = s.read(KEY_A).ok().flatten().unwrap();
    s.publish(KEY_A, b"new-good-entry");
    s.remove_if_same(KEY_A, &seen);
    assert_eq!(read_bytes(&s, KEY_A).as_deref(), Some(&b"new-good-entry"[..]));
    let current = s.read(KEY_A).ok().flatten().unwrap();
    s.remove_if_same(KEY_A, &current);
    assert!(read_bytes(&s, KEY_A).is_none());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn eviction_removes_least_recently_used_first() {
    let root = temp_root("evict");
    let s = Store::open(&root, true, 2500, 1 << 20).unwrap();
    s.publish(KEY_A, &[1; 1000]);
    s.publish(KEY_B, &[2; 1000]);
    let age = |key: &str, secs: u64| {
        let path = s.dir().join(format!("{key}.ifcr"));
        let file = fs::File::options().write(true).open(path).unwrap();
        file.set_modified(SystemTime::now() - Duration::from_secs(secs)).unwrap();
    };
    age(KEY_A, 100);
    age(KEY_B, 200);
    // A hit refreshes A, so B is now the least recently used.
    let hit = s.read(KEY_A).ok().flatten().unwrap();
    s.touch(&hit);
    s.publish(KEY_C, &[3; 1000]);
    assert!(read_bytes(&s, KEY_B).is_none(), "LRU entry evicted");
    assert!(read_bytes(&s, KEY_A).is_some() && read_bytes(&s, KEY_C).is_some());
    let _ = fs::remove_dir_all(&root);
}
