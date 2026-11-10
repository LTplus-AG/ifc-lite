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

/// A short root (Unix socket paths are limited to ~108 bytes, and some test
/// hosts set a long TMPDIR).
fn temp_root(tag: &str) -> PathBuf {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let base = if cfg!(unix) && std::env::temp_dir().as_os_str().len() > 24 { PathBuf::from("/tmp") } else { std::env::temp_dir() };
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let root = base.join(format!("rc-{}-{n}-{}", std::process::id(), &tag[..tag.len().min(6)]));
    let _ = fs::remove_dir_all(&root);
    root
}

/// The free-space floor is a deployment policy, not part of what these tests
/// check, so they do not depend on the host's free disk.
fn open_store(root: &Path, max_bytes: u64, max_entry_bytes: u64) -> Store {
    Store::open(root, true, max_bytes, max_entry_bytes).expect("store opens").with_min_free(0)
}

fn store(root: &Path) -> Store {
    open_store(root, 1 << 30, 1 << 20)
}

#[track_caller]
fn published(outcome: PublishOutcome) {
    assert!(matches!(outcome, PublishOutcome::Published { .. }), "not published: {outcome:?}");
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
        // A group-writable entry is not trusted, and (PR #9614 review finding
        // 6) neither is a group/world-readable one: files must be 0600.
        let entry = root.join(NAMESPACE).join(format!("{KEY_A}.ifcr"));
        for mode in [0o620, 0o644, 0o604] {
            fs::set_permissions(&entry, fs::Permissions::from_mode(mode)).unwrap();
            assert!(matches!(s.read(KEY_A), Err(ReadError::Io(_))), "mode {mode:o} accepted");
        }
        fs::set_permissions(&entry, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(read_bytes(&s, KEY_A).is_some());
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
    published(s.publish(KEY_A, b"real"));
    assert_eq!(fs::read(&target).unwrap(), b"planted");
    assert_eq!(read_bytes(&s, KEY_A).as_deref(), Some(&b"real"[..]));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn oversized_entries_are_neither_read_nor_written() {
    let root = temp_root("oversized");
    let s = open_store(&root, 1 << 30, 8);
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
    published(s.publish(KEY_B, b"b"));
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
    published(s.publish(KEY_A, &a));
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
                published(w.publish(KEY_A, next));
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
    published(s.publish(KEY_A, b"old-corrupt"));
    let seen = s.read(KEY_A).ok().flatten().unwrap();
    published(s.publish(KEY_A, b"new-good-entry"));
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
    let s = open_store(&root, 2500, 1 << 20);
    published(s.publish(KEY_A, &[1; 1000]));
    published(s.publish(KEY_B, &[2; 1000]));
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
    published(s.publish(KEY_C, &[3; 1000]));
    assert!(read_bytes(&s, KEY_B).is_none(), "LRU entry evicted");
    assert!(read_bytes(&s, KEY_A).is_some() && read_bytes(&s, KEY_C).is_some());
    let _ = fs::remove_dir_all(&root);
}

/// PR #9614 review finding 3, the reviewer's schedule: a writer opens its key
/// lock, eviction removes that key's entry, then the writer locks its handle.
/// A second participant opening the lock path afterwards must contend for the
/// SAME lock. At b2ad1daf eviction unlinked the lock file and both acquired.
#[test]
fn eviction_never_replaces_a_lock_a_writer_may_hold() {
    let root = temp_root("lock-identity");
    let s = open_store(&root, 600, 500);
    published(s.publish(KEY_A, &[1; 400]));
    let paused_writer = super::fs_private::open_lock(&s.lock_path(KEY_A)).unwrap();
    published(s.publish(KEY_B, &[2; 400]));
    assert!(read_bytes(&s, KEY_A).is_none(), "A was evicted to fit B");
    assert!(s.lock_path(KEY_A).exists(), "lock files are never removed");
    paused_writer.try_lock().expect("the paused writer locks its handle");
    let second = super::fs_private::open_lock(&s.lock_path(KEY_A)).unwrap();
    assert!(second.try_lock().is_err(), "two participants held the same key's lock");
    // While the paused writer holds it, nobody else publishes that key.
    assert_eq!(s.publish(KEY_A, &[3; 100]), PublishOutcome::SkippedConcurrentWriter);
    let _ = fs::remove_dir_all(&root);
}

/// `mkfifo(3)` in-process. Spawning the `mkfifo` tool forked this binary, and a
/// forked child briefly holds every lock another test thread had open (they
/// belong to the open file description), which made sibling lock tests fail
/// intermittently on the fleet.
#[cfg(unix)]
fn make_fifo(path: &Path) {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
    // SAFETY: `c` is a valid NUL-terminated path that outlives the call.
    assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0, "mkfifo {}", path.display());
}

/// Run `f` on a thread and fail (not hang) if it does not return in time.
#[cfg(unix)]
fn within_deadline<T: Send + 'static>(what: &str, f: impl FnOnce() -> T + Send + 'static) -> T {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.recv_timeout(Duration::from_secs(10)).unwrap_or_else(|_| panic!("{what} blocked for 10 s"))
}

