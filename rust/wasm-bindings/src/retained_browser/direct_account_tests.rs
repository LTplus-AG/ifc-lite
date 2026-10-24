// SPDX-License-Identifier: MPL-2.0
//! #7955 R2.1: direct real-Worker futures change ambient accounts after Pending.
use super::{
    bridge::tests::{request, RECTANGLE},
    receipt::BrowserReceipt,
    BrowserWorker,
};
use ifc_lite_geometry::{
    document::retained_source::ConstructionRole,
    resource::{self, ExecutionAccount, ExecutionPolicy, OwnedResourceContext, ResourceLimits},
};
use ifc_lite_processing::element::runtime::NumericalLimits;
use std::{
    future::{poll_fn, Future},
    task::{Context, Waker},
};
use wasm_bindgen_test::*;
fn account(limits: ResourceLimits) -> ExecutionAccount {
    ExecutionAccount::new(ExecutionPolicy::Bounded(limits))
}
async fn alternate<F: Future>(
    future: F,
    first: &ExecutionAccount,
    later: Option<&ExecutionAccount>,
) -> F::Output {
    assert!(!resource::is_active());
    let mut future = std::pin::pin!(future);
    assert!(
        first
            .scope(|| future
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop())))
            .is_pending(),
        "actual Worker must suspend after capturing A"
    );
    assert!(!resource::is_active(), "no account guard crosses Pending");
    poll_fn(|cx| {
        let result = match later {
            Some(account) => account.scope(|| future.as_mut().poll(cx)),
            None => future.as_mut().poll(cx),
        };
        assert!(
            !resource::is_active(),
            "each resumed poll restores ambient state"
        );
        result
    })
    .await
}
// The private packet layout is a versioned compatibility contract. Include both
// the transferred packet and its separately owned decoded inventory/roles.
fn backing(
    positions: usize,
    indices: usize,
    normals: usize,
    faces: usize,
    roots: usize,
    roles: usize,
) -> (u64, u64) {
    let packet = 80 + roles * 24;
    let mesh = positions * 8 + indices * 4 + normals * 8 + faces * 4 + roots * 4 + packet + 16;
    let inventory = packet + roles * std::mem::size_of::<ConstructionRole>();
    (mesh as u64, inventory as u64)
}
fn construction_backing(value: &super::BrowserRealization) -> (u64, u64) {
    let completion = value.completion();
    let mesh = &completion.tessellation;
    let proof = completion.source_correspondence().unwrap();
    backing(
        mesh.positions.len(),
        mesh.indices.len(),
        mesh.flat_corner_normals.len(),
        mesh.revision_local_faces.len(),
        proof.triangle_roots().len(),
        proof.roles().len(),
    )
}
#[wasm_bindgen_test(async)]
async fn retained_browser_j5_direct_construction_charges_captured_account() {
    for ambient in [false, true] {
        let mut worker = BrowserWorker::new().unwrap();
        let request = request(RECTANGLE, &worker)
            .with_source_contract(0, 1)
            .unwrap();
        let a = account(Default::default());
        let b = account(Default::default());
        let value = alternate(
            worker.evaluate_retained(request, 0.001, 5., 16 << 20),
            &a,
            ambient.then_some(&b),
        )
        .await
        .unwrap();
        let (mesh, inventory) = construction_backing(&value);
        assert_eq!(
            a.usage().live_bytes,
            mesh + inventory,
            "J5_DIRECT construction inventory belongs to captured A"
        );
        assert_eq!(
            a.usage().copy_bytes,
            mesh + inventory,
            "J5_DIRECT construction copies belong to captured A"
        );
        assert_eq!(
            b.usage(),
            resource::Usage::default(),
            "ambient B remains unchanged"
        );
        drop(value);
        assert_eq!(a.usage().live_bytes, 0);
        assert_eq!(a.usage().copy_bytes, mesh + inventory);
    }
}
#[wasm_bindgen_test(async)]
async fn retained_browser_j5_direct_affine_charges_captured_account() {
    for ambient in [false, true] {
        let mut worker = BrowserWorker::new().unwrap();
        worker.qualify_dependencies().await.unwrap();
        let request = request(RECTANGLE, &worker)
            .with_source_contract(0, 1)
            .unwrap();
        let source = BrowserReceipt::Construction(Box::new(
            worker
                .evaluate_retained(request, 0.001, 5., 16 << 20)
                .await
                .unwrap(),
        ));
        let a = account(Default::default());
        let b = account(Default::default());
        let matrix = [
            -2., 0., 0., 0., 0., 3., 0., 0., 0., 0., 0.5, 0., 7., -1., 2., 1.,
        ];
        let limits = NumericalLimits {
            chord_metres: 0.001,
            angle_degrees: 5.,
            max_bytes: 16 << 20,
        };
        let value = alternate(
            worker.copy_retained_affine_with_limits(&source, matrix, limits),
            &a,
            ambient.then_some(&b),
        )
        .await
        .unwrap();
        let mesh = value.source_mesh.as_ref().unwrap();
        let proof = value.source_correspondence.as_ref().unwrap();
        let (mesh_bytes, inventory) = backing(
            mesh.positions.len(),
            mesh.indices.len(),
            mesh.flat_corner_normals.len(),
            mesh.revision_local_faces.len(),
            proof.triangle_roots().len(),
            proof.roles().len(),
        );
        let wire = (mesh.source_inventory.len() + mesh.source_handle.len()) as u64;
        assert_eq!(
            a.usage().live_bytes,
            mesh_bytes + inventory,
            "J5_DIRECT affine inventory belongs to captured A"
        );
        assert_eq!(
            a.usage().copy_bytes,
            mesh_bytes + 2 * inventory + wire,
            "J5_DIRECT both affine inventory copies belong to captured A"
        );
        assert_eq!(
            b.usage(),
            resource::Usage::default(),
            "ambient B remains unchanged"
        );
        drop(value);
        assert_eq!(a.usage().live_bytes, 0);
        assert_eq!(a.usage().copy_bytes, mesh_bytes + 2 * inventory + wire);
    }
}
#[wasm_bindgen_test(async)]
async fn retained_browser_j5_direct_inventory_refusal_stops_captured_account() {
    for ambient in [false, true] {
        for copy_limit in [false, true] {
            let mut worker = BrowserWorker::new().unwrap();
            let request = request(RECTANGLE, &worker)
                .with_source_contract(0, 1)
                .unwrap();
            let control = worker
                .evaluate_retained(request.clone(), 0.001, 5., 16 << 20)
                .await
                .unwrap();
            let (mesh, inventory) = construction_backing(&control);
            assert!(inventory > 0);
            drop(control);
            // Actual same-source mesh fits, but its duplicate inventory does not.
            let limits = if copy_limit {
                ResourceLimits {
                    copy_bytes: Some(mesh),
                    ..Default::default()
                }
            } else {
                ResourceLimits {
                    live_bytes: Some(mesh),
                    ..Default::default()
                }
            };
            let a = account(limits);
            let captured = a.scope(OwnedResourceContext::capture_current);
            let b = account(Default::default());
            let result = alternate(
                worker.evaluate_retained(request, 0.001, 5., 16 << 20),
                &a,
                ambient.then_some(&b),
            )
            .await;
            assert!(
                result.is_err(),
                "J5_DIRECT inventory refusal must stop captured A"
            );
            let terminal = a.check().unwrap_err();
            assert_eq!(captured.check(), Err(terminal));
            assert_eq!(
                b.usage(),
                resource::Usage::default(),
                "ambient B pays no failed inventory"
            );
            b.check().unwrap();
            assert_eq!(worker.incarnation(), 0);
        }
    }
}
