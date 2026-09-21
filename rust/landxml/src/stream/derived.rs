/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Derived presentation records emitted through the credited metadata cursor.

use super::{event, LandXmlMetadataRecord};
use crate::{
    LandXmlError, LandXmlPlanDocument, LandXmlPlanPoint, LandXmlPlanPointLocation,
    LandXmlPlanResolver,
};
use std::collections::VecDeque;

/// Compute direct-ingestion plan adapter fields before moving authored records
/// into the cursor. This retains one semantic plan, never an End duplicate.
pub(super) fn plan_derived_records(
    plan: &LandXmlPlanDocument,
) -> Result<VecDeque<LandXmlMetadataRecord>, LandXmlError> {
    let resolution_requests = plan
        .monuments
        .len()
        .saturating_add(
            plan.plan_features
                .iter()
                .map(|feature| feature.geometry.len().saturating_mul(4))
                .sum::<usize>(),
        )
        .saturating_add(
            plan.parcels
                .iter()
                .map(|parcel| {
                    parcel
                        .loops
                        .iter()
                        .map(|loop_geometry| loop_geometry.len().saturating_mul(4))
                        .sum::<usize>()
                })
                .sum::<usize>(),
        );
    let max_work = plan
        .cogo_points()
        .len()
        .saturating_mul(8)
        .saturating_add(resolution_requests.saturating_mul(8))
        .saturating_add(1_000);
    let mut resolver = LandXmlPlanResolver::new(plan, max_work);
    let mut records = VecDeque::new();
    records.extend(
        plan.source_batches(128)
            .into_iter()
            .map(LandXmlMetadataRecord::PlanSourceBatch),
    );
    records.extend(
        plan.probe_parcels_with_resolver(&plan.parcels, &mut resolver)?
            .into_iter()
            .zip(plan.parcels.iter())
            .map(|(probe, parcel)| {
                LandXmlMetadataRecord::PlanParcelProbe(event::LandXmlPlanParcelProbe {
                    source_id: parcel.source_id.clone(),
                    probe,
                })
            }),
    );
    for monument in &plan.monuments {
        let point = match (&monument.point, &monument.pnt_ref) {
            (Some(point), _) => Some(*point),
            (None, Some(reference)) => resolver.resolve(
                monument.point_scope_id.as_ref(),
                &LandXmlPlanPointLocation::PointReference {
                    pnt_ref: reference.clone(),
                },
            )?,
            (None, None) => None,
        };
        records.push_back(LandXmlMetadataRecord::PlanResolvedMonument(
            event::LandXmlPlanResolvedMonument {
                source_id: monument.source_id.clone(),
                point,
            },
        ));
    }
    for geometry in plan
        .plan_features
        .iter()
        .flat_map(|feature| feature.geometry.iter())
        .chain(
            plan.parcels
                .iter()
                .flat_map(|parcel| parcel.loops.iter().flatten()),
        )
    {
        let resolve = |location: &LandXmlPlanPointLocation,
                       resolver: &mut LandXmlPlanResolver<'_>|
         -> Result<Option<LandXmlPlanPoint>, LandXmlError> {
            resolver.resolve(geometry.point_scope_id.as_ref(), location)
        };
        records.push_back(LandXmlMetadataRecord::PlanResolvedGeometry(
            event::LandXmlPlanResolvedGeometry {
                source_id: geometry.source_id.clone(),
                start: resolve(&geometry.start, &mut resolver)?,
                end: resolve(&geometry.end, &mut resolver)?,
                center: geometry
                    .center
                    .as_ref()
                    .map(|point| resolve(point, &mut resolver))
                    .transpose()?
                    .flatten(),
                pi: geometry
                    .pi
                    .as_ref()
                    .map(|point| resolve(point, &mut resolver))
                    .transpose()?
                    .flatten(),
            },
        ));
    }
    Ok(records)
}

/// Alignment render data follows normal cursor credit too; it is never an End
/// compatibility payload.
pub(super) fn alignment_derived_records(
    alignment: &crate::alignment::LandXmlAlignmentDocument,
) -> VecDeque<LandXmlMetadataRecord> {
    let derived = crate::alignment::alignment_render_data(alignment);
    let mut records = VecDeque::new();
    records.extend(
        derived
            .spans
            .into_iter()
            .map(LandXmlMetadataRecord::AlignmentRenderSpan),
    );
    records.extend(
        derived
            .refusals
            .into_iter()
            .map(LandXmlMetadataRecord::AlignmentRenderRefusal),
    );
    records.push_back(LandXmlMetadataRecord::AlignmentRenderTruncated(
        derived.truncated,
    ));
    records
}
