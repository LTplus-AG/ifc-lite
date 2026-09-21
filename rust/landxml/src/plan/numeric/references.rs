/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use std::{
    cell::Ref,
    collections::{HashMap, HashSet},
};

use super::{LandXmlPlanDocument, LandXmlPlanPoint, LandXmlPlanPointLocation, TopologyBudget};
use crate::plan::model::LandXmlPlanReferenceIndex;
use crate::LandXmlMonument;

/// One document-scoped resolver used by bulk adapters. Cached failures are as
/// important as points: dangling, ambiguous and cyclic aliases must not be
/// retraversed for every dependent geometry record.
pub struct LandXmlPlanResolver<'a> {
    document: &'a LandXmlPlanDocument,
    cache: HashMap<(Option<crate::LandXmlSourceId>, String), Option<LandXmlPlanPoint>>,
    work: usize,
    max_work: usize,
}
impl<'a> LandXmlPlanResolver<'a> {
    pub fn new(document: &'a LandXmlPlanDocument, max_work: usize) -> Self {
        Self {
            document,
            cache: HashMap::new(),
            work: 0,
            max_work,
        }
    }
    pub fn resolve(
        &mut self,
        scope: Option<&crate::LandXmlSourceId>,
        location: &LandXmlPlanPointLocation,
    ) -> std::result::Result<Option<LandXmlPlanPoint>, crate::LandXmlError> {
        let LandXmlPlanPointLocation::PointReference { pnt_ref } = location else {
            return Ok(match location {
                LandXmlPlanPointLocation::Coordinates { point, .. } => Some(*point),
                _ => None,
            });
        };
        let first = (scope.cloned(), pnt_ref.clone());
        if let Some(value) = self.cache.get(&first) {
            return Ok(*value);
        }
        let index = self
            .document
            .reference_index_with(|| Ok::<(), crate::LandXmlError>(()))?;
        let mut key = first.clone();
        let mut path = Vec::new();
        let mut seen = HashSet::new();
        let result = loop {
            if self.work >= self.max_work {
                return Err(crate::LandXmlError::new(
                    crate::LandXmlDiagnosticCode::LimitExceeded,
                    "COGO bulk resolution work limit exceeded",
                ));
            }
            self.work += 1;
            if let Some(value) = self.cache.get(&key) {
                break *value;
            }
            let Some(position) = self
                .document
                .lookup_reference(&index, key.0.as_ref(), &key.1)
            else {
                break None;
            };
            if !seen.insert(position) {
                break None;
            }
            path.push(key.clone());
            let Some(point) = self.document.cogo_points().get(position) else {
                break None;
            };
            if let Some(value) = point.point {
                break Some(value);
            }
            let Some(reference) = point.pnt_ref.clone() else {
                break None;
            };
            key = (Some(point.scope_id.clone()), reference);
        };
        for item in path {
            self.cache.insert(item, result);
        }
        self.cache.insert(first, result);
        Ok(result)
    }
}

impl LandXmlPlanDocument {
    /// Resolve a COGO reference in its producer scope, falling back only when
    /// the document has one unambiguous name match.
    pub fn resolve_point(
        &self,
        scope_id: Option<&crate::LandXmlSourceId>,
        location: &LandXmlPlanPointLocation,
    ) -> Option<LandXmlPlanPoint> {
        match location {
            LandXmlPlanPointLocation::Coordinates { point, .. } => Some(*point),
            LandXmlPlanPointLocation::PointReference { pnt_ref } => self
                .resolve_reference(scope_id, pnt_ref, self.cogo_points().len(), None)
                .ok()
                .flatten(),
        }
    }

    /// Resolve a COGO reference while allowing hosts to interrupt alias work.
    pub fn resolve_point_with_cancel(
        &self,
        scope_id: Option<&crate::LandXmlSourceId>,
        location: &LandXmlPlanPointLocation,
        cancelled: Option<&dyn crate::LandXmlCancellation>,
    ) -> std::result::Result<Option<LandXmlPlanPoint>, crate::LandXmlError> {
        match location {
            LandXmlPlanPointLocation::Coordinates { point, .. } => Ok(Some(*point)),
            LandXmlPlanPointLocation::PointReference { pnt_ref } => {
                self.resolve_reference(scope_id, pnt_ref, self.cogo_points().len(), cancelled)
            }
        }
    }

