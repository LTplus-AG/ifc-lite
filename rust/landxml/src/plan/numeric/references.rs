/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use std::collections::HashSet;

use super::{LandXmlPlanDocument, LandXmlPlanPoint, LandXmlPlanPointLocation, TopologyBudget};
use crate::plan::model::LandXmlPlanReferenceIndex;
use crate::LandXmlMonument;

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
                .resolve_reference(scope_id, pnt_ref, self.cogo_points.len(), None)
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
                self.resolve_reference(scope_id, pnt_ref, self.cogo_points.len(), cancelled)
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
        let rebuilt;
        let index = if self.reference_index.empty() {
            rebuilt = LandXmlPlanReferenceIndex::from_points(&self.cogo_points);
            &rebuilt
        } else {
            &self.reference_index
        };
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
            let Some(index) = self.lookup_reference(index, next_scope.as_ref(), next_reference)
            else {
                return Ok(None);
            };
            if !seen.insert(index) {
                return Ok(None);
            }
            let Some(point) = self.cogo_points.get(index) else {
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
                let rebuilt;
                let index = if self.reference_index.empty() {
                    rebuilt = LandXmlPlanReferenceIndex::from_points(&self.cogo_points);
                    &rebuilt
                } else {
                    &self.reference_index
                };
                let mut next_scope = scope_id.cloned();
                let mut next_reference = pnt_ref.as_str();
                let mut remaining = self.cogo_points.len();
                let mut seen = HashSet::new();
                while remaining > 0 {
                    budget.check()?;
                    let Some(index) =
                        self.lookup_reference(index, next_scope.as_ref(), next_reference)
                    else {
                        return Ok(None);
                    };
                    if !seen.insert(index) {
                        return Ok(None);
                    }
                    let Some(point) = self.cogo_points.get(index) else {
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

    fn lookup_reference(
        &self,
        index: &LandXmlPlanReferenceIndex,
        scope_id: Option<&crate::LandXmlSourceId>,
        reference: &str,
    ) -> Option<usize> {
        if let Ok(ordinal) = reference.parse::<usize>() {
            return self.cogo_points.iter().position(|point| {
                point.ordinal == ordinal && scope_id.is_none_or(|scope| point.scope_id == *scope)
            });
        }
        let target = match scope_id {
            Some(scope) => index.scoped.get(&(scope.clone(), reference.to_owned()))?,
            None => index.global.get(reference)?,
        }
        .as_ref()?;
        self.cogo_points
            .get(target.index)
            .filter(|point| point.source_id == target.source_id)
            .map(|_| target.index)
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
