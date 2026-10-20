// SPDX-License-Identifier: MPL-2.0
//! Retained runtime review findings 1/2/4: actual SDK delivery boundaries.
use super::*;

fn controller() -> Option<Controller> {
    let Some(executable) = std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        eprintln!("SKIP actual SDK: set IFCLITE_SMLIB_WORKER to freshly built pinned adapter");
        return None;
    };
    let (_, receiver) = mpsc::sync_channel(1);
    Some(Controller {
        executable,
        receiver,
        stopping: Arc::new(AtomicBool::new(false)),
        pid: Arc::new(Mutex::new(None)),
        queued: VecDeque::new(),
        available: None,
    })
}
fn request() -> (Request, PendingCommand) {
    let deadline = Instant::now() + Duration::from_secs(30);
    let claim = Arc::new(Claim::new(deadline));
    let (response, receiver) = mpsc::channel();
    (
        Request {
            _admission: Admission(Arc::new(AtomicUsize::new(1))),
            command: WorkerCommand::CreateBox {
                origin: [0.; 3],
                size: [2.; 3],
            },
            deadline,
            claim: claim.clone(),
            response,
        },
        PendingCommand {
            claim,
            response: receiver,
        },
    )
}
fn reaped(control: &crate::process_control::ProcessControl) {
    assert!(!control.is_live());
    #[cfg(target_os = "linux")]
    assert!(!std::path::Path::new(&format!("/proc/{}", control.id())).exists());
}
fn next_box(controller: &mut Controller, old: u64) -> (BrepHandle, u64) {
    let (request, pending) = request();
    let result = controller.perform(&request);
    respond(request, result);
    let WorkerResult::Solid(solid) = pending.wait().unwrap() else {
        panic!("box")
    };
    let worker = controller.available.as_mut().unwrap();
    assert_ne!(worker.incarnation(), old);
    assert!((worker.volume(solid, 1e-8).unwrap() - 8.).abs() < 1e-6);
    assert!(worker.is_manifold(solid).unwrap());
    (solid, worker.incarnation())
}
#[test]
fn actual_sdk_failed_send_and_unread_queue_retire_before_next_success() {
    for unread in [false, true] {
        let Some(mut controller) = controller() else {
            return;
        };
        let (request, pending) = request();
        let envelope = controller.perform(&request);
        let worker = controller.available.as_ref().unwrap();
        let control = worker.process_control();
        let old = worker.incarnation();
        if unread {
            respond(request, envelope); // successful send to a live receiver
            drop(pending); // destruction of the queued envelope must retire too
        } else {
            drop(pending);
            respond(request, envelope); // SendError owns and destroys envelope
        }
        reaped(&control);
        let (solid, _) = next_box(&mut controller, old);
        controller
            .available
            .as_mut()
            .unwrap()
            .release(solid)
            .unwrap();
    }
}
#[test]
fn actual_sdk_cancel_wins_before_claim_and_claimed_drop_keeps_session_live() {
    let Some(mut controller) = controller() else {
        return;
    };
    let (request, pending) = request();
    let envelope = controller.perform(&request);
    let control = controller.available.as_ref().unwrap().process_control();
    let old = controller.available.as_ref().unwrap().incarnation();
    respond(request, envelope);
    pending.cancel();
    assert!(matches!(pending.wait(), Err(SupervisionError::Cancelled)));
    reaped(&control);
    let (solid, _) = next_box(&mut controller, old);
    // PendingCommand's destructor already ran after claim. It must not retire.
    let worker = controller.available.as_mut().unwrap();
    assert!(worker.is_live());
    worker.release(solid).unwrap();
}
#[test]
fn actual_sdk_old_envelope_cannot_retire_replacement_child() {
    let Some(mut controller) = controller() else {
        return;
    };
    let (request, pending) = request();
    let envelope = controller.perform(&request);
    let worker = controller.available.as_ref().unwrap();
    let control = worker.process_control();
    let old = worker.incarnation();
    control.terminate().unwrap();
    let (solid, fresh) = next_box(&mut controller, old);
    drop(envelope);
    drop(request);
    drop(pending);
    let worker = controller.available.as_mut().unwrap();
    assert_eq!(worker.incarnation(), fresh);
    assert!((worker.volume(solid, 1e-8).unwrap() - 8.).abs() < 1e-6);
    worker.release(solid).unwrap();
}