    fn resolve_reference(
        &self,
        scope_id: Option<&crate::LandXmlSourceId>,
        reference: &str,
        budget: usize,
        cancelled: Option<&dyn crate::LandXmlCancellation>,
    ) -> std::result::Result<Option<LandXmlPlanPoint>, crate::LandXmlError> {
        let index = self.reference_index_with(|| {
            if cancelled.is_some_and(crate::LandXmlCancellation::is_cancelled) {
                return Err(crate::LandXmlError::new(
                    crate::LandXmlDiagnosticCode::Cancelled,
                    "COGO reference index rebuild cancelled",
                ));
            }
            Ok(())
        })?;
        let mut next_scope = scope_id.cloned();
        let mut next_reference = reference;
        let mut remaining = budget;
        let mut seen = HashSet::new();
        while remaining > 0 {
            if cancelled.is_some_and(crate::LandXmlCancellation::is_cancelled) {
                return Err(crate::LandXmlError::new(
                    crate::LandXmlDiagnosticCode::Cancelled,
                    "COGO reference resolution cancelled",
                ));
            }
            let Some(index) = self.lookup_reference(&index, next_scope.as_ref(), next_reference)
            else {
                return Ok(None);
            };
            if !seen.insert(index) {
                return Ok(None);
            }
            let Some(point) = self.cogo_points().get(index) else {
                return Ok(None);
            };
            if let Some(value) = point.point {
                return Ok(Some(value));
            }
            next_scope = Some(point.scope_id.clone());
            let Some(next) = point.pnt_ref.as_deref() else {
                return Ok(None);
            };
            next_reference = next;
            remaining -= 1;
        }
        Ok(None)
    }

    pub(super) fn resolve_point_with_budget(
        &self,
        scope_id: Option<&crate::LandXmlSourceId>,
        location: &LandXmlPlanPointLocation,
        budget: &mut TopologyBudget<'_>,
    ) -> std::result::Result<Option<LandXmlPlanPoint>, crate::LandXmlError> {
        match location {
            LandXmlPlanPointLocation::Coordinates { point, .. } => Ok(Some(*point)),
            LandXmlPlanPointLocation::PointReference { pnt_ref } => {
                let index = self.reference_index_with(|| budget.check())?;
                let mut next_scope = scope_id.cloned();
                let mut next_reference = pnt_ref.as_str();
                let mut remaining = self.cogo_points().len();
                let mut seen = HashSet::new();
                while remaining > 0 {
                    budget.check()?;
                    let Some(index) =
                        self.lookup_reference(&index, next_scope.as_ref(), next_reference)
                    else {
                        return Ok(None);
                    };
                    if !seen.insert(index) {
                        return Ok(None);
                    }
                    let Some(point) = self.cogo_points().get(index) else {
                        return Ok(None);
                    };
                    if point.point.is_some() {
                        return Ok(point.point);
                    }
                    next_scope = Some(point.scope_id.clone());
                    let Some(next) = point.pnt_ref.as_deref() else {
                        return Ok(None);
                    };
                    next_reference = next;
                    remaining -= 1;
                }
                Ok(None)
            }
        }
    }

    /// Deserialize deliberately omits this derived cache. Rebuild it once on
    /// the first lookup, polling the same cancellation/work budget used by the
    /// caller, then retain it for later lookups. Public point mutation is
    /// still validated by `lookup_reference` before a cached target is used.
    fn reference_index_with<E>(
        &self,
        check: impl FnMut() -> std::result::Result<(), E>,
    ) -> std::result::Result<Ref<'_, LandXmlPlanReferenceIndex>, E> {
        if self.reference_index.borrow().is_none() {
            let rebuilt =
                LandXmlPlanReferenceIndex::from_points_checked(self.cogo_points(), check)?;
            *self.reference_index.borrow_mut() = Some(rebuilt);
        }
        Ok(Ref::map(self.reference_index.borrow(), |index| {
            index
                .as_ref()
                .expect("reference index is initialized before it is borrowed")
        }))
    }

    fn lookup_reference(
        &self,
        index: &LandXmlPlanReferenceIndex,
        scope_id: Option<&crate::LandXmlSourceId>,
        reference: &str,
    ) -> Option<usize> {
        let scoped_target =
            scope_id.and_then(|scope| index.scoped.get(&(scope.clone(), reference.to_owned())));
        let target = scoped_target.or_else(|| index.global.get(reference));
        if let Some(Some(target)) = target {
            if self
                .cogo_points()
                .get(target.index)
                .is_some_and(|point| point.source_id == target.source_id)
            {
                return Some(target.index);
            }
        }
        // A complete index is immutable with respect to public document
        // state. Do not fall back to an O(n) scan: it both bypasses the
        // ambiguity rules and makes missing references uninterruptible.
        None
    }

    /// Resolve a monument's direct coordinate or its scoped `pntRef`.
    pub fn resolve_monument_point(&self, monument: &LandXmlMonument) -> Option<LandXmlPlanPoint> {
        monument.point.or_else(|| {
            monument.pnt_ref.as_ref().and_then(|pnt_ref| {
                self.resolve_point(
                    monument.point_scope_id.as_ref(),
                    &LandXmlPlanPointLocation::PointReference {
                        pnt_ref: pnt_ref.clone(),
                    },
                )
            })
        })
    }
}
