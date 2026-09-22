/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Credit-resumable presentation records.

mod alignment;
mod plan;

pub(crate) use alignment::AlignmentDerivedCursor;
pub(crate) use plan::PlanDerivedCursor;
