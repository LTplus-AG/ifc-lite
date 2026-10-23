// SPDX-License-Identifier: MPL-2.0
use super::*;
use crate::program::retained::{RetainedPlacementStage, RetainedPlanOperation};
impl<'a> ProductControl<'a> {
    pub(in crate::program) fn retained(
        element: &'a DecodedEntity,
        selection: RetainedSelection,
    ) -> Self {
        #[cfg(all(target_arch = "wasm32", not(feature = "wasm_source_capture")))]
        {
            let _ = element;
            match selection {}
        }
        #[cfg(any(not(target_arch = "wasm32"), feature = "wasm_source_capture"))]
        {
            let mut control = Self::merged(element, SourceHygiene::IndexOnly);
            control.retained = Some(selection.clone());
            control.body = Body::Sink(Sink::Retained(Vec::new(), selection));
            if matches!(
                element.ifc_type,
                IfcType::IfcAlignment | IfcType::IfcAnnotation
            ) {
                control.action = Action::Complete(Err(crate::Error::geometry(
                    "retained annotation/alignment unsupported",
                )));
            }
            control
        }
    }
    pub(super) fn retained_item(&self, item: DecodedEntity) -> Action {
        let Some(selection) = &self.retained else {
            return Action::Taken;
        };
        #[cfg(all(target_arch = "wasm32", not(feature = "wasm_source_capture")))]
        {
            let _ = item;
            match *selection {}
        }
        #[cfg(any(not(target_arch = "wasm32"), feature = "wasm_source_capture"))]
        {
            let mut control = ItemControl::new((0., 0., 0.));
            control.retained = Some(selection.clone());
            Action::Item {
                item,
                control: Box::new(control),
            }
        }
    }
    pub(in crate::program) fn retained_ready(&self) -> bool {
        matches!(&self.action, Action::Item { control, .. } if control.retained_ready())
    }
    pub(in crate::program) fn admit_retained(
        &mut self,
    ) -> std::result::Result<(ProductReply, RetainedPlanOperation), ProgramError> {
        let Action::Item { control, .. } = &mut self.action else {
            return Err(ProgramError::StaleRequest);
        };
        control
            .admit_retained()
            .map(|(reply, operation)| (ProductReply::Item(reply), operation))
    }
    pub(super) fn accept_retained_item(&mut self, reply: ItemStep, router: &GeometryRouter) {
        let Action::Item { control, .. } = &mut self.action else {
            return;
        };
        control.accept(reply, router);
        let Some(result) = control.take_retained() else {
            return;
        };
        let result = result.and_then(|value| {
            let Body::Sink(Sink::Retained(values, _)) = &mut self.body else {
                return Err(crate::Error::geometry("missing retained accumulator"));
            };
            crate::resource::reserve_headers(values, 1)?.retain();
            values.push(value);
            Ok(())
        });
        self.action = match result {
            Ok(()) => self.advance(),
            Err(error) => Action::Complete(Err(error)),
        };
    }
    pub(super) fn place_retained(&mut self, placement: &ObjectPlacement) -> Result<ProductOutput> {
        let Body::Sink(Sink::Retained(mut values, selection)) =
            std::mem::replace(&mut self.body, Body::Empty)
        else {
            return Err(crate::Error::geometry("missing retained product values"));
        };
        for value in &mut values {
            value.place_in_place(
                &placement.transform,
                selection.program(),
                RetainedPlacementStage::Product {
                    product_id: self.element.id,
                },
            )?;
        }
        Ok(ProductOutput::Retained(values, selection))
    }
}
