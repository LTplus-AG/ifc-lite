// SPDX-License-Identifier: MPL-2.0
//! Common product root: reached source, real child programs and numerical replies.
mod source;
pub(super) use source::{ProductSource, ProductSourceReply};
use super::annotation::AnnotationFill;
use super::product_control::{ProductChild, ProductConsumer, ProductControl, ProductItemOutput,
    ProductOutput, ProductPoll, ProductResources, ReadyProductFinish, ReadyProductMerge};
use super::product_control::completion::{CompletedProduct, CompletionPoll, Geometry,
    ProductCompletion, ReadyProductJoin, ReadyProductPlace, ReadyProductPrepare};
use super::{GeometryProgram, TextureConstructor};
use crate::processors::texture::TextureAttachment;
use crate::router::processing::SourceHygiene;
use crate::{GeometryRouter, Mesh, Result, SubMeshCollection};
use ifc_lite_core::{DecodedEntity, IfcType};

pub(super) struct ProductMachine {
    element: DecodedEntity,
    consumer: ProductConsumer,
    hygiene: SourceHygiene,
    control: Option<ProductControl>,
    completion: Option<ProductCompletion>,
    child: Option<ProductChild>,
    next: Option<ProductMachinePoll>,
    finished: bool,
}
pub(super) enum ProductMachinePoll {
    Source(ProductSource), Ready(ProductReady), Child { program: Box<GeometryProgram>, kind: ChildKind },
    Complete(Result<CompletedProduct>), Pending,
}
#[derive(Clone, Copy)]
pub(super) enum ChildKind { Parts, Styled, Mesh { raw: bool } }
pub(super) enum ProductReply {
    Source(ProductSourceReply), Merge(Result<ProductResources>), Finish(ProductOutput),
    Annotation(Result<Mesh>), Texture(Result<Option<TexturePart>>),
    Child(Result<ChildOutput>), Prepare(Geometry),
    Place(Geometry), Join(Result<Vec<Mesh>>),
}
pub(super) enum ChildOutput { Parts(Vec<Mesh>), Styled(SubMeshCollection), Mesh(Mesh, bool) }
pub(super) enum ProductReady {
    Merge(ReadyProductMerge), Finish(ReadyProductFinish), Annotation(AnnotationFill), Texture(ReadyTexture),
    Prepare(ReadyProductPrepare), Place(ReadyProductPlace), Join(ReadyProductJoin),
}
pub(super) type TexturePart = (Mesh, Vec<f32>, TextureAttachment);
pub(super) struct ReadyTexture {
    pub plan: TextureConstructor,
    pub coordinates: Vec<[f32; 2]>,
    pub indices: Option<Vec<[u32; 3]>>,
    pub attachment: TextureAttachment,
    pub scale: f64,
    pub offset: Option<(f64, f64, f64)>,
}
impl ProductReady {
    pub(super) fn tag(&self) -> u16 {
        match self { Self::Merge(_)=>10, Self::Finish(_)=>11, Self::Annotation(_)=>12,
            Self::Texture(_)=>13, Self::Prepare(_)=>15, Self::Place(_)=>16, Self::Join(_)=>17 }
    }
    pub(super) fn execute(self) -> ProductReply {
        match self {
            Self::Merge(ready) => ProductReply::Merge(ready.execute()),
            Self::Finish(ready) => ProductReply::Finish(ready.execute()),
            Self::Annotation(ready) => ProductReply::Annotation(ready.evaluate()),
            Self::Texture(ready) => ProductReply::Texture(ready.execute()),
            Self::Prepare(ready) => ProductReply::Prepare(ready.execute()),
            Self::Place(ready) => ProductReply::Place(ready.execute()),
            Self::Join(ready) => ProductReply::Join(ready.execute()),
        }
    }
}
impl ProductReply {
    pub(super) fn tag(&self) -> u16 {
        match self { Self::Source(source)=>source.tag(), Self::Merge(_)=>10, Self::Finish(_)=>11,
            Self::Annotation(_)=>12, Self::Texture(_)=>13, Self::Child(_)=>14, Self::Prepare(_)=>15,
            Self::Place(_)=>16, Self::Join(_)=>17 }
    }
}

