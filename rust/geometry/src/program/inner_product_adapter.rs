// SPDX-License-Identifier: MPL-2.0
//! Common linear protocol adapter for the actual product control and children.
use super::inner::{GeometryOutput, GeometryProgram, ProgramError, ProgramReply, ProgramRequest, ProgramStage};
use super::inner_product::{ChildKind, ChildOutput, ProductMachine, ProductMachinePoll,
    ProductReady, ProductReply, ProductSource};
use super::product_control::{ProductConsumer, completion::CompletedProduct};
use super::inner_product_prelude::{PreludeControl, PreludePoll, PreludeAction, PreludeReply, PreludeReadyWork};
use crate::router::processing::SourceHygiene;
use crate::{GeometryRouter, ResolvedTextureMap, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use rustc_hash::FxHashMap;

enum Action { Source(ProductSource), Ready(ProductReady), Prelude(PreludeAction),
    Layer(ProgramRequest), LayerFinished, Child(ProgramRequest), ChildFinished }
struct Child { program: Box<GeometryProgram>, kind: ChildKind }
pub(super) struct ProductAdapterReply(Reply);
enum Reply { Product(ProductReply), Prelude(PreludeReply), ExtractedChild(Box<ProgramReply>),
    StoppedNumerical { tag:u16, error:crate::Error }, Layer(Box<ProgramReply>),
    LayerFinished(Result<Option<crate::SubMeshCollection>>), Child(Box<ProgramReply>), ChildFinished(Result<ChildOutput>), Stopped(crate::Error) }
pub(super) enum ProductReadyWork { Product(ProductReady), Prelude(PreludeReadyWork) }
impl ProductReadyWork {
    pub(super) fn tag(&self)->u16 {match self {Self::Product(ready)=>ready.tag(),Self::Prelude(ready)=>32+ready.tag()}}
    pub(super) fn execute(self)->ProductAdapterReply {
        let tag=self.tag();
        if let Err(stop)=crate::resource::check_current() {
            return ProductAdapterReply(Reply::StoppedNumerical {tag,error:stop.into()});
        }
        ProductAdapterReply(match self {
            Self::Product(ready)=>Reply::Product(ready.execute()),
            Self::Prelude(ready)=>Reply::Prelude(ready.execute()),
        })
    }
}
impl ProductAdapterReply {
    pub(super) fn child_reply_mut(&mut self) -> Option<&mut ProgramReply> {
        match &mut self.0 { Reply::Child(reply) | Reply::ExtractedChild(reply) | Reply::Layer(reply)=>Some(reply), _=>None }
    }

    pub(super) fn wrap_child_reply(reply:ProgramReply)->Self {Self(Reply::ExtractedChild(Box::new(reply)))}
    pub(super) fn tag(&self)->u16 {match &self.0 {
        Reply::Product(reply)=>reply.tag(), Reply::Prelude(reply)=>32+reply.tag(),
        Reply::Layer(_)=>52, Reply::Child(_)=>53, Reply::ChildFinished(_)=>54,
        Reply::LayerFinished(_)=>55, Reply::Stopped(_)=>56, Reply::ExtractedChild(_)=>57,
        Reply::StoppedNumerical {tag,..}=>*tag,
    }}
}

pub(super) struct ProductRootAdapter {
    machine: ProductMachine,
    retained: Option<super::retained::RetainedContract>,
    prelude: Option<PreludeControl>,
    layer: Option<Box<GeometryProgram>>,
    action: Option<Action>,
    child: Option<Child>,
    output: Option<Result<GeometryOutput>>,
}
impl ProductRootAdapter {
    pub(super) fn new(element: DecodedEntity, consumer: ProductConsumer, hygiene: SourceHygiene) -> Self {
        Self::initial(element, consumer, hygiene, true)
    }

    pub(super) fn without_layers(element: DecodedEntity, consumer: ProductConsumer, hygiene: SourceHygiene) -> Self {
        Self::initial(element, consumer, hygiene, false)
    }

    fn initial(element: DecodedEntity, consumer: ProductConsumer, hygiene: SourceHygiene, allow_layers: bool) -> Self {
        let layer = (allow_layers && matches!(consumer, ProductConsumer::Styled { .. }))
            .then(|| Box::new(GeometryProgram::layer_attempt(element.clone(), false)));
        Self { prelude: Some(PreludeControl::new(element.clone(), consumer)), layer,
            machine: ProductMachine::begin(element, consumer, hygiene), retained: None,
            action: None, child: None, output: None }
    }

    pub(super) fn poll(&mut self) -> std::result::Result<Option<ProgramStage>, ProgramError> {
        if self.output.is_some() { return Ok(None) }
        if let Some(action) = &self.action { return Ok(Some(action.stage())) }
        loop {
            if let Some(prelude) = &mut self.prelude {
                match prelude.poll() {
                    PreludePoll::Action(action) => {
                        let stage = action.stage();
                        self.action = Some(Action::Prelude(action));
                        return Ok(Some(stage));
                    }
                    PreludePoll::Continue => self.prelude = None,
                    PreludePoll::Complete(output) => {
                        self.output = Some(output.map(|output| match output {
                            CompletedProduct::Merged(parts) => GeometryOutput::Parts(parts),
                            CompletedProduct::Retained(values) => GeometryOutput::Retained(values),
                            CompletedProduct::Styled(collection) => GeometryOutput::Submeshes(collection),
                        }));
                        return Ok(None);
                    }
                    PreludePoll::Pending => return Err(ProgramError::Outstanding),
                }
            }
            if let Some(layer) = &mut self.layer {
                self.action = Some(match layer.request()? {
                    Some(request) => Action::Layer(request), None => Action::LayerFinished,
                });
                return Ok(self.action.as_ref().map(Action::stage));
            }
            if let Some(child) = &mut self.child {
                self.action = Some(match child.program.request()? {
                    Some(request) => Action::Child(request), None => Action::ChildFinished,
                });
                return Ok(self.action.as_ref().map(Action::stage));
            }
            let action = match self.machine.poll() {
                ProductMachinePoll::Source(source) => Action::Source(source),
                ProductMachinePoll::Ready(ready) => Action::Ready(ready),
                ProductMachinePoll::Child { program, kind } => {
                    self.child = Some(Child { program, kind });
                    continue;
                }
                ProductMachinePoll::Complete(result) => {
                    self.output = Some(result.map(|output| match output {
                        CompletedProduct::Merged(parts) => GeometryOutput::Parts(parts),
                            CompletedProduct::Retained(values) => GeometryOutput::Retained(values),
                        CompletedProduct::Styled(collection) => GeometryOutput::Submeshes(collection),
                    }));
                    return Ok(None);
                }
                ProductMachinePoll::Pending => return Err(ProgramError::Outstanding),
            };
            let stage = action.stage();
            self.action = Some(action);
            return Ok(Some(stage));
        }
    }

    pub(super) fn take_ready(&mut self)->Option<ProductReadyWork> {
        let action=self.action.take()?;
        match action {
            Action::Ready(ready)=>Some(ProductReadyWork::Product(ready)),
            Action::Prelude(action)=>match action.into_ready() {
                Ok(ready)=>Some(ProductReadyWork::Prelude(ready)),
                Err(source)=>{self.action=Some(Action::Prelude(source));None}
            },
            source=>{self.action=Some(source);None}
        }
    }
    pub(super) fn take_child_ready(&mut self)->std::result::Result<Option<super::inner::ReadyOperation>,ProgramError> {
        let Some(Action::Child(request)|Action::Layer(request))=self.action.as_ref() else {return Ok(None)};
        if request.stage()!=ProgramStage::Numerical {return Ok(None)}
        let ready=if matches!(self.action,Some(Action::Layer(_))) {
            self.layer.as_mut().expect("reached layer child").take_ready(*request)?
        } else {self.child.as_mut().expect("reached product child").program.take_ready(*request)?};
        self.action=None;Ok(Some(ready))
    }

    pub(super) fn execute_with_inputs(&mut self, router: &GeometryRouter, decoder: &mut EntityDecoder<'_>,
        textures: Option<&FxHashMap<u32, ResolvedTextureMap>>, voids: Option<&FxHashMap<u32, Vec<u32>>>)
        -> std::result::Result<ProductAdapterReply, ProgramError> {
        if let Some(ready)=self.take_ready() {return Ok(ready.execute())}
        if let Err(stop) = crate::resource::check_current() {
            return Ok(ProductAdapterReply(Reply::Stopped(stop.into())));
        }
        let reply = match self.action.take().expect("requested product action") {
            Action::Source(source) => Reply::Product(ProductReply::Source(match self.retained {
                Some(contract) => source.execute_retained(router, decoder, textures, contract),
                None => source.execute(router, decoder, textures),
            })),
            Action::Ready(_) => unreachable!("product numerical action extracted above"),
            // Dedicated alignment lowering/callbacks are not retained source
            // contracts. Refuse the reached branch before any opaque work;
            // skipping it would silently select ordinary Body fallback.
            Action::Prelude(_) if self.retained.is_some() => return Err(ProgramError::UnsupportedRetained),
            Action::Prelude(action) => Reply::Prelude(action.execute(router, decoder)?),
            Action::Layer(request) => Reply::Layer(Box::new(self.layer.as_mut().expect("layer prelude")
                .execute_with_inputs(request, router, decoder, None, voids)?)),
            Action::LayerFinished => Reply::LayerFinished((*self.layer.take().expect("completed layer prelude")).finish_layer_candidate()),
            Action::Child(request) => Reply::Child(Box::new(self.child.as_mut().expect("reached child")
                .program.execute_with_inputs(request, router, decoder, textures, voids)?)),
            Action::ChildFinished => {
                let child = self.child.take().expect("completed child");
                let result = if self.retained.is_some() {
                    let mut program = *child.program;
                    program.take_geometry_output().and_then(|output| match output {
                        GeometryOutput::Retained(values) => Ok(ChildOutput::Retained(values)),
                        _ => Err(crate::Error::geometry("exact child cannot enter retained product")),
                    })
                } else { match child.kind {
                    ChildKind::Parts => (*child.program).finish_parts().map(ChildOutput::Parts),
                    ChildKind::Styled => (*child.program).finish_submeshes().map(ChildOutput::Styled),
                    ChildKind::Mesh { raw } => (*child.program).finish().map(|mesh| ChildOutput::Mesh(mesh, raw)),
                }};
                Reply::ChildFinished(result)
            }
        };
        Ok(ProductAdapterReply(reply))
    }

    pub(super) fn validate_reply(&self, reply:&ProductAdapterReply, router:&GeometryRouter)
        -> std::result::Result<(),ProgramError> {
        let child=match &reply.0 {
            Reply::Layer(reply)=>Some((self.layer.as_deref().ok_or(ProgramError::WrongPayload)?,reply.as_ref())),
            Reply::Child(reply)=>Some((self.child.as_ref().ok_or(ProgramError::WrongPayload)?.program.as_ref(),reply.as_ref())),
            Reply::ExtractedChild(reply)=>{
                let program=if let Some(layer)=self.layer.as_deref() {layer}
                    else {self.child.as_ref().ok_or(ProgramError::WrongPayload)?.program.as_ref()};
                Some((program,reply.as_ref()))
            }
            _=>None,
        };
        if let Some((program,reply))=child {program.validate_reply(reply,router)?;}
        Ok(())
    }

    pub(super) fn accept(&mut self, reply: ProductAdapterReply, router: &GeometryRouter) {
        match reply.0 {
            Reply::ExtractedChild(reply)=>{
                if let Some(layer)=&mut self.layer {layer.accept(*reply,router).expect("validated extracted layer reply")}
                else {self.child.as_mut().expect("extracted product child").program.accept(*reply,router).expect("validated extracted product reply")}
            }
            Reply::StoppedNumerical {error,..}=>{
                self.cancel_with_reports(router);
                self.output=Some(Err(error));
            }
            Reply::Product(reply) => self.machine.accept(reply, router),
            Reply::Prelude(reply) => self.prelude.as_mut().expect("product prelude").accept(reply),
            Reply::Layer(reply) => self.layer.as_mut().expect("pending layer prelude").accept(*reply, router)
                .expect("validated layer prelude reply"),
            Reply::LayerFinished(result) => match result {
                Ok(Some(collection)) => { self.machine.cancel(); self.output = Some(Ok(GeometryOutput::Submeshes(collection))); }
                Ok(None) => {},
                Err(error) => { self.machine.cancel(); self.output = Some(Err(error)); }
            },
            Reply::Child(reply) => self.child.as_mut().expect("pending child").program.accept(*reply, router)
                .expect("validated product child reply"),
            Reply::ChildFinished(result) => self.machine.accept(ProductReply::Child(result), router),
            Reply::Stopped(error) => {
                self.cancel_with_reports(router);
                self.action = None;
                self.child = None;
                self.machine.cancel();
                self.output = Some(Err(error));
            }
        }
        // Child acceptance has already delivered its own reached reports.
        // A sticky stop now discards every partial product resource.
        if let Err(stop) = crate::resource::check_current() {
            self.cancel_with_reports(router);
            self.action = None;
            self.child = None;
            self.machine.cancel();
            self.output = Some(Err(stop.into()));
        }
    }

    pub(super) fn take_output(&mut self) -> Option<Result<GeometryOutput>> { self.output.take() }
    pub(super) fn cancel(&mut self) {
        if let Some(prelude) = &mut self.prelude { prelude.cancel(); }
        self.prelude = None;
        if let Some(layer) = &mut self.layer { layer.cancel(); }
        self.layer = None;
        self.machine.cancel();
        self.action = None;
        if let Some(child) = &mut self.child { child.program.cancel(); }
        self.child = None;
    }
}
impl Action {
    fn stage(&self) -> ProgramStage {
        match self {
            Self::Ready(_) => ProgramStage::Numerical,
            Self::Prelude(action) => action.stage(),
            Self::Child(request) | Self::Layer(request) => request.stage(),
            Self::Source(_) | Self::ChildFinished | Self::LayerFinished => ProgramStage::Source,
        }
    }
}

impl ProductRootAdapter {
    pub(super) fn cancel_with_reports(&mut self,router:&GeometryRouter) {
        if let Some(layer)=&mut self.layer { layer.cancel_with_reports(router).expect("validated cancellation router"); }
        if let Some(child)=&mut self.child {child.program.cancel_with_reports(router).expect("validated cancellation router");}
        self.cancel();
    }
}

impl ProductRootAdapter {
    pub(super) fn select_retained(&mut self, contract: super::retained::RetainedContract) {
        self.retained = Some(contract);
        self.layer=None; // Layers remain an explicit retained requirement; never run an exact mesh attempt.
        self.machine.retained = Some(contract);
        self.machine.retained_cache = Some(std::sync::Arc::new(std::sync::Mutex::new(super::mapping::RetainedCache::default())));
    }
}
impl ProductReadyWork {
    pub(super) fn is_retained_control(&self) -> bool {
        matches!(self, Self::Product(ProductReady::Merge(_) | ProductReady::Finish(_) | ProductReady::Prepare(_) | ProductReady::Place(_)))
    }
}
