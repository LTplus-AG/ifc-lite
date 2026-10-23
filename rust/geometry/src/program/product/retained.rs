// SPDX-License-Identifier: MPL-2.0
use super::*;
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
            if !element.ifc_type.is_subtype_of(IfcType::IfcProduct) {
                control.action = Action::Complete(Err(crate::Error::geometry(
                    "retained product_parts requires an IfcProduct root",
                )));
            } else if matches!(
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
    pub(super) fn retained_item(&mut self, item: DecodedEntity) -> Action {
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
        match (&self.action, &self.child) {
            (Action::Item { control, .. }, _) => control.retained_ready(),
            (Action::Mapping { .. }, Child::Mapping(control)) => control.retained_ready(),
            _ => false,
        }
    }
    pub(in crate::program) fn admit_retained(
        &mut self,
    ) -> std::result::Result<(ProductReply, Vec<RetainedPlanOperation>), ProgramError> {
        if let (Action::Mapping { .. }, Child::Mapping(control)) = (&self.action, &mut self.child) {
            return control.admit_retained().map(|(reply, operation)| (ProductReply::Mapping(reply), operation));
        }
        let Action::Item { control, .. } = &mut self.action else {
            return Err(ProgramError::StaleRequest);
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
                value.present(crate::program::RetainedPresentation::item(id, router,
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
            )?;
        }
        Ok(ProductOutput::Retained(values, selection))
    }
}
