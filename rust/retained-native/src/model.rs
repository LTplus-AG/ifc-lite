// SPDX-License-Identifier: MPL-2.0
//! Native host for the shared asynchronous controller.
use crate::NativeWorker;
use ifc_lite_core::SourceBundle;
use ifc_lite_processing::element::retained_runtime::{
    run_model, ModelOptions, ModelSummary, ProductOutcome, RetainedExecutionError,
};
use std::{
    future::Future,
    path::Path,
    sync::Arc,
    task::{Context, Poll, Wake, Waker},
};

struct ThreadWake(std::thread::Thread);
impl Wake for ThreadWake {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }
    fn wake_by_ref(self: &Arc<Self>) {
        self.0.unpark();
    }
}
/// Park/unpark avoids a busy loop and preserves wakeups before parking.
pub fn block_on<T>(future: impl Future<Output = T>) -> T {
    let waker = Waker::from(Arc::new(ThreadWake(std::thread::current())));
    let mut context = Context::from_waker(&waker);
    let mut future = std::pin::pin!(future);
    loop {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(value) => return value,
            Poll::Pending => std::thread::park(),
        }
    }
}
pub fn run_model_native(
    source: Arc<SourceBundle>,
    worker_path: impl AsRef<Path>,
    options: &ModelOptions,
    sink: impl FnMut(ProductOutcome),
) -> Result<ModelSummary, RetainedExecutionError> {
    run_model_native_timed(source, worker_path, options, sink).map(|(summary, _)| summary)
}

/// Same native entry, with diagnostic phase observations excluding sink time.
pub fn run_model_native_timed(
    source: Arc<SourceBundle>,
    worker_path: impl AsRef<Path>,
    options: &ModelOptions,
    mut sink: impl FnMut(ProductOutcome),
) -> Result<(ModelSummary, crate::NativeTimings), RetainedExecutionError> {
    use crate::timing::MeasuredWorker;
    use std::{cell::Cell, rc::Rc, time::Instant};
    let timing = Rc::new(Cell::new(crate::NativeTimings::default()));
    let sink_ms = Cell::new(0.);
    let start = Instant::now();
    let summary = block_on(run_model(
        source,
        options,
        || {
            let start = Instant::now();
            let result = NativeWorker::spawn(worker_path.as_ref());
            let mut observed = timing.get();
            observed.startup_and_qualification_ms += start.elapsed().as_secs_f64() * 1000.;
            timing.set(observed);
            result.map(|worker| MeasuredWorker {
                worker,
                timing: timing.clone(),
            })
        },
        |outcome| {
            let start = Instant::now();
            sink(outcome);
            sink_ms.set(sink_ms.get() + start.elapsed().as_secs_f64() * 1000.);
        },
    ))?;
    let mut observed = timing.get();
    observed.total_ms = (start.elapsed().as_secs_f64() * 1000. - sink_ms.get()).max(0.);
    observed.controller_and_publication_ms = (observed.total_ms
        - observed.startup_and_qualification_ms
        - observed.construction_ms
        - observed.affine_ms
        - observed.boolean_ms)
        .max(0.);
    Ok((summary, observed))
}
