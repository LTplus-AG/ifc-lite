// SPDX-License-Identifier: MPL-2.0
//! #7955: the shared lifecycle running on an actual SMLib module Worker.
use super::BrowserWorker;
use ifc_lite_core::SourceBundle;
use ifc_lite_processing::element::retained_runtime::*;
use wasm_bindgen_futures::JsFuture;
use wasm_bindgen_test::*;
const CASCADE: &[u8] = include_bytes!("../../../../tests/fixtures/synthetic-retained/refusal-cascade.ifc");

#[wasm_bindgen_test(async)]
async fn retained_browser_refusals_preserve_worker_and_release_objects() {
    let mut native = BrowserWorker::new().unwrap();
    native.qualify().await.unwrap();
    let incarnation = native.incarnation();
    let mut worker = Some(native);
    let mut rows = Vec::new();
    let summary = run_model_with_worker(SourceBundle::new(CASCADE.to_vec()),
        &ModelOptions { max_restarts: 0, ..Default::default() }, &mut worker,
        || panic!("source refusal must not replace the browser Worker"),
        |o, _| rows.push(o)).await.unwrap();
    assert_eq!((summary.candidates, summary.published, summary.restarts), (9,1,0));
    assert_eq!(summary.by_code.get("opening_unsupported"), Some(&4));
    assert_eq!(summary.by_code.get("operation_unsupported"), Some(&4));
    let worker = worker.as_ref().unwrap();
    assert_eq!(worker.incarnation(), incarnation);
    assert_eq!(JsFuture::from(worker.owner.driver.live_object_count()).await.unwrap().as_f64(), Some(0.));
    let reused = rows.iter().find_map(|o| match o {
        ProductOutcome::Published(s) if s.product_id == 104 => Some(s), _ => None,
    }).expect("#104 must publish after four opening refusals");
    assert_eq!(reused.parts.len(), 1);
    let mut fresh = BrowserWorker::new().unwrap();
    fresh.qualify().await.unwrap();
    let mut fresh = Some(fresh);
    let mut control = Vec::new();
    run_model_with_worker(SourceBundle::new(CASCADE.to_vec()),
        &ModelOptions { ids: Some([104].into_iter().collect()), ..Default::default() },
        &mut fresh, || panic!("control has a qualified Worker"), |o, _| control.push(o)).await.unwrap();
    let ProductOutcome::Published(control) = control.pop().unwrap() else { panic!("fresh control") };
    assert_eq!(reused.parts[0].positions, control.parts[0].positions);
    assert_eq!(reused.parts[0].indices, control.parts[0].indices);
    assert_eq!(reused.parts[0].world_from_object, control.parts[0].world_from_object);
    web_sys::console::log_1(&"sdk witness executed: retained refusal browser lifecycle".into());
}

#[wasm_bindgen_test(async)]
async fn retained_browser_consumed_hosts_preserve_settled_worker() {
    let text = std::str::from_utf8(CASCADE).unwrap().replace("#24,#333", "#24,#26");
    let mut native = BrowserWorker::new().unwrap();
    native.qualify().await.unwrap();
    let incarnation = native.incarnation();
    let mut worker = Some(native);
    let mut rows = Vec::new();
    let summary = run_model_with_worker(SourceBundle::new(text.into_bytes()),
        &ModelOptions { ids: Some((100..105).collect()), max_restarts: 0, ..Default::default() },
        &mut worker, || panic!("settled empty-result refusal must not replace the Worker"),
        |o, _| rows.push(o)).await.unwrap();
    assert_eq!((summary.candidates, summary.published, summary.restarts), (5,1,0));
    assert_eq!(summary.by_code.get("empty_result"), Some(&4));
    assert!(matches!(rows.last(), Some(ProductOutcome::Published(s)) if s.product_id == 104));
    let worker = worker.as_ref().unwrap();
    assert_eq!(worker.incarnation(), incarnation);
    assert_eq!(JsFuture::from(worker.owner.driver.live_object_count()).await.unwrap().as_f64(), Some(0.));
    web_sys::console::log_1(&"sdk witness executed: retained consumed-host browser lifecycle".into());
}

// #7955 / Holter R5: synchronized band failures are product-local. Unknown
// statuses still retire the Worker, even if a faulty executor leaves it live.
#[wasm_bindgen_test(async)]
async fn retained_browser_layer_kernel_refusal_preserves_following_product() {
    use super::{BrowserCancellation, receipt::BrowserReceipt};
    use ifc_lite_geometry::BoolOp;
    const CURVED: &[u8] = include_bytes!("../../../../tests/fixtures/synthetic-retained/f-a-curved.ifc");
    struct Refusing { inner: BrowserWorker, intersections: usize, status: i32 }
    impl RetainedRuntime for Refusing {
        type Receipt = BrowserReceipt;
        fn domain(&self) -> BrowserCancellation { self.inner.domain() }
        fn incarnation(&self) -> u64 { self.inner.incarnation() }
    }
    impl AsyncRetainedExecutor for Refusing {
        async fn invoke(&mut self, call: Invocation<'_, BrowserReceipt>, limits: NumericalLimits)
            -> Result<BrowserReceipt, RuntimeFault> {
            if matches!(&call, Invocation::Boolean { operation: BoolOp::Intersection, .. }) {
                self.intersections += 1;
                if self.intersections == 2 {
                    return Err(RuntimeFault::kernel(self.status, "M4 injected second band refusal"));
                }
            }
            self.inner.invoke(call, limits).await
        }
    }
    for status in [4,8] {
        let mut inner = BrowserWorker::new().unwrap();
        inner.qualify().await.unwrap();
        let incarnation = inner.incarnation();
        let mut worker = Some(Refusing { inner, intersections: 0, status });
        let mut rows = Vec::new();
        let summary = run_model_with_worker(SourceBundle::new(CURVED.to_vec()),
            &ModelOptions { ids: Some([55,122].into_iter().collect()), max_restarts: 0, ..Default::default() },
            &mut worker, || panic!("zero restarts forbids replacement"), |o, _| rows.push(o)).await.unwrap();
        assert_eq!((summary.candidates, summary.restarts), (2,0));
        assert!(matches!(rows[0], ProductOutcome::Refused {
            product_id: 55, refusal: RetainedProductRefusal::KernelFailure { status: s }, ..
        } if s == status));
        if status == 4 {
            assert_eq!(summary.published, 1);
            assert!(matches!(rows[1], ProductOutcome::Published(ref p) if p.product_id == 122));
            let worker = worker.as_ref().expect("settled Worker retained");
            assert_eq!(worker.incarnation(), incarnation);
            assert_eq!(JsFuture::from(worker.inner.owner.driver.live_object_count()).await.unwrap().as_f64(), Some(0.));
        } else {
            assert!(matches!(rows[1], ProductOutcome::Refused {
                product_id: 122, refusal: RetainedProductRefusal::WorkerFault, ..
            }));
            assert!(worker.is_none(), "unknown kernel status must retire the Worker");
        }
    }
    web_sys::console::log_1(&"sdk witness executed: retained M4 refusal browser lifecycle".into());
}
