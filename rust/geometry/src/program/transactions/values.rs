// SPDX-License-Identifier: MPL-2.0
//! Read-only logical identities. No mutable controller fields cross this seam.
use super::logical;
use crate::document::RetainedRecipe;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Definition(logical::LogicalRetainedDefinition);
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Slot(logical::LogicalRetainedSlot);
#[derive(Debug)]
pub struct Value(logical::LogicalRetainedValue);
#[derive(Clone, Copy)]
pub struct ValueRef<'a>(&'a logical::LogicalRetainedValue);
impl Value {
    pub fn as_ref(&self) -> ValueRef<'_> { ValueRef(&self.0) }
}
impl<'a> ValueRef<'a> {
    /// Source binding facts for diagnostics, not complete appearance authority.
    pub fn bindings(self) -> impl Iterator<Item = (u32, u32, Option<(u32, u8)>)> + 'a {
        self.0.presentation().iter().map(|p| (p.geometry_id, p.style_source_id, p.type_product))
    }
    pub fn definition(self) -> Definition { Definition(self.0.definition().clone()) }
    pub fn slot(self) -> Slot { Slot(self.0.slot()) }
    pub fn evaluated_empty(self) -> Option<bool> { self.0.evaluated_empty() }
    pub fn object_frame(self) -> &'a [f64; 16] { self.0.object_frame() }
    pub fn world_from_source(self) -> Option<&'a [f64; 16]> { self.0.world_from_source() }
    pub fn source_from_evaluation(self) -> &'a [f64; 16] { self.0.source_from_evaluation() }
    pub fn evaluation_from_source(self) -> &'a [f64; 16] { self.0.evaluation_from_source() }
}
pub struct Operation(pub(super) logical::RetainedPlanOperation);
pub enum OperationKind<'a> {
    Construction(&'a RetainedRecipe),
    Affine { input: ValueRef<'a>, matrix: &'a [f64; 16] },
    Boolean { inputs: [ValueRef<'a>; 2], operation: crate::BoolOp },
}
impl Operation {
    pub fn value(&self) -> ValueRef<'_> { ValueRef(self.0.value()) }
    pub fn into_value(self) -> Value { Value(self.0.into_value()) }
    pub fn kind(&self) -> OperationKind<'_> {
        match self.0.kind() {
            logical::RetainedOperationKind::Construction(recipe) => OperationKind::Construction(recipe),
            logical::RetainedOperationKind::Affine { input, matrix } => OperationKind::Affine { input: ValueRef(input), matrix },
            logical::RetainedOperationKind::Boolean { inputs, operation } => OperationKind::Boolean {
                inputs: [ValueRef(&inputs[0]), ValueRef(&inputs[1])], operation: *operation,
            },
        }
    }
    /// Logical classification only; processing must authenticate every receipt
    /// in the batch first. This creates no runtime or publication authority.
    pub fn bind_numerical_outcome(&self, empty: bool) -> crate::Result<()> {
        self.0.bind_numerical_outcome(empty)
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Requirement { ProductPlacement, OpeningClosure, MaterialLayers, IfcAppearance, PersistentFaces }
pub struct Plan {
    pub(super) inner: logical::RetainedProductPlan,
    _storage: Option<crate::resource::Reservation>,
}
impl Plan {
    pub(super) fn new(inner: logical::RetainedProductPlan) -> Self { Self { inner, _storage: None } }
    pub fn type_maps(plans: Vec<Self>) -> Result<Self, super::TransactionError> {
        let resources = super::Resources::capture_current();
        let count = plans.iter().try_fold(0usize, |n, plan| n.checked_add(plan.inner.values.len()))
            .ok_or_else(crate::resource::overflow)?;
        let mut values = Vec::new();
        let storage = resources.reserve_headers(&mut values, count)?;
        for plan in plans { values.extend(plan.inner.values); }
        resources.check()?;
        Ok(Self { inner: logical::RetainedProductPlan { values, remaining: vec![
            logical::RetainedRequirement::ProductPlacement, logical::RetainedRequirement::OpeningClosure,
            logical::RetainedRequirement::MaterialLayers, logical::RetainedRequirement::IfcAppearance,
            logical::RetainedRequirement::PersistentFaces,
        ] }, _storage: Some(storage) })
    }
}
impl Plan {
    pub fn values(&self) -> impl ExactSizeIterator<Item = ValueRef<'_>> {
        self.inner.values.iter().map(ValueRef)
    }
    pub fn requirements(&self) -> impl Iterator<Item = Requirement> + '_ {
        self.inner.remaining.iter().map(|requirement| match requirement {
            logical::RetainedRequirement::ProductPlacement => Requirement::ProductPlacement,
            logical::RetainedRequirement::OpeningClosure => Requirement::OpeningClosure,
            logical::RetainedRequirement::MaterialLayers => Requirement::MaterialLayers,
            logical::RetainedRequirement::IfcAppearance => Requirement::IfcAppearance,
            logical::RetainedRequirement::PersistentFaces => Requirement::PersistentFaces,
        })
    }
}
