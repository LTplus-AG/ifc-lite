// SPDX-License-Identifier: MPL-2.0
//! Real Rust/WASM runtime over the inert protocol peer; no geometry qualification.
use super::*;
use crate::retained_browser::receipt::BrowserReceipt;
use ifc_lite_geometry::BoolOp;
use ifc_lite_processing::element::retained_runtime::{
    AsyncRetainedExecutor, Invocation, NumericalLimits, NumericalReceipt, Operand, ReceiptEvidence,
    RuntimeFault,
};

#[wasm_bindgen(inline_js = "export async function m1RuntimePeer() {\n\
  const { peers } = await import('/retained-test/peer.mjs');\n\
  if (!peers.length) throw new Error('inert runtime peer was not constructed');\n\
  return peers.at(-1);\n\
}\n\
export async function m1RuntimeDriver() {\n\
  const { RetainedDriver } = await import('/retained-test/retained-driver.mjs');\n\
  return new RetainedDriver();\n\
}")]
extern "C" {
    #[wasm_bindgen(catch, js_name = m1RuntimePeer)]
    async fn runtime_peer() -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch, js_name = m1RuntimeDriver)]
    async fn runtime_driver() -> Result<JsValue, JsValue>;
}

// Test-only construction: production BrowserWorker::new always owns the real
// SDK driver. Never add a caller-supplied transport to the published runtime.
async fn inert_worker() -> BrowserWorker {
    BrowserWorker {
        owner: Arc::new(Owner {
            identity: next_identity().unwrap(),
            live: AtomicBool::new(true),
            driver: runtime_driver().await.unwrap().unchecked_into(),
        }),
        regions_qualified: false,
        disks_qualified: false,
    }
}
const IDENTITY: [f64; 16] = [
    1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
];
fn limits(bytes: usize) -> NumericalLimits {
    NumericalLimits {
        chord_metres: 0.001,
        angle_degrees: 5.,
        max_bytes: bytes,
    }
}
fn set(peer: &JsValue, key: &str, value: f64) {
    js_sys::Reflect::set(peer, &key.into(), &value.into()).unwrap();
}
fn commands(peer: &JsValue) -> u32 {
    js_sys::Array::from(&js_sys::Reflect::get(peer, &"commands".into()).unwrap()).length()
}
fn placed(receipt: &BrowserReceipt) -> Operand<'_, BrowserReceipt> {
    Operand::Placed {
        receipt,
        world_from_object: IDENTITY,
    }
}
async fn construction(worker: &mut BrowserWorker) -> BrowserReceipt {
    let request = request(RECTANGLE, worker);
    worker
        .invoke(Invocation::Construction(&request), limits(4096))
        .await
        .unwrap()
}

// #7955 / review 4383542900: JS cleanup alone is insufficient if Rust's
// in-flight guard retires the domain when the settled refusal is returned.
#[wasm_bindgen_test(async)]
async fn retained_browser_smlib_free_construction_refusals_preserve_live_inputs() {
    for opcode in [0, 9, 10, 11, 15] {
        let mut worker = inert_worker().await;
        let source = construction(&mut worker).await;
        let incarnation = worker.incarnation();
        let peer = runtime_peer().await.unwrap();
        if opcode == 15 {
            set(&peer, "uploadStatus", 4.);
        } else if opcode != 0 {
            set(&peer, "failOpcode", f64::from(opcode));
            set(&peer, "kernelStatus", 4.);
        }
        let recipe = request(RECTANGLE, &worker);
        assert!(worker
            .invoke(
                Invocation::Construction(&recipe),
                limits(if opcode == 0 { 8 } else { 4096 }),
            )
            .await
            .is_err());
        assert_eq!(worker.incarnation(), incarnation);
        source.validate_live().unwrap();
        let objects = js_sys::Reflect::get(&peer, &"objects".into()).unwrap();
        assert_eq!(
            js_sys::Reflect::get(&objects, &"size".into())
                .unwrap()
                .as_f64(),
            Some(1.),
            "only the previously sealed input remains"
        );
        set(&peer, "failOpcode", 0.);
        js_sys::Reflect::delete_property(
            &js_sys::Object::from(peer.clone()),
            &"uploadStatus".into(),
        )
        .unwrap();
        construction(&mut worker).await.validate_live().unwrap();
        source.validate_live().unwrap();
    }
}

