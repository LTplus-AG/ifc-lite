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
    block_on(run_model(
        source,
        options,
        || NativeWorker::spawn(worker_path.as_ref()),
        sink,
    ))
}
