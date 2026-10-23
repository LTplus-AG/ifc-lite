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
        let id = next_program_id();
        let selection = RetainedSelection::new(contract, id);
        let cancelled = selection.is_none();
        let control = match selection {
            Some(selection) => ProductControl::retained(element, selection),
            None => {
                ProductControl::merged(element, crate::router::processing::SourceHygiene::IndexOnly)
            }
        };
        let mut inner = GeometryProgram::with_control(Control::Product(control));
        inner.id = id;
        Self { inner, cancelled }
    }
    fn check(&self) -> std::result::Result<(), RetainedProgramError> {
        crate::resource::check_current().map_err(RetainedProgramError::Stopped)?;
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
        let retained = matches!(&self.inner.control, Control::Product(c) if c.retained_ready());
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
        let Control::Product(control) = &mut self.inner.control else {
            return Err(RetainedProgramError::WrongPayload);
        };
        let (reply, operation) = control.admit_retained()?;
        operations.push(operation);
        let value = ReplyValue::Product(reply);
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