// #7955: this executes runtime.rs and receipt.rs, not only the JS driver.
#[wasm_bindgen_test(async)]
async fn retained_browser_smlib_free_runtime_lifetimes_limits_and_capabilities() {
    let mut worker = inert_worker().await;
    let source = construction(&mut worker).await;
    let peer = runtime_peer().await.unwrap();
    assert!(matches!(
        source.evidence(),
        ReceiptEvidence::Construction(_)
    ));
    let affine = worker
        .invoke(
            Invocation::Affine {
                input: &source,
                column_major: IDENTITY,
            },
            limits(4096),
        )
        .await
        .unwrap();
    assert!(
        matches!(affine.evidence(), ReceiptEvidence::Affine { input, .. } if input == source.object())
    );
    assert!(affine.belongs_to_domain(source.domain()));
    let boolean = worker
        .invoke(
            Invocation::Boolean {
                left: placed(&source),
                right: placed(&affine),
                operation: BoolOp::Union,
            },
            limits(4096),
        )
        .await
        .unwrap();
    assert!(
        matches!(boolean.evidence(), ReceiptEvidence::Boolean { left, right, empty: false, .. } if left == source.object() && right == affine.object())
    );
    // Receipt accounting includes Vec capacity, not only the 160-byte payload.
    let allocated = boolean.buffer_bytes().unwrap();
    assert!((160..=4096).contains(&allocated));
    drop(affine);
    source.validate_live().unwrap();
    boolean.validate_live().unwrap();

    // A missing capability submits only the query, never a numerical operation.
    set(&peer, "capabilities", 1.);
    let before = commands(&peer);
    let error = worker
        .invoke(
            Invocation::Affine {
                input: &source,
                column_major: IDENTITY,
            },
            limits(4096),
        )
        .await
        .err()
        .unwrap();
    assert_eq!(
        error,
        RuntimeFault::unqualified("retained adapter extension unavailable")
    );
    assert_eq!(commands(&peer), before + 1);
    let before = commands(&peer);
    let error = worker
        .invoke(
            Invocation::Boolean {
                left: placed(&source),
                right: placed(&source),
                operation: BoolOp::Union,
            },
            limits(4096),
        )
        .await
        .err()
        .unwrap();
    assert_eq!(
        error,
        RuntimeFault::unqualified("retained adapter extension unavailable")
    );
    assert_eq!(commands(&peer), before + 1);
    source.validate_live().unwrap();
    set(&peer, "capabilities", 49.);

    // Transactional kernel/resource refusals must disarm the Rust flight too.
    set(&peer, "failOpcode", 5.);
    set(&peer, "kernelStatus", 4.);
    assert!(worker
        .invoke(
            Invocation::Boolean {
                left: placed(&source),
                right: placed(&source),
                operation: BoolOp::Union
            },
            limits(4096)
        )
        .await
        .is_err());
    source.validate_live().unwrap();
    set(&peer, "failOpcode", 0.);
    assert!(worker
        .invoke(
            Invocation::Boolean {
                left: placed(&source),
                right: placed(&source),
                operation: BoolOp::Union
            },
            limits(8)
        )
        .await
        .is_err());
    source.validate_live().unwrap();
    boolean.validate_live().unwrap();

    // Match the native bound: the 128th operation succeeds; the 129th is local.
    let mut chain = worker
        .invoke(
            Invocation::Affine {
                input: &source,
                column_major: IDENTITY,
            },
            limits(4096),
        )
        .await
        .unwrap();
    for _ in 1..128 {
        chain = worker
            .invoke(
                Invocation::Affine {
                    input: &chain,
                    column_major: IDENTITY,
                },
                limits(4096),
            )
            .await
            .unwrap();
    }
    // Drain queued release work before measuring whether admission submits frames.
    worker.capabilities().await.unwrap();
    let before = commands(&peer);
    for call in [
        Invocation::Affine {
            input: &chain,
            column_major: IDENTITY,
        },
        Invocation::Boolean {
            left: placed(&chain),
            right: placed(&source),
            operation: BoolOp::Union,
        },
    ] {
        assert_eq!(
            worker.invoke(call, limits(4096)).await.err().unwrap(),
            RuntimeFault::resource_limit("retained operation depth")
        );
    }
    assert_eq!(commands(&peer), before);
    chain.validate_live().unwrap();

    let mut foreign = inert_worker().await;
    let foreign_source = construction(&mut foreign).await;
    let foreign_peer = runtime_peer().await.unwrap();
    let before = commands(&foreign_peer);
    assert!(foreign
        .invoke(
            Invocation::Affine {
                input: &source,
                column_major: IDENTITY
            },
            limits(4096)
        )
        .await
        .is_err());
    assert_eq!(commands(&foreign_peer), before);
    foreign_source.validate_live().unwrap();

    set(&peer, "failOpcode", 5.);
    set(&peer, "kernelStatus", 8.);
    assert!(worker
        .invoke(
            Invocation::Boolean {
                left: placed(&source),
                right: placed(&source),
                operation: BoolOp::Union
            },
            limits(4096)
        )
        .await
        .is_err());
    assert_eq!(worker.incarnation(), 0);
    assert!(source.validate_live().is_err());
    assert!(boolean.validate_live().is_err());
    foreign_source.validate_live().unwrap();
}