/// PR #9614 review finding 4: a FIFO, directory or socket at an entry or lock
/// path is refused without blocking. At b2ad1daf opening a FIFO entry waited
/// forever for a writer before its file type was checked.
#[cfg(unix)]
#[test]
fn non_regular_files_at_entry_and_lock_paths_never_block() {
    let root = temp_root("fifo");
    let s = store(&root);
    let entry = s.dir().join(format!("{KEY_A}.ifcr"));
    make_fifo(&entry);
    let reader_root = root.clone();
    let read = within_deadline("reading a FIFO entry", move || matches!(store(&reader_root).read(KEY_A), Err(ReadError::Io(_))));
    assert!(read, "a FIFO entry is refused");
    fs::remove_file(&entry).unwrap();

    fs::create_dir(&entry).unwrap();
    assert!(matches!(s.read(KEY_A), Err(ReadError::Io(_))), "a directory entry is refused");
    fs::remove_dir(&entry).unwrap();

    match std::os::unix::net::UnixListener::bind(&entry) {
        Ok(_socket) => {
            assert!(matches!(s.read(KEY_A), Err(ReadError::Io(_))), "a socket entry is refused");
            fs::remove_file(&entry).unwrap();
        }
        Err(e) => eprintln!("skipping the socket case: cannot bind {} ({e})", entry.display()),
    }

    std::os::unix::fs::symlink("/dev/zero", &entry).unwrap();
    assert!(matches!(s.read(KEY_A), Err(ReadError::Io(_))), "a device symlink is refused");
    fs::remove_file(&entry).unwrap();

    // A FIFO at the key's lock stripe: publication fails fast instead of hanging.
    let lock = s.lock_path(KEY_B);
    make_fifo(&lock);
    let writer_root = root.clone();
    let outcome = within_deadline("locking a FIFO lock", move || store(&writer_root).publish(KEY_B, b"b"));
    assert!(matches!(outcome, PublishOutcome::Failed(_)), "{outcome:?}");
    let _ = fs::remove_dir_all(&root);
}

/// A child process forked by any thread holds a copy of every lock this
/// process had open until its exec closes it. On the fleet the FIFO test's
/// `mkfifo` children made `corrupt_entry_removal_spares_a_newer_generation`
/// fail 5 of 40 runs (`SkippedConcurrentWriter`, a skipped removal); 0 of 40
/// without them. A lock held for a moment, as that copy is, must not skip a
/// publication; one held for the whole write still does (previous test).
#[test]
fn a_lock_held_for_a_moment_does_not_skip_publication() {
    let root = temp_root("brief");
    let s = store(&root);
    let copy = super::fs_private::open_lock(&s.lock_path(KEY_A)).unwrap();
    copy.try_lock().unwrap();
    let release = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(3));
        drop(copy);
    });
    published(s.publish(KEY_A, b"entry"));
    release.join().unwrap();
    let _ = fs::remove_dir_all(&root);
}
