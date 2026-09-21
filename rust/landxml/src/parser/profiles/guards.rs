/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Bounded source-record and diagnostic accounting for profile semantics.

use crate::{
    xml::{error, Result},
    LandXmlCapabilityDiagnostic, LandXmlCapabilityDiagnosticCode, LandXmlSourceId,
};

use super::super::{Code, Parser};

impl Parser<'_> {
    pub(super) fn record_discontinuity(
        &mut self,
        discontinuous: bool,
        source_id: &LandXmlSourceId,
        message: &str,
    ) -> Result<()> {
        if discontinuous {
            self.record_capability_diagnostic(LandXmlCapabilityDiagnostic {
                code: LandXmlCapabilityDiagnosticCode::SectionDiscontinuity,
                source_id: Some(source_id.clone()),
                source_path: self.path(),
                message: message.to_owned(),
            })?;
        }
        Ok(())
    }

    pub(super) fn missing_elevation(&mut self, source_id: LandXmlSourceId) -> Result<()> {
        self.record_capability_diagnostic(LandXmlCapabilityDiagnostic {
            code: LandXmlCapabilityDiagnosticCode::MissingElevation,
            source_id: Some(source_id),
            source_path: self.path(),
            message: "source point has no elevation; no derived geometry is available".to_owned(),
        })
    }

    pub(super) fn reserve_profile_points(&mut self, additional: usize) -> Result<()> {
        self.profile_points_seen = self
            .profile_points_seen
            .checked_add(additional)
            .ok_or_else(|| error(Code::LimitExceeded, "profile point limit exceeded"))?;
        if self.profile_points_seen > self.limits.max_profile_points {
            return Err(error(Code::LimitExceeded, "profile point limit exceeded"));
        }
        Ok(())
    }

    pub(super) fn reserve_cross_section_points(&mut self, additional: usize) -> Result<()> {
        self.cross_section_points_seen = self
            .cross_section_points_seen
            .checked_add(additional)
            .ok_or_else(|| error(Code::LimitExceeded, "cross-section point limit exceeded"))?;
        if self.cross_section_points_seen > self.limits.max_cross_section_points {
            return Err(error(
                Code::LimitExceeded,
                "cross-section point limit exceeded",
            ));
        }
        Ok(())
    }
}
