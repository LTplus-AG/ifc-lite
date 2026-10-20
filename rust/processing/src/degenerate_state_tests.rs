// SPDX-License-Identifier: MPL-2.0
use super::*;

fn clean_collapsed_mesh() {
    let mut mesh = Mesh::new();
    mesh.positions = vec![0., 0., 0., 1., 0., 0., 1., 0., 0.];
    mesh.normals = vec![0., 0., 1., 0., 0., 1., 0., 0., 1.];
    mesh.indices = vec![0, 1, 2];
    clean(&mut mesh);
    assert!(
        mesh.indices.is_empty(),
        "the real backstop removes the collapsed triangle"
    );
}

#[test]
fn interleaved_element_slices_retain_their_own_mesh_losses_and_restore_the_enclosing_element() {
    if disabled() {
        return;
    }
    let _ambient = begin_element();
    clean_collapsed_mesh();
    let mut first = ElementState::new();
    let mut second = ElementState::new();
    first.with_scope(|| {
        assert_eq!(dropped_this_element(), 0);
        clean_collapsed_mesh();
        second.with_scope(|| {
            clean_collapsed_mesh();
            clean_collapsed_mesh();
        });
        assert_eq!(
            dropped_this_element(),
            1,
            "nested element cannot steal the current tally"
        );
    });
    assert_eq!(
        dropped_this_element(),
        1,
        "ambient triangle loss survives the slice"
    );
    first.with_scope(clean_collapsed_mesh);
    second.with_scope(clean_collapsed_mesh);
    assert_eq!(first.dropped(), 2);
    assert_eq!(second.dropped(), 3);
    assert_eq!(dropped_this_element(), 1);
}

#[test]
fn owned_state_resumes_on_another_worker_without_stealing_either_threads_ambient_losses() {
    if disabled() {
        return;
    }
    let _ambient = begin_element();
    clean_collapsed_mesh();
    let mut state = ElementState::new();
    state.with_scope(clean_collapsed_mesh);
    let mut state = std::thread::spawn(move || {
        let _worker_ambient = begin_element();
        clean_collapsed_mesh();
        clean_collapsed_mesh();
        state.with_scope(|| {
            assert_eq!(
                dropped_this_element(),
                1,
                "the first worker's element loss travels with the state"
            );
            clean_collapsed_mesh();
        });
        assert_eq!(
            dropped_this_element(),
            2,
            "destination ambient tally is restored"
        );
        state
    })
    .join()
    .unwrap();
    assert_eq!(state.dropped(), 2);
    state.with_scope(clean_collapsed_mesh);
    assert_eq!(state.dropped(), 3);
    assert_eq!(
        dropped_this_element(),
        1,
        "origin ambient tally is restored on return"
    );
}

#[test]
fn error_and_unwind_capture_mesh_losses_and_restore_the_ambient_context() {
    if disabled() {
        return;
    }
    let _ambient = begin_element();
    clean_collapsed_mesh();
    let mut state = ElementState::new();
    let result: Result<(), &'static str> = state.with_scope(|| {
        clean_collapsed_mesh();
        Err("element execution failed")
    });
    assert_eq!(result, Err("element execution failed"));
    assert_eq!(state.dropped(), 1);
    assert_eq!(dropped_this_element(), 1);
    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        state.with_scope(|| {
            clean_collapsed_mesh();
            panic!("execution slice failed after editing its mesh");
        });
    }));
    assert!(panic.is_err());
    assert_eq!(
        state.dropped(),
        2,
        "unwinding must retain the topology edit evidence"
    );
    assert_eq!(
        dropped_this_element(),
        1,
        "panic must not leave the failed element installed"
    );
    state.with_scope(clean_collapsed_mesh);
    assert_eq!(
        state.dropped(),
        3,
        "the owned state can resume after unwind"
    );
}
