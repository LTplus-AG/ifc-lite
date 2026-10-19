// SPDX-License-Identifier: MPL-2.0
//! Parent-driven product items and decoder-free accumulation packets.
pub(crate) mod completion;
use super::resources::{MergedParts, MergedResources};
use super::traversal::{RepresentationItemsRequest, TraversalPoll};
use super::{ItemProgram, ProductProgram};
use crate::{Error, Mesh, Result, SubMeshCollection};
use ifc_lite_core::DecodedEntity;

#[derive(Clone, Copy)]
pub(crate) enum ProductConsumer { Merged, Styled { allow_instancing: bool } }

pub(crate) struct ProductChild {
    pub(crate) element: DecodedEntity,
    pub(crate) item: DecodedEntity,
    pub(crate) fill_only: bool,
    pub(crate) consumer: ProductConsumer,
}

pub(crate) enum ProductPoll {
    Source(RepresentationItemsRequest),
    Child(ProductChild),
    Finish(ReadyProductFinish),
    Pending,
}

pub(crate) enum ProductOutput {
    Retained(Vec<super::retained::LogicalRetainedValue>),
    Merged(MergedParts),
    Styled(SubMeshCollection),
}

pub(crate) enum ProductItemOutput { Merged(Vec<Mesh>), Styled(SubMeshCollection) }
pub(crate) enum ProductResources { Merged(MergedResources), Styled(SubMeshCollection) }
enum State { Traversal, Child, Merge, Finish }

pub(crate) struct ProductControl {
    traversal: ProductProgram,
    element: DecodedEntity,
    consumer: ProductConsumer,
    resources: Option<ProductResources>,
    state: State,
    retained: Option<Vec<super::retained::LogicalRetainedValue>>,
}
impl ProductControl {
    pub(crate) fn new(traversal: ProductProgram, element: DecodedEntity,
        consumer: ProductConsumer) -> Self {
        let resources = match consumer {
            ProductConsumer::Merged => ProductResources::Merged(MergedResources::default()),
            ProductConsumer::Styled { .. } => ProductResources::Styled(SubMeshCollection::new()),
        };
        Self { traversal, element, consumer, resources: Some(resources), state: State::Traversal, retained: None }
    }

    pub(crate) fn poll(&mut self) -> ProductPoll {
        if !matches!(self.state, State::Traversal) {
            return ProductPoll::Pending;
        }
        match self.traversal.poll() {
            TraversalPoll::Items(source) => ProductPoll::Source(source),
            TraversalPoll::Item(reached) => {
                self.state = State::Child;
                ProductPoll::Child(ProductChild { element: self.element.clone(), item: reached.item,
                    fill_only: reached.fill_only, consumer: self.consumer })
            }
            TraversalPoll::Pending => ProductPoll::Pending,
            TraversalPoll::Complete => {
                self.state = State::Finish;
                ProductPoll::Finish(ReadyProductFinish { resources: self.resources.take().expect("owned product resources"), retained: self.retained.take() })
            }
        }
    }

    pub(crate) fn accept_source(&mut self, reply: Result<ItemProgram>) -> Result<()> {
        self.traversal.accept_items(reply)
    }

    pub(crate) fn merge(&mut self, output: ProductItemOutput) -> Result<ReadyProductMerge> {
        if !matches!(self.state, State::Child) {
            return Err(Error::geometry("No product child is awaiting assembly"));
        }
        self.state = State::Merge;
        Ok(ReadyProductMerge { resources: self.resources.take().expect("owned product resources"), output })
    }

    pub(crate) fn accept_merge(&mut self, resources: ProductResources) {
        self.resources = Some(resources);
        self.state = State::Traversal;
    }

}

/// Only meshes/collections survive into numerical work, never the traversal.
pub(crate) struct ReadyProductMerge {
    resources: ProductResources,
    output: ProductItemOutput,
}
impl ReadyProductMerge {
    pub(crate) fn execute(mut self) -> Result<ProductResources> {
        match (&mut self.resources, self.output) {
            (ProductResources::Merged(resources), ProductItemOutput::Merged(parts)) => {
                for mesh in parts { resources.merge(mesh, crate::router::transforms::instancing_enabled()); }
            }
            (ProductResources::Styled(collection), ProductItemOutput::Styled(mut child)) => {
                crate::resource::reserve_headers(&mut collection.sub_meshes, child.sub_meshes.len())?.retain();
                collection.sub_meshes.append(&mut child.sub_meshes);
            }
            _ => return Err(Error::geometry("Product child consumer does not match its destination")),
        }
        Ok(self.resources)
    }
}

pub(crate) struct ReadyProductFinish { resources: ProductResources, retained: Option<Vec<super::retained::LogicalRetainedValue>> }
impl ReadyProductFinish {
    pub(crate) fn execute(self) -> ProductOutput {
        if let Some(values) = self.retained { return ProductOutput::Retained(values) }
        match self.resources {
            ProductResources::Merged(resources) => ProductOutput::Merged(
                resources.finish(crate::router::transforms::instancing_enabled())),
            ProductResources::Styled(collection) => ProductOutput::Styled(collection),
        }
    }
}

impl ProductControl {
    pub(super) fn select_retained(&mut self) { self.retained = Some(Vec::new()); }
    pub(super) fn accept_retained(&mut self, values: Vec<super::retained::LogicalRetainedValue>) -> Result<()> {
        if !matches!(self.state, State::Child) { return Err(Error::geometry("retained child stage mismatch")) }
        let output = self.retained.as_mut().ok_or_else(|| Error::geometry("exact product rejects retained child"))?;
        crate::resource::reserve_headers(output, values.len())?.retain();
        output.extend(values);
        self.state = State::Traversal;
        Ok(())
    }
}
