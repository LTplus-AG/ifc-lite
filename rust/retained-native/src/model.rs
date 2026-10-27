// SPDX-License-Identifier: MPL-2.0
//! Native host for the shared asynchronous controller.
use crate::NativeWorker;
use ifc_lite_core::SourceBundle;
use ifc_lite_processing::element::retained_runtime::{
    run_model_with_worker, ModelOptions, ModelSummary, ProductOutcome, RetainedExecutionError,
};
use std::{
    future::Future,
    path::{Path, PathBuf},
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
/// Process one model with a fresh driver. Use [`NativeModelDriver`] to retain
/// a qualified worker across separate model calls.
pub fn run_model_native(
    source: Arc<SourceBundle>,
    worker_path: impl AsRef<Path>,
    options: &ModelOptions,
    sink: impl FnMut(ProductOutcome),
) -> Result<ModelSummary, RetainedExecutionError> {
    run_model_native_timed(source, worker_path, options, sink).map(|(summary, _)| summary)
}

/// Same single-model entry, with diagnostic phase observations excluding sink
/// time. Each call creates a fresh driver; use [`NativeModelDriver`] for reuse.
pub fn run_model_native_timed(
    source: Arc<SourceBundle>,
    worker_path: impl AsRef<Path>,
    options: &ModelOptions,
    mut sink: impl FnMut(ProductOutcome),
) -> Result<(ModelSummary, crate::NativeTimings), RetainedExecutionError> {
    NativeModelDriver::new(worker_path).run_model(source, options, |outcome, _| sink(outcome))
}

/// Owns one numerical peer for a corpus; source state remains model-local.
pub struct NativeModelDriver {
    path: PathBuf,
    worker: Option<crate::timing::MeasuredWorker>,
    timing: std::rc::Rc<std::cell::Cell<crate::NativeTimings>>,
}
impl NativeModelDriver {
    pub fn new(path: impl AsRef<Path>) -> Self {
        Self {
            path: path.as_ref().to_path_buf(),
            worker: None,
            timing: Default::default(),
        }
    }
    pub fn with_worker(path: impl AsRef<Path>, worker: NativeWorker) -> Self {
        let mut driver = Self::new(path);
        driver.worker = Some(crate::timing::MeasuredWorker {
            worker,
            timing: driver.timing.clone(),
        });
        driver
    }
    pub fn run_model(
        &mut self,
        source: Arc<SourceBundle>,
        options: &ModelOptions,
        mut sink: impl FnMut(ProductOutcome, f64),
    ) -> Result<(ModelSummary, crate::NativeTimings), RetainedExecutionError> {
        use crate::timing::MeasuredWorker;
        use std::{cell::Cell, time::Instant};
        self.timing.set(Default::default());
        let timing = &self.timing;
        let path = &self.path;
        let sink_ms = Cell::new(0.);
        let start = Instant::now();
        let result = block_on(run_model_with_worker(
            source,
            options,
            &mut self.worker,
            || {
                let start = Instant::now();
                let result = NativeWorker::spawn(path);
                let mut observed = timing.get();
                observed.startup_and_qualification_ms += start.elapsed().as_secs_f64() * 1000.;
                timing.set(observed);
                result.map(|worker| MeasuredWorker {
                    worker,
                    timing: timing.clone(),
                })
            },
            |outcome, ms| {
                let start = Instant::now();
                sink(outcome, ms);
                sink_ms.set(sink_ms.get() + start.elapsed().as_secs_f64() * 1000.);
            },
        ));
        let summary = result?;
        let mut observed = timing.get();
        observed.total_ms = (start.elapsed().as_secs_f64() * 1000. - sink_ms.get()).max(0.);
        observed.product_ms = summary.product_ms;
        observed.controller_and_publication_ms = (observed.total_ms
            - observed.startup_and_qualification_ms
            - observed.construction_ms
            - observed.affine_ms
            - observed.boolean_ms)
            .max(0.);
        Ok((summary, observed))
    }
}