impl ReadyTexture {
    pub(super) fn execute(self) -> Result<Option<TexturePart>> {
        crate::resource::check_current()?;
        let (mut mesh, uvs) = self.plan.evaluate_coordinates(&self.coordinates, self.indices);
        crate::resource::check_current()?;
        if mesh.is_empty() { return Ok(None) }
        if self.scale != 1. {
            let scale = self.scale as f32;
            for coordinate in &mut mesh.positions { *coordinate *= scale; }
        }
        if let Some(offset) = self.offset {
            crate::router::processing::publish_object_frame_bounds(&mut mesh, offset);
        }
        Ok(Some((mesh, uvs, self.attachment)))
    }
}
impl ProductMachine {
    pub(super) fn begin(element: DecodedEntity, consumer: ProductConsumer, hygiene: SourceHygiene) -> Self {
        let source = ProductSource::Begin { element: element.clone(), consumer };
        Self { element, consumer, hygiene, control: None, completion: None, child: None,
            next: Some(ProductMachinePoll::Source(source)), finished: false }
    }

    pub(super) fn poll(&mut self) -> ProductMachinePoll {
        if let Some(next) = self.next.take() { return next }
        if self.finished { return ProductMachinePoll::Pending }
        if let Some(completion) = &mut self.completion {
            return match completion.poll() {
                CompletionPoll::Prepare(ready) => ProductMachinePoll::Ready(ProductReady::Prepare(ready)),
                CompletionPoll::Source(source) => ProductMachinePoll::Source(ProductSource::Placement(source)),
                CompletionPoll::Place(ready) => ProductMachinePoll::Ready(ProductReady::Place(ready)),
                CompletionPoll::Join(ready) => ProductMachinePoll::Ready(ProductReady::Join(ready)),
                CompletionPoll::Complete(output) => {
                    self.finished = true;
                    ProductMachinePoll::Complete(Ok(output))
                }
                CompletionPoll::Pending => ProductMachinePoll::Pending,
            };
        }
        let Some(control) = &mut self.control else { return ProductMachinePoll::Pending };
        match control.poll() {
            ProductPoll::Source(source) => ProductMachinePoll::Source(ProductSource::Items(source)),
            ProductPoll::Child(child) => {
                let source = if child.element.ifc_type == IfcType::IfcAnnotation
                    && child.item.ifc_type == IfcType::IfcAnnotationFillArea {
                    ProductSource::Annotation { item: child.item.clone() }
                } else if child.fill_only {
                    self.child = Some(child);
                    let output = self.empty_child();
                    return self.queue_merge(output);
                } else {
                    ProductSource::Texture { element: child.element.clone(), item: child.item.clone(),
                        enabled: matches!(child.consumer, ProductConsumer::Styled { .. }) }
                };
                self.child = Some(child);
                ProductMachinePoll::Source(source)
            }
            ProductPoll::Finish(ready) => ProductMachinePoll::Ready(ProductReady::Finish(ready)),
            ProductPoll::Pending => ProductMachinePoll::Pending,
        }
    }

    fn empty_child(&self) -> ProductItemOutput {
        match self.consumer {
            ProductConsumer::Merged => ProductItemOutput::Merged(Vec::new()),
            ProductConsumer::Styled { .. } => ProductItemOutput::Styled(SubMeshCollection::new()),
        }
    }
    fn queue_merge(&mut self, output: ProductItemOutput) -> ProductMachinePoll {
        match self.control.as_mut().expect("product traversal").merge(output) {
            Ok(ready) => ProductMachinePoll::Ready(ProductReady::Merge(ready)),
            Err(error) => self.fail(error),
        }
    }
    fn fail(&mut self, error: crate::Error) -> ProductMachinePoll {
        self.finished = true;
        self.control = None;
        self.completion = None;
        self.child = None;
        ProductMachinePoll::Complete(Err(error))
    }
    pub(super) fn cancel(&mut self) {
        self.finished = true;
        self.control = None;
        self.completion = None;
        self.child = None;
        self.next = None;
    }
    fn raw_source(&self) -> ProductSource {
        let child = self.child.as_ref().expect("reached item");
        ProductSource::Raw { element: child.element.clone(), item: child.item.clone(), consumer: child.consumer }
    }
    fn mesh_output(&self, mesh: Mesh, filter_empty: bool) -> ProductItemOutput {
        match self.consumer {
            ProductConsumer::Merged => ProductItemOutput::Merged(vec![mesh]),
            ProductConsumer::Styled { .. } => {
                let mut collection = SubMeshCollection::new();
                if !filter_empty || !mesh.is_empty() {
                    collection.add(self.child.as_ref().expect("reached item").item.id, mesh);
                }
                ProductItemOutput::Styled(collection)
            }
        }
    }

