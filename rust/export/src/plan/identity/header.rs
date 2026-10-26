// SPDX-License-Identifier: MPL-2.0
//! The STEP header an exporting application settles: `time_stamp`,
//! `preprocessor_version` and buildingSMART's `originating_system` form.

#[cfg(test)]
use super::epoch_seconds;
use super::{ExportingApplication, Identity};
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

    /// `Identity::new`, with what it refuses and how the header reads
    /// reported in `findings`: the one place both the plan and the skeleton
    /// resolve the exporting application.
    pub(crate) fn resolve(app: &ExportingApplication, findings: &mut Vec<ValidationFinding>) -> Option<Self> {
        let identity = Self::new(app).map_err(|message| findings.push(ValidationFinding { express_id: None, message })).ok()?;
        if let Some(message) = identity.header_note() {
            findings.push(ValidationFinding { express_id: None, message });
        }
        Some(identity)
    }

    /// A finding when the application's fields don't make a valid
    /// `originating_system` under buildingSMART's header agreement
    /// (`Software Company Name - Application Name - Application Version`, no
    /// dash inside the names, a PEP 440 version of numbers and dots with an
    /// optional `-alpha`, `-beta` or `-rc` suffix). Written as given (trimmed)
    /// all the same: the caller's names are not rewritten.
    pub(crate) fn header_note(&self) -> Option<String> {
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
                "originating_system '{}' does not follow buildingSMART's header agreement (Software Company Name - Application Name - Application Version: no dash inside the names, a numeric version with an optional -alpha, -beta or -rc suffix)",
                self.originating_system()
            )
        })
    }

    /// `FILE_NAME.time_stamp`: the change time as UTC ISO 8601, marked `Z`.
    fn header_time_stamp(&self) -> String {
        format!("{}Z", iso_from_epoch(self.seconds))
    }
}

/// `YYYY-MM-DDTHH:MM:SS` (UTC) for Unix seconds, the inverse of
/// `epoch_seconds` (Howard Hinnant's `civil_from_days`).
fn iso_from_epoch(seconds: i64) -> String {
    let days = seconds.div_euclid(86_400);
    let rem = seconds.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_time_round_trips_epoch_seconds() {
        for stamp in ["1970-01-01T00:00:00", "2000-02-29T23:59:59", "2026-10-23T10:00:00", "1969-12-31T23:59:59"] {
            assert_eq!(iso_from_epoch(epoch_seconds(stamp).unwrap()), stamp);
        }
    }
}
