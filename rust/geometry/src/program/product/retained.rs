// SPDX-License-Identifier: MPL-2.0
use super::*;
#[cfg(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"))]
use crate::program::retained::failure::{FailureSite, OriginCause, StructuralReason};
use crate::program::inner::retained_program::RetainedProgramError;
use crate::program::retained::{RetainedPlacementStage, RetainedPlanOperation};
impl<'a> ProductControl<'a> {
    pub(in crate::program) fn select_retained_styled(&mut self, allow_instancing: bool, textures: Textures<'a>) {
        self.styled = Some(Styled { allow_instancing, textures });
    }
    pub(in crate::program) fn retained_selection(&self) -> Option<&RetainedSelection> { self.retained.as_ref() }
    pub(in crate::program) fn retained(
        element: &'a DecodedEntity,
        selection: RetainedSelection,
    ) -> Self {
        #[cfg(not(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime")))]
        {
            let _ = element;
            match selection {}
        }
        #[cfg(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"))]
        {
            let mut control = Self::merged(element, SourceHygiene::IndexOnly);
            control.retained = Some(selection.clone());
            control.body = Body::Sink(Sink::Retained(Vec::new(), selection.clone()));
            if !element.ifc_type.is_subtype_of(IfcType::IfcProduct) {
                selection.failure_handle().record(FailureSite::ProductRoot, Some(element.id),
                    OriginCause::Structure(StructuralReason::NotProduct));
                control.action = Action::Complete(Err(crate::Error::geometry(
                    "retained product_parts requires an IfcProduct root",
                )));
            } else if matches!(
                element.ifc_type,
                IfcType::IfcAlignment | IfcType::IfcAnnotation
            ) {
                selection.failure_handle().record(FailureSite::ProductRoot, Some(element.id),
                    OriginCause::Structure(StructuralReason::UnsupportedProduct));
                control.action = Action::Complete(Err(crate::Error::geometry(
                    "retained annotation/alignment unsupported",
                )));
            }
            control
        }
    }
    pub(super) fn retained_item(&mut self, item: DecodedEntity) -> Action {
        let Some(selection) = &self.retained else {
            return Action::Taken;
        };
        #[cfg(not(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime")))]
        {
            let _ = item;
            match *selection {}
        }
        #[cfg(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"))]
        {
            if item.ifc_type == IfcType::IfcMappedItem {
                let mut control = MappingControl::retained_occurrence(
                    super::super::mapping::Reached::Nested(item), selection.clone());
                if let Some(styled) = self.styled {
                    control.select_retained_styled(styled.allow_instancing, styled.textures);
                }
                self.child = Child::Mapping(Box::new(control));
                return Action::Mapping { role: Role::Parts };
            }
            let mut control = ItemControl::new((0., 0., 0.));
            control.retained = Some(selection.clone());
            Action::Item {
                item,
                control: Box::new(control),
            }
        }
    }
    pub(in crate::program) fn retained_ready(&self) -> bool {
        if !crate::program::retained::ENABLED { return false; }
        match (&self.action, &self.child) {
            (Action::Item { control, .. }, _) => control.retained_ready(),
            (Action::Mapping { .. }, Child::Mapping(control)) => control.retained_ready(),
            _ => false,
        }
    }
    pub(in crate::program) fn admit_retained(
        &mut self,
    ) -> std::result::Result<(ProductReply, Vec<RetainedPlanOperation>), RetainedProgramError> {
        if let (Action::Mapping { .. }, Child::Mapping(control)) = (&self.action, &mut self.child) {
            return control.admit_retained().map(|(reply, operation)| (ProductReply::Mapping(reply), operation));
        }
        let Action::Item { control, .. } = &mut self.action else {
            return Err(RetainedProgramError::StaleRequest);
        };
        control
            .admit_retained()
            .map(|(reply, operation)| (ProductReply::Item(reply), operation))
    }
    pub(super) fn accept_retained_item(&mut self, reply: ItemStep, router: &GeometryRouter) {
        let Action::Item { item, control } = &mut self.action else {
            return;
        };
        let id = item.id;
        control.accept(reply, router);
        let Some(result) = control.take_retained() else {
            return;
        };
        let result = result.and_then(|mut value| {
            if let Some(styled) = self.styled {
                value.present(crate::program::retained::RetainedPresentation::item(id, router,
                    styled.textures.and_then(|textures| textures.get(&id)))?)?;
            }
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
    pub(super) fn accept_retained_mapping(&mut self, values: Vec<LogicalRetainedValue>) -> Action {
        let result = (|| {
            let Body::Sink(Sink::Retained(output, _)) = &mut self.body else {
                return Err(crate::Error::geometry("missing retained product accumulator"));
            };
            crate::resource::reserve_headers(output, values.len())?.retain();
            output.extend(values);
            Ok(())
        })();
        match result { Ok(()) => self.advance(), Err(error) => Action::Complete(Err(error)) }
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
            ).map_err(|error| error.into_common(&selection.failure_handle(),
                crate::program::retained::failure::FailureSite::ProductPlacement,
                Some(self.element.id)))?;
        }
        Ok(ProductOutput::Retained(values, selection))
    }
}
