// SPDX-License-Identifier: MPL-2.0
//! fault injection exercises transport ownership, never mock geometry.
#![cfg(all(not(target_arch = "wasm32"), unix))]
use ifc_lite_geometry_runtime::{
    SupervisedWorker, SupervisionError, WorkerCommand, WorkerError, WorkerResult,
};
use std::os::unix::fs::symlink;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Peer {
    directory: PathBuf,
    executable: PathBuf,
}
impl Peer {
    fn new() -> Option<Self> {
        if !std::process::Command::new("python3")
            .arg("--version")
            .output()
            .is_ok_and(|result| result.status.success())
        {
            eprintln!("SKIP: protocol fault injection needs python3");
            return None;
        }
        let directory = std::env::temp_dir().join(format!(
            "ifclite-supervision-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&directory).unwrap();
        let executable = directory.join("peer.py");
        // Exec an immutable fixture through a per-test symlink. Writing a new
        // executable here can race another thread's fork, which may inherit its
        // writing FD and make exec fail with ETXTBSY even after our FD closes.
        let fixture =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/partial-frame-peer.py");
        symlink(fixture, &executable).unwrap();
        Some(Self {
            directory,
            executable,
        })
    }
}
impl Drop for Peer {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.directory).unwrap();
    }
}

fn box_command() -> WorkerCommand {
    WorkerCommand::CreateBox {
        origin: [0.; 3],
        size: [2.; 3],
    }
}
fn assert_reaped(pid: u32) {
    // Linux procfs also contains zombies; absence proves the owned child reaped.
    #[cfg(target_os = "linux")]
    assert!(
        !PathBuf::from(format!("/proc/{pid}")).exists(),
        "worker {pid} remains alive or zombie"
    );
    #[cfg(not(target_os = "linux"))]
    let _ = pid; // Portable contract is covered by Child::wait in implementation.
}
fn blocked(peer: &Peer) {
    let until = Instant::now() + Duration::from_secs(5);
    while !peer.directory.join("blocked").exists() {
        assert!(
            Instant::now() < until,
            "peer never blocked on partial response"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}
fn real_next_session(worker: &SupervisedWorker) {
    if std::env::var_os("IFCLITE_SMLIB_WORKER").is_none() {
        eprintln!("SKIP: next-session geometry requires IFCLITE_SMLIB_WORKER");
        return;
    }
    let WorkerResult::Solid(solid) = worker
        .submit(box_command(), Duration::from_secs(15))
        .unwrap()
        .wait()
        .unwrap()
    else {
        panic!("expected solid")
    };
    let WorkerResult::Volume(volume) = worker
        .submit(
            WorkerCommand::Volume {
                solid,
                relative_accuracy: 1e-8,
            },
            Duration::from_secs(15),
        )
        .unwrap()
        .wait()
        .unwrap()
    else {
        panic!("expected volume")
    };
    assert!((volume - 8.).abs() < 1e-6);
}

#[test]
fn partial_frame_deadline_reaps_and_next_real_session_succeeds() {
    let Some(peer) = Peer::new() else {
        return;
    };
    let (worker, solid, pid) = established_peer_session(&peer);
    let pending = worker
        .submit(
            WorkerCommand::Volume {
                solid,
                relative_accuracy: 1e-8,
            },
            Duration::from_millis(500),
        )
        .unwrap();
    assert!(matches!(pending.wait(), Err(SupervisionError::Deadline)));
    assert!(
        peer.directory.join("blocked").exists(),
        "deadline must interrupt the partial-frame operation"
    );
    assert_reaped(pid);
    assert_eq!(worker.process_id(), None);
    real_next_session(&worker);
}

#[test]
fn cancel_inflight_reaps_before_completion_and_restarts() {
    let Some(peer) = Peer::new() else {
        return;
    };
    let (worker, solid, pid) = established_peer_session(&peer);
    let pending = worker
        .submit(
            WorkerCommand::Volume {
                solid,
                relative_accuracy: 1e-8,
            },
            Duration::from_secs(30),
        )
        .unwrap();
    blocked(&peer);
    pending.cancel();
    assert!(matches!(pending.wait(), Err(SupervisionError::Cancelled)));
    assert_reaped(pid);
    real_next_session(&worker);
}

#[test]
fn drop_kills_inflight_and_rejects_queue_without_orphans() {
    let Some(peer) = Peer::new() else {
        return;
    };
    let (worker, solid, pid) = established_peer_session(&peer);
    let pending = worker
        .submit(
            WorkerCommand::Volume {
                solid,
                relative_accuracy: 1e-8,
            },
            Duration::from_secs(30),
        )
        .unwrap();
    blocked(&peer);
    let queued = worker
        .submit(box_command(), Duration::from_secs(30))
        .unwrap();
    assert!(matches!(
        worker.submit(box_command(), Duration::from_secs(30)),
        Err(SupervisionError::QueueFull)
    ));
    let start = Instant::now();
    drop(worker);
    assert!(start.elapsed() < Duration::from_secs(5));
    assert_reaped(pid);
    assert!(matches!(pending.wait(), Err(SupervisionError::Stopped)));
    assert!(matches!(queued.wait(), Err(SupervisionError::Stopped)));
}

#[test]
fn kernel_error_preserves_session_and_foreign_handles_are_rejected() {
    let Some(path) = std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        eprintln!("SKIP: build native/smlib-adapter and set IFCLITE_SMLIB_WORKER");
        return;
    };
    let worker = SupervisedWorker::new(path.clone(), 1).unwrap();
    let other = SupervisedWorker::new(path, 1).unwrap();
    let WorkerResult::Solid(solid) = worker
        .submit(box_command(), Duration::from_secs(15))
        .unwrap()
        .wait()
        .unwrap()
    else {
        panic!("expected solid")
    };
    let pid = worker.process_id();
    let bad = WorkerCommand::CreateBox {
        origin: [0.; 3],
        size: [-1.; 3],
    };
    assert!(matches!(
        worker.submit(bad, Duration::from_secs(15)).unwrap().wait(),
        Err(SupervisionError::Worker(WorkerError::Kernel { .. }))
    ));
    assert_eq!(worker.process_id(), pid);
    let query = WorkerCommand::Volume {
        solid,
        relative_accuracy: 1e-8,
    };
    assert!(matches!(
        other.submit(query, Duration::from_secs(15)).unwrap().wait(),
        Err(SupervisionError::Worker(WorkerError::WrongWorker))
    ));
    real_next_session(&worker);
}

#[test]
fn restart_invalidates_handles_even_when_wire_session_ids_repeat() {
    let Some(peer) = Peer::new() else {
        return;
    };
    let worker = SupervisedWorker::new(peer.executable.clone(), 1).unwrap();
    // The injected peer's handle is used only to test transport affinity; no
    // geometry result from this peer is asserted or admitted.
    let WorkerResult::Solid(stale) = worker
        .submit(box_command(), Duration::from_secs(5))
        .unwrap()
        .wait()
        .unwrap()
    else {
        panic!("expected transport handle")
    };
    let pid = worker.process_id().unwrap();
    let hung = worker
        .submit(
            WorkerCommand::Volume {
                solid: stale,
                relative_accuracy: 1e-8,
            },
            Duration::from_millis(500),
        )
        .unwrap();
    assert!(matches!(hung.wait(), Err(SupervisionError::Deadline)));
    assert_reaped(pid);
    if std::env::var_os("IFCLITE_SMLIB_WORKER").is_some() {
        real_next_session(&worker);
        let query = WorkerCommand::Volume {
            solid: stale,
            relative_accuracy: 1e-8,
        };
        assert!(matches!(
            worker.submit(query, Duration::from_secs(5)).unwrap().wait(),
            Err(SupervisionError::Worker(WorkerError::WrongWorker))
        ));
    }
}

#[test]
fn queued_deadline_and_cancellation_complete_while_active_io_blocks() {
    let Some(peer) = Peer::new() else {
        return;
    };
    let (worker, solid, pid) = established_peer_session_with_capacity(&peer, 2);
    let active = worker
        .submit(
            WorkerCommand::Volume {
                solid,
                relative_accuracy: 1e-8,
            },
            Duration::from_secs(30),
        )
        .unwrap();
    blocked(&peer);
    let start = Instant::now();
    let expired = worker
        .submit(box_command(), Duration::from_millis(30))
        .unwrap();
    let cancelled = worker
        .submit(box_command(), Duration::from_secs(30))
        .unwrap();
    cancelled.cancel();
    assert!(matches!(cancelled.wait(), Err(SupervisionError::Cancelled)));
    assert!(matches!(expired.wait(), Err(SupervisionError::Deadline)));
    assert!(start.elapsed() < Duration::from_secs(2));
    assert_eq!(worker.process_id(), Some(pid));
    active.cancel();
    assert!(matches!(active.wait(), Err(SupervisionError::Cancelled)));
    assert_reaped(pid);
}

/// Establish the exact session and its durable PID receipt before starting the
/// short operation deadline. Startup/handshake scheduling is not part of these
/// active-interruption assertions.
fn established_peer_session(
    peer: &Peer,
) -> (SupervisedWorker, ifc_lite_geometry_runtime::BrepHandle, u32) {
    established_peer_session_with_capacity(peer, 1)
}
fn established_peer_session_with_capacity(
    peer: &Peer,
    capacity: usize,
) -> (SupervisedWorker, ifc_lite_geometry_runtime::BrepHandle, u32) {
    let worker = SupervisedWorker::new(peer.executable.clone(), capacity).unwrap();
    let startup = worker
        .submit(box_command(), Duration::from_secs(30))
        .unwrap()
        .wait();
    let WorkerResult::Solid(handle) = startup.unwrap_or_else(|error| {
        panic!(
            "peer startup failed: {error:?}; executable={:?}; started={:?}; blocked={:?}",
            peer.executable,
            std::fs::read_to_string(peer.directory.join("started")),
            std::fs::read_to_string(peer.directory.join("blocked"))
        )
    }) else {
        panic!("expected protocol-affinity handle");
    };
    let pid = std::fs::read_to_string(peer.directory.join("started"))
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(worker.process_id(), Some(pid));
    (worker, handle, pid)
}

#[test]
fn unobserved_deadline_and_dropped_ticket_still_retire_processes() {
    for drop_ticket in [false, true] {
        let Some(peer) = Peer::new() else {
            return;
        };
        let (worker, solid, pid) = established_peer_session(&peer);
        let timeout = if drop_ticket {
            Duration::from_secs(30)
        } else {
            Duration::from_millis(500)
        };
        let pending = worker
            .submit(
                WorkerCommand::Volume {
                    solid,
                    relative_accuracy: 1e-8,
                },
                timeout,
            )
            .unwrap();
        // The persistent peer stage can be observed after the deadline already
        // reaped the process; an ephemeral process_id is never the startup signal.
        blocked(&peer);
        let pending = if drop_ticket {
            drop(pending);
            None
        } else {
            Some(pending)
        };
        let until = Instant::now() + Duration::from_secs(5);
        while worker.process_id().is_some() {
            assert!(Instant::now() < until, "unobserved request did not retire");
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_reaped(pid);
        if let Some(pending) = pending {
            assert!(matches!(pending.wait(), Err(SupervisionError::Deadline)));
        }
    }
}

#[test]
fn expired_admission_never_reaches_peer_or_retires_idle_session() {
    let Some(peer) = Peer::new() else {
        return;
    };
    let (worker, solid, pid) = established_peer_session(&peer);
    let result = worker
        .submit(
            WorkerCommand::Volume {
                solid,
                relative_accuracy: 1e-8,
            },
            Duration::ZERO,
        )
        .unwrap()
        .wait();
    assert!(matches!(result, Err(SupervisionError::Deadline)));
    assert!(
        !peer.directory.join("blocked").exists(),
        "expired queued command must never reach the peer"
    );
    assert_eq!(
        worker.process_id(),
        Some(pid),
        "queue expiration must preserve the idle session"
    );
    drop(worker);
    assert_reaped(pid);
}
