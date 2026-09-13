// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Page-level fidelity verdict. Exact means nothing visible is lost; anything
//! else needs the host to show this report and the user to accept it.
use super::extent::{self, Rect};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const FIDELITY_ALGORITHM: &str = "ifclite-pdf-fidelity-v1";
/// Detailed entries are bounded; `summary` counts stay complete.
pub const MAX_LISTED_OMISSIONS: usize = 4096;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Omission {
    /// `text`, `image`, `pattern`, `clip`, `transparency`, `dash`,
    /// `curvedStroke`, `hairline`, `hidden`, `annotation`
    /// or `unsupported:<pinned operator>`.
    pub kind: String,
    pub operator_ordinal: u32,
    /// Conservative extent in unrotated PDF user space (CropBox coordinates).
    pub bbox_pdf: Option<Rect>,
    /// Intersects the effective page clip and is not hidden/invisible.
    pub visible: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OmissionSummary {
    pub kind: String,
    pub count: u32,
    pub visible_count: u32,
    /// Union of the visible entries.
    pub bbox_pdf: Option<Rect>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FidelityReport {
    /// Binds the request digest and this verdict; a partial plan must quote it.
    pub sha256: String,
    pub algorithm: &'static str,
    /// No visible content is omitted. Says nothing about geometric qualification.
    pub exact: bool,
    /// Only raster images are visible: keep the page as a raster reference.
    pub raster_only: bool,
    pub convertible_paths: u32,
    /// Visible painted fill or stroke parts the planner leaves out. Paints
    /// inside hidden optional content are listed under `hidden` but not
    /// counted here, so an exact page always records zero.
    pub omitted_paints: u32,
    pub summary: Vec<OmissionSummary>,
    pub omissions: Vec<Omission>,
    pub omissions_truncated: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Verdict<'a> {
    exact: bool,
    raster_only: bool,
    convertible_paths: u32,
    omitted_paints: u32,
    summary: &'a [OmissionSummary],
}

#[derive(Default)]
pub(super) struct ReportBuilder {
    omissions: Vec<Omission>,
    truncated: bool,
    summary: BTreeMap<String, OmissionSummary>,
    omitted_paints: u32,
    visible_images: u32,
    visible_vector: u32,
}
impl ReportBuilder {
    /// `painted` marks omitted fill/stroke parts of real paths, distinct from
    /// text, images and scope markers.
    pub fn record(&mut self, kind: &str, ordinal: u32, bbox: Option<Rect>, visible: bool, painted: bool) {
        if painted && visible {
            self.omitted_paints += 1;
        }
        if visible {
            if kind == "image" {
                self.visible_images += 1;
            } else if kind != "hidden" {
                self.visible_vector += 1;
            }
        }
        let entry = self.summary.entry(kind.to_owned()).or_insert_with(|| OmissionSummary {
            kind: kind.to_owned(),
            count: 0,
            visible_count: 0,
            bbox_pdf: None,
        });
        entry.count += 1;
        if visible {
            entry.visible_count += 1;
            entry.bbox_pdf = extent::union(entry.bbox_pdf, bbox);
        }
        if self.omissions.len() < MAX_LISTED_OMISSIONS {
            self.omissions.push(Omission {
                kind: kind.to_owned(),
                operator_ordinal: ordinal,
                bbox_pdf: bbox,
                visible,
            });
        } else {
            self.truncated = true;
        }
    }
    pub fn finish(self, request_sha256: &str, convertible_paths: usize) -> FidelityReport {
        let mut summary: Vec<_> = self.summary.into_values().collect();
        summary.sort_by(|a, b| {
            b.visible_count
                .cmp(&a.visible_count)
                .then(b.count.cmp(&a.count))
                .then(a.kind.cmp(&b.kind))
        });
        let convertible_paths = u32::try_from(convertible_paths).unwrap_or(u32::MAX);
        let raster_only = convertible_paths == 0 && self.visible_vector == 0 && self.visible_images > 0;
        let exact = !raster_only && summary.iter().all(|s| s.visible_count == 0);
        let verdict = Verdict {
            exact,
            raster_only,
            convertible_paths,
            omitted_paints: self.omitted_paints,
            summary: &summary,
        };
        let mut hash = Sha256::new();
        hash.update(FIDELITY_ALGORITHM.as_bytes());
        hash.update(b"\0");
        hash.update(request_sha256.as_bytes());
        hash.update(serde_json::to_vec(&verdict).unwrap_or_default());
        FidelityReport {
            sha256: format!("{:x}", hash.finalize()),
            algorithm: FIDELITY_ALGORITHM,
            exact,
            raster_only,
            convertible_paths,
            omitted_paints: self.omitted_paints,
            summary,
            omissions: self.omissions,
            omissions_truncated: self.truncated,
        }
    }
}
impl FidelityReport {
    pub fn visible_omissions(&self) -> u32 {
        self.summary.iter().map(|s| s.visible_count).sum()
    }
    /// Short human sentence for `IfcAnnotation.Description` and messages.
    /// Kinds are spelled out for people; the JSON `Omissions` property keeps
    /// the canonical tokens.
    pub fn describe(&self) -> String {
        if self.raster_only {
            return "raster-only page".into();
        }
        if self.exact {
            return "exact conversion".into();
        }
        let parts: Vec<String> = self
            .summary
            .iter()
            .filter(|s| s.visible_count > 0)
            .map(|s| format!("{} {}", s.visible_count, kind_label(&s.kind, s.visible_count)))
            .collect();
        format!("partial conversion; omitted {}", parts.join(", "))
    }
}

/// Human wording for one omission kind, pluralised by `count`.
pub fn kind_label(kind: &str, count: u32) -> String {
    let plural = |one: &str, many: &str| if count == 1 { one } else { many }.to_owned();
    match kind {
        "text" => plural("text run", "text runs"),
        "image" => plural("image", "images"),
        "clip" => plural("clipped path", "clipped paths"),
        "transparency" => plural("transparent path", "transparent paths"),
        "pattern" => plural("pattern paint", "pattern paints"),
        "dash" => plural("dashed stroke", "dashed strokes"),
        "roundCapJoin" => plural("round-cap/join stroke", "round-cap/join strokes"),
        "curvedStroke" => plural("curved stroke", "curved strokes"),
        "hairline" => plural("hairline stroke", "hairline strokes"),
        "hidden" => plural("hidden path", "hidden paths"),
        "annotation" => plural("annotation appearance", "annotation appearances"),
        other => match other.strip_prefix("unsupported:") {
            Some(op) => format!("{} under unsupported operator {op}", plural("entry", "entries")),
            None => other.to_owned(),
        },
    }
}
