// SPDX-License-Identifier: MPL-2.0
//! The STEP header an exporting application settles: `time_stamp`,
//! `preprocessor_version` and buildingSMART's `originating_system` form.

use super::{ExportingApplication, Identity};
use crate::plan::owner_history::iso_from_epoch;
use crate::plan::types::ValidationFinding;

impl Identity {
    /// The header fields the exporting application settles: the change time
    /// as `time_stamp` and this toolkit as `preprocessor_version` in `opts`,
    /// and the returned `originating_system` (the application), which the
    /// caller passes to `write_header_originating`. The one place both the
    /// plan writer and the skeleton take them from.
    pub(crate) fn stamp_header(&self, opts: &mut crate::StepOptions) -> String {
        opts.time_stamp = Some(self.header_time_stamp());
        opts.application = Some(concat!("ifc-lite ", env!("CARGO_PKG_VERSION")).to_string());
        self.originating_system()
    }

    /// `FILE_NAME.originating_system`: `Company - Application - Version`
    /// from the application's fields exactly as given, each in its place.
    /// [`Self::header_note`] reports a form the agreement doesn't accept.
    fn originating_system(&self) -> String {
        format!("{} - {} - {}", self.app.developer, self.app.full_name, self.app.version)
    }

    /// The exporting application as the export's identity, with a header
    /// that doesn't follow the agreement reported in `findings`: the one
    /// place both the plan and the skeleton resolve it. The error is a change
    /// time it can't attribute; each caller decides whether that refuses or
    /// is reported.
    pub(crate) fn resolve(app: &ExportingApplication, findings: &mut Vec<ValidationFinding>) -> Result<Self, String> {
        let identity = Self::new(app)?;
        findings.extend(identity.header_note().map(|message| ValidationFinding::new(None, message)));
        Ok(identity)
    }

    /// A finding when the application's fields don't make a valid
    /// `originating_system` under buildingSMART's header agreement
    /// (`Software Company Name - Application Name - Application Version`, no
    /// dash inside the names, and the agreement's version form: numbers and
    /// dots with an optional lowercase `-alpha`, `-beta` or `-rc` suffix, a
    /// subset of PEP 440). The fields are written exactly as given all the
    /// same: the caller's names are not rewritten.
    fn header_note(&self) -> Option<String> {
        let dash = |c: char| matches!(c, '-' | '\u{00AD}' | '\u{2010}'..='\u{2015}' | '\u{2043}' | '\u{2212}' | '\u{FE58}' | '\u{FE63}' | '\u{FF0D}');
        let name_ok = |n: &str| !n.is_empty() && n.trim() == n && !n.contains(dash);
        let digits = |t: &str| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit());
        let version = self.app.version.as_str();
        let (number, suffix) = match version.split_once('-') {
            Some((number, suffix)) => (number, Some(suffix)),
            None => (version, None),
        };
        let number_ok = number.split('.').all(digits);
        let suffix_ok = suffix.is_none_or(|suffix| {
            ["alpha", "beta", "rc"].iter().any(|tag| {
                suffix.strip_prefix(tag).is_some_and(|rest| rest.is_empty() || digits(rest.strip_prefix('.').unwrap_or(rest)))
            })
        });
        (!(name_ok(&self.app.developer) && name_ok(&self.app.full_name) && number_ok && suffix_ok)).then(|| {
            format!(
                "originating_system '{}' does not follow buildingSMART's header agreement (Software Company Name - Application Name - Application Version: no dash inside the names, a numeric version with an optional lowercase -alpha, -beta or -rc suffix)",
                self.originating_system()
            )
        })
    }

    /// `FILE_NAME.time_stamp`: the change time as UTC ISO 8601, marked `Z`.
    fn header_time_stamp(&self) -> String {
        format!("{}Z", iso_from_epoch(self.seconds))
    }
}
