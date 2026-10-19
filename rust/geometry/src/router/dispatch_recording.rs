// SPDX-License-Identifier: MPL-2.0
//! Registry identity is recorded at numerical entry, not metadata selection.
use super::{dispatch_capture, GeometryProcessor, GeometryRouter};

impl GeometryRouter {
    pub(crate) fn processor_emitter(&self, processor: &dyn GeometryProcessor) -> Option<super::ProcessorEmitter> {
        self.processors.emitter_for(processor)
    }
    pub(crate) fn record_processor_dispatch(&self, processor: &dyn GeometryProcessor) {
        if dispatch_capture::enabled() {
            if let Some(emitter) = self.processors.emitter_for(processor) {
                dispatch_capture::record(emitter);
            }
        }
    }
}
