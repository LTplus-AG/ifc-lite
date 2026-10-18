// SPDX-License-Identifier: MPL-2.0
//! Processor replacement and the origin contract used by construction planning.
use super::{GeometryProcessor, GeometryRouter, ProcessorOrigin};
use ifc_lite_core::IfcType;
use std::rc::Rc;

impl GeometryRouter {
    /// Register a geometry processor
    pub fn register(&mut self, processor: Box<dyn GeometryProcessor>) {
        self.register_with_origin(processor, ProcessorOrigin::Custom);
    }

    pub(super) fn register_with_origin(&mut self, processor: Box<dyn GeometryProcessor>, origin: ProcessorOrigin) {
        self.execution_owner.changed();
        let processor_rc: Rc<dyn GeometryProcessor> = Rc::from(processor);
        let emitter_id = super::dispatch_capture::ProcessorEmitterId::fresh();
        for ifc_type in processor_rc.supported_types() {
            self.processors.insert(ifc_type, Rc::clone(&processor_rc), origin, emitter_id);
        }
    }

    /// Classify dispatch without initializing a processor or touching its log.
    pub(crate) fn processor_origin(&self, ifc_type: &IfcType) -> Option<ProcessorOrigin> {
        self.processors.origin(ifc_type)
    }

}
