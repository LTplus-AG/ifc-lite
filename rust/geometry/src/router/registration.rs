// SPDX-License-Identifier: MPL-2.0
//! Processor replacement and the origin contract used by construction planning.
use super::{GeometryProcessor, GeometryRouter, ProcessorOrigin};
use ifc_lite_core::{DecodedEntity, IfcType};
use std::rc::Rc;

impl GeometryRouter {
    /// Register a geometry processor
    pub fn register(&mut self, processor: Box<dyn GeometryProcessor>) {
        self.register_with_origin(processor, ProcessorOrigin::Custom);
    }

    pub(super) fn register_with_origin(
        &mut self,
        processor: Box<dyn GeometryProcessor>,
        origin: ProcessorOrigin,
    ) {
        self.execution_owner.changed();
        let processor_rc: Rc<dyn GeometryProcessor> = Rc::from(processor);
        for ifc_type in processor_rc.supported_types() {
            self.processors.insert(ifc_type, Rc::clone(&processor_rc), origin);
        }
    }

    /// Classify dispatch without initializing a processor or touching its log.
    pub(crate) fn processor_origin(&self, ifc_type: &IfcType) -> Option<ProcessorOrigin> {
        self.processors.origin(ifc_type)
    }

    /// Whether `item` of `element` takes the structural member-face processor
    /// (#9668): a face of a structural member, the length unit admitted (as
    /// `processor_for` requires), and that type's processor the built-in one
    /// or none (a registered or configured processor still wins). The item
    /// walk and the element-frame rebase both decide with this.
    pub(crate) fn member_face_selected(&self, item: &DecodedEntity, element: &DecodedEntity) -> bool {
        crate::processors::is_member_face_item(item, element)
            && !self.length_unit_refused
            && matches!(self.processor_origin(&item.ifc_type), None | Some(ProcessorOrigin::Builtin))
    }
}