    /// Called only after the enclosing common program authenticates identity,
    /// stage, owner and emitter. All reached effects remain behind that gate.
    pub(super) fn accept(&mut self, reply: ProductReply, router: &GeometryRouter) {
        let result = (|| {
            crate::resource::check_current()?;
            self.accept_inner(reply, router)?;
            crate::resource::check_current()?;
            Ok(())
        })();
        if let Err(error) = result { self.next = Some(self.fail(error)); }
    }
    fn accept_inner(&mut self, reply: ProductReply, router: &GeometryRouter) -> Result<()> {
        match reply {
            ProductReply::Source(source) => match source {
                ProductSourceReply::Begin(program) => match program? {
                    Some(program) => self.control = Some(ProductControl::new(program, self.element.clone(), self.consumer)),
                    None => {
                        self.finished = true;
                        self.next = Some(ProductMachinePoll::Complete(Ok(match self.consumer {
                            ProductConsumer::Merged => CompletedProduct::Merged(vec![Mesh::new()]),
                            ProductConsumer::Styled { .. } => CompletedProduct::Styled(SubMeshCollection::new()),
                        })));
                    }
                },
                ProductSourceReply::Items(reply) => self.control.as_mut().expect("traversal").accept_source(reply)?,
                ProductSourceReply::Annotation(reply) => match reply {
                    Ok(ready) => self.next = Some(ProductMachinePoll::Ready(ProductReady::Annotation(ready))),
                    Err(error) => { router.record_unsupported_item(IfcType::IfcAnnotationFillArea); return Err(error) }
                },
                ProductSourceReply::Texture(reply) => match reply? {
                    Some(ready) => self.next = Some(ProductMachinePoll::Ready(ProductReady::Texture(ready))),
                    None => self.next = Some(ProductMachinePoll::Source(self.raw_source())),
                },
                ProductSourceReply::Child(reply) => {
                    let (program, kind) = reply?;
                    self.next = Some(ProductMachinePoll::Child { program: Box::new(program), kind });
                }
                ProductSourceReply::Hygiene(hygiene, output) => {
                    self.completion = Some(ProductCompletion::new(self.element.clone(), output, hygiene));
                }
                ProductSourceReply::Placement(reply) => self.completion.as_mut().expect("completion").accept_source(reply?),
            },
            ProductReply::Merge(reply) => {
                self.control.as_mut().expect("traversal").accept_merge(reply?);
                self.child = None;
            }
            ProductReply::Finish(output) => {
                self.control = None;
                self.next = Some(ProductMachinePoll::Source(ProductSource::Hygiene { requested: self.hygiene, output }));
            }
            ProductReply::Annotation(reply) => match reply {
                Ok(mesh) => { let output = self.mesh_output(mesh, false); self.next = Some(self.queue_merge(output)); }
                Err(error) => { router.record_unsupported_item(IfcType::IfcAnnotationFillArea); return Err(error) }
            },
            ProductReply::Texture(reply) => match reply? {
                Some((mesh, uvs, texture)) => {
                    let mut collection = SubMeshCollection::new();
                    collection.add_textured(self.child.as_ref().expect("texture item").item.id, mesh, uvs, texture);
                    self.next = Some(self.queue_merge(ProductItemOutput::Styled(collection)));
                }
                None => self.next = Some(ProductMachinePoll::Source(self.raw_source())),
            },
            ProductReply::Child(reply) => {
                let output = match reply? {
                    ChildOutput::Parts(parts) => ProductItemOutput::Merged(parts),
                    ChildOutput::Styled(collection) => ProductItemOutput::Styled(collection),
                    ChildOutput::Mesh(mesh, raw) => self.mesh_output(mesh, raw),
                };
                self.next = Some(self.queue_merge(output));
            }
            ProductReply::Prepare(geometry) => self.completion.as_mut().expect("completion").accept_prepare(geometry),
            ProductReply::Place(geometry) => self.completion.as_mut().expect("completion").accept_place(geometry),
            ProductReply::Join(reply) => self.completion.as_mut().expect("completion").accept_join(reply?),
        }
        Ok(())
    }
}
