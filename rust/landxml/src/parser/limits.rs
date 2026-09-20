/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use super::Parser;
use crate::{
    xml::{error, Result},
    LandXmlCancellation, LandXmlDiagnosticCode as Code,
};

impl Parser<'_> {
    /// Reserve source-coordinate records before allocating semantic output.
    /// Definition points, SourceData lists and overlay vertices all count: a
    /// document must not bypass `max_points` merely by moving coordinates out
    /// of `Definition/Pnts`.
    pub(super) fn reserve_points(&self, added: usize) -> Result<()> {
        let total = self
            .points_seen
            .checked_add(added)
            .ok_or_else(|| error(Code::LimitExceeded, "point limit exceeded"))?;
        if total > self.limits.max_points {
            return Err(error(Code::LimitExceeded, "point limit exceeded"));
        }
        Ok(())
    }

    pub(super) fn check_cancel_and_work(&mut self, added: usize) -> Result<()> {
        if self
            .cancelled
            .is_some_and(LandXmlCancellation::is_cancelled)
        {
            return Err(error(Code::Cancelled, "ingestion cancelled"));
        }
        self.work = self
            .work
            .checked_add(added)
            .ok_or_else(|| error(Code::LimitExceeded, "work limit exceeded"))?;
        if self.work > self.limits.max_work {
            return Err(error(Code::LimitExceeded, "work limit exceeded"));
        }
        Ok(())
    }

    pub(super) fn check_character_references(&mut self, added: usize) -> Result<()> {
        self.character_references = self
            .character_references
            .checked_add(added)
            .ok_or_else(|| error(Code::LimitExceeded, "character reference limit exceeded"))?;
        if self.character_references > self.limits.max_character_references {
            return Err(error(
                Code::LimitExceeded,
                "character reference limit exceeded",
            ));
        }
        Ok(())
    }
}
