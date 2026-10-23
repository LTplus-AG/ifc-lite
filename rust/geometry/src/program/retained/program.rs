// SPDX-License-Identifier: MPL-2.0
//! Public opt-in facade over the same borrowed geometry program.
use super::*;
use crate::program::retained::*;

pub struct RetainedProgram<'a> {
    inner: GeometryProgram<'a>,
    cancelled: bool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetainedTicket(ProgramRequest);
pub struct RetainedReply(ProgramReply);
pub struct RejectedRetainedReply {
    pub error: RetainedProgramError,
    pub reply: RetainedReply,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum RetainedProgramError {
    Stopped(crate::resource::ProgramStop),
    Unsupported,
    WrongPayload,
    WrongOwner,
    Outstanding,
    StaleRequest,
    AlreadyExecuted,
    NotExecuted,
    Cancelled,
}
impl From<ProgramError> for RetainedProgramError {
    fn from(error: ProgramError) -> Self {
        match error {
            ProgramError::UnsupportedRetained => Self::Unsupported,
            ProgramError::TraversalStopped(stop) => Self::Stopped(stop),
            ProgramError::WrongPayload => Self::WrongPayload,
            ProgramError::WrongOwner => Self::WrongOwner,
            ProgramError::Outstanding => Self::Outstanding,
            ProgramError::StaleRequest => Self::StaleRequest,
            ProgramError::AlreadyExecuted => Self::AlreadyExecuted,
            ProgramError::NotExecuted => Self::NotExecuted,
        }
    }
}
impl<'a> RetainedProgram<'a> {
    pub fn product_parts(element: &'a DecodedEntity, contract: RetainedContract) -> Self {
        RetainedTraversal::new(contract).product_parts(element)
    }
    pub fn product_submeshes(element: &'a DecodedEntity, allow_instancing: bool,
        textures: Option<&'a rustc_hash::FxHashMap<u32, crate::ResolvedTextureMap>>, contract: RetainedContract) -> Self {
        RetainedTraversal::new(contract).product_submeshes(element,allow_instancing,textures)
    }
    pub fn type_map(rep_map: DecodedEntity,
        textures: Option<&'a rustc_hash::FxHashMap<u32, crate::ResolvedTextureMap>>, contract: RetainedContract) -> Self {
        RetainedTraversal::new(contract).type_map(rep_map,textures)
    }
    fn selection(&self) -> Option<&RetainedSelection> {
        match &self.inner.control {
            Control::Product(control) => control.retained_selection(),
            Control::Mapping(control) => control.retained_selection(),
            _ => None,
        }
    }
    fn check(&self) -> std::result::Result<(), RetainedProgramError> {
        crate::resource::check_current().map_err(RetainedProgramError::Stopped)?;
        if let Some(selection) = self.selection() {
            selection.check().map_err(RetainedProgramError::Stopped)?;
        }
        if self.cancelled {
            return Err(RetainedProgramError::Cancelled);
        }
        Ok(())
    }
    pub fn request(&mut self) -> std::result::Result<Option<RetainedTicket>, RetainedProgramError> {
        self.check()?;
        self.inner
            .request()
            .map(|r| r.map(RetainedTicket))
            .map_err(Into::into)
    }
    pub fn admit(
        &mut self,
        ticket: RetainedTicket,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder,
    ) -> std::result::Result<(RetainedReply, Vec<RetainedPlanOperation>), RetainedProgramError>
    {
        self.check()?;
        self.inner.validate_owner(router, Some(decoder))?;
        match self.inner.pending {
            Some((request, false)) if request == ticket.0 => {}
            Some((request, true)) if request == ticket.0 => return Err(RetainedProgramError::AlreadyExecuted),
            _ => return Err(RetainedProgramError::StaleRequest),
        }
        if let Some(selection) = self.selection() {
            selection.validate_owner(decoder,router).map_err(|error| match error {
                Error::ProgramStopped(stop) => RetainedProgramError::Stopped(stop),
                _ => RetainedProgramError::WrongOwner,
            })?;
            selection.charge().map_err(RetainedProgramError::Stopped)?;
        }
        let retained = match &self.inner.control {
            Control::Product(control) => control.retained_ready(),
            Control::Mapping(control) => control.retained_ready(),
            _ => false,
        };
        if !retained {
            let reply = self.inner.execute(ticket.0, router, decoder)?;
            self.check()?;
            return Ok((RetainedReply(reply), Vec::new()));
        }
        self.inner.validate_owner(router, Some(decoder))?;
        match self.inner.pending {
            Some((request, false)) if request == ticket.0 => {}
            Some((request, true)) if request == ticket.0 => {
                return Err(RetainedProgramError::AlreadyExecuted)
            }
            _ => return Err(RetainedProgramError::StaleRequest),
        }
        let mut operations = Vec::new();
        crate::resource::reserve_headers(&mut operations, 1)
            .map_err(RetainedProgramError::Stopped)?
            .retain();
        let (value, operation) = match &mut self.inner.control {
            Control::Product(control) => {
                let (reply, operation) = control.admit_retained()?;
                (ReplyValue::Product(reply), operation)
            }
            Control::Mapping(control) => {
                let (reply, operation) = control.admit_retained()?;
                (ReplyValue::Mapping(reply), operation)
            }
            _ => return Err(RetainedProgramError::WrongPayload),
        };
        operations.push(operation);
        self.inner.pending = Some((ticket.0, true));
        self.inner.expected_payload = Some(value.tag());
        self.check()?;
        Ok((
            RetainedReply(ProgramReply {
                request: ticket.0,
                value,
            }),
            operations,
        ))
    }
    pub fn validate_ticket(
        &self,
        ticket: RetainedTicket,
    ) -> std::result::Result<(), RetainedProgramError> {
        self.check()?;
        if self
            .inner
            .pending
            .is_none_or(|(pending, _)| pending != ticket.0)
        {
            return Err(RetainedProgramError::StaleRequest);
        }
        Ok(())
    }
    pub fn validate_reply(
        &self,
        reply: &RetainedReply,
        router: &GeometryRouter,
    ) -> std::result::Result<(), RetainedProgramError> {
        self.check()?;
        self.inner
            .validate_reply(&reply.0, router)
            .map_err(Into::into)
    }
    pub fn accept(
        &mut self,
        reply: RetainedReply,
        router: &GeometryRouter,
    ) -> std::result::Result<(), Box<RejectedRetainedReply>> {
        if let Err(error) = self.validate_reply(&reply, router) {
            return Err(Box::new(RejectedRetainedReply { error, reply }));
        }
        self.inner.accept(reply.0, router).map_err(|r| {
            Box::new(RejectedRetainedReply {
                error: r.error.into(),
                reply: RetainedReply(r.reply),
            })
        })
    }
    pub fn cancel(&mut self) {
        self.cancelled = true;
    }
    pub fn finish_type_map(self, type_product: u32, class: u8, color: [f32; 4]) -> Result<RetainedProductPlan> {
        self.check().map_err(|error| match error {
            RetainedProgramError::Stopped(stop) => Error::ProgramStopped(stop),
            other => Error::geometry(format!("{other:?}")),
        })?;
        let map = match &self.inner.control {
            Control::Mapping(control) => control.representation_map_id(),
            _ => None,
        }.ok_or_else(|| Error::geometry("retained type-map root missing"))?;
        if color.iter().any(|component| !component.is_finite()) {
            return Err(Error::geometry("retained type colour must be finite"));
        }
        match self.inner.finish_output()? {
            Output::Mapping(crate::program::mapping::MappingOutput::Retained(mut values)) => {
                for value in &mut values {
                    let mut binding = RetainedPresentation::occurrence(type_product,map,None,true);
                    binding.type_product = Some((type_product,class));
                    binding.fallback_color = Some(color);
                    value.present(binding)?;
                }
                Ok(RetainedProductPlan {
                    values,
                    remaining: vec![RetainedRequirement::ProductPlacement,
                        RetainedRequirement::OpeningClosure, RetainedRequirement::MaterialLayers,
                        RetainedRequirement::IfcAppearance, RetainedRequirement::PersistentFaces],
                })
            }
            _ => Err(Error::geometry("retained type-map incomplete")),
        }
    }
    pub fn finish(self) -> Result<RetainedProductPlan> {
        self.check().map_err(|e| match e {
            RetainedProgramError::Stopped(stop) => Error::ProgramStopped(stop),
            other => Error::geometry(format!("{other:?}")),
        })?;
        match self.inner.finish_output()? {
            Output::Product(ProductOutput::Retained(values, selection))
                if values.iter().all(|v| v.is_product_placed()) =>
            {
                let _ = selection.program();
                Ok(RetainedProductPlan {
                    values,
                    // Construction and placement do not inspect or discharge
                    // relationships, appearance, or persistent face identity.
                    remaining: vec![
                        RetainedRequirement::OpeningClosure,
                        RetainedRequirement::MaterialLayers,
                        RetainedRequirement::IfcAppearance,
                        RetainedRequirement::PersistentFaces,
                    ],
                })
            }
            _ => Err(Error::geometry("retained product incomplete")),
        }
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

/// One source/configuration domain and finite work allowance across all roots
/// of a product traversal. Clones share bounds and execution-owner checks;
/// completed definitions and presentation bindings are cached within each root.
/// This owns no numerical receipt or source decoder and grants no SDK authority.
#[derive(Clone)]
pub struct RetainedTraversal { selection: Option<RetainedSelection> }
impl RetainedTraversal {
    pub fn new(contract: RetainedContract) -> Self {
        Self { selection: RetainedSelection::new(contract,next_program_id()) }
    }
    pub fn product_parts<'a>(&self, element: &'a DecodedEntity) -> RetainedProgram<'a> {
        let id = next_program_id();
        let selection = self.selection.as_ref().map(RetainedSelection::for_root);
        let cancelled = selection.is_none();
        let control = match selection {
            Some(selection) => ProductControl::retained(element, selection),
            None => {
                ProductControl::merged(element, crate::router::processing::SourceHygiene::IndexOnly)
            }
        };
        let mut inner = GeometryProgram::with_control(Control::Product(control));
        inner.id = id;
        RetainedProgram { inner, cancelled }
    }
    pub fn product_submeshes<'a>(&self, element: &'a DecodedEntity, allow_instancing: bool,
        textures: Option<&'a rustc_hash::FxHashMap<u32, crate::ResolvedTextureMap>>) -> RetainedProgram<'a> {
        let mut program = self.product_parts(element);
        if let Control::Product(control) = &mut program.inner.control {
            control.select_retained_styled(allow_instancing, textures);
        }
        program
    }
    pub fn type_map<'a>(&self, rep_map: DecodedEntity,
        textures: Option<&'a rustc_hash::FxHashMap<u32, crate::ResolvedTextureMap>>) -> RetainedProgram<'a> {
        let id = next_program_id();
        let selection = self.selection.as_ref().map(RetainedSelection::for_root);
        let cancelled = selection.is_none();
        let control = match selection {
            Some(selection) => crate::program::mapping::MappingControl::retained_type_map(rep_map,textures,selection),
            None => {
                // Default wasm has no retained selection. Keep this root inert
                // without borrowing a temporary or constructing numerical authority.
                crate::program::mapping::MappingControl::occurrence(
                    crate::program::mapping::Reached::Nested(rep_map))
            }
        };
        let mut inner = GeometryProgram::with_control(Control::Mapping(control));
        inner.id = id;
        RetainedProgram { inner,cancelled }
    }
 }
