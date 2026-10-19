// SPDX-License-Identifier: MPL-2.0
//! Terminal cancellation forwards reached source reports without publishing work.
use super::{GeometryProgram, ProgramError};
use super::item::ItemStep;
use crate::{GeometryRouter, construction::ConstructionReports};
pub(super) fn publish(reports:ConstructionReports,router:&GeometryRouter) {
    if reports.curve_capped {router.record_unsupported_item(ifc_lite_core::IfcType::IfcBSplineCurveWithKnots);}
    for ty in reports.face_refused {router.record_unsupported_item(ty);}
}
impl GeometryProgram {
    pub fn cancel_with_reports(&mut self,router:&GeometryRouter) -> Result<(), ProgramError> {
        self.validate_cancel_router(router)?;
        if let Some(reports)=self.pending_item_reports.take() {publish(reports.take(),router);}
        if let Some(step)=self.step.take() {
            match step {
                ItemStep::Source(source)=>publish(source.reports,router),
                ItemStep::Ready(ready)=>publish(ready.reports,router),
                ItemStep::Complete(value)=>publish(value.reports,router),
                ItemStep::Child(mut child)=>{
                    publish(std::mem::take(&mut child.reports),router);
                    child.program.cancel_with_reports(router).expect("validated cancellation router");
                }

            }
        }
        if let Some(boolean)=&mut self.boolean {boolean.cancel_with_reports(router);}
        if let Some(cache)=&mut self.cache {cache.cancel_with_reports(router);}
        if let Some(mapping)=&mut self.mapping {mapping.cancel_with_reports(router);}
        if let Some(product)=&mut self.product {product.cancel_with_reports(router);}
        if let Some(type_map)=&mut self.type_map {type_map.cancel_with_reports(router);}
        if let Some(layers)=&mut self.layers {layers.cancel_with_reports(router);}
        if let Some(voids)=&mut self.voids {voids.cancel_with_reports(router);}
        if let Some(opening)=&mut self.opening {opening.cancel_with_reports(router);}
        self.cancel();
        router.drain_mapping_cleanup();
        Ok(())
    }
}
