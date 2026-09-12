// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Provenance for a PDF vector annotation: the source page identity,
//! calibration, declared tolerance and the accepted fidelity verdict, written
//! as an ordinary `IfcPropertySet` so any IFC reader can see what was and was
//! not converted after export and reopen. Type-qualified values name their
//! schema type in registry spelling (`IfcBoolean`), which the host resolves to
//! the EXPRESS base before writing `IFCBOOLEAN(.T.)`.
use super::{
    authored::{refs, typed, Author},
    pdf_fill_types::PdfFillAnnotationRequest,
};
use crate::pdf_vector::{FidelityReport, PreparedPdfVectorPage};
use ifc_lite_core::{AttributeValue as A, IfcType};
use serde::Serialize;

pub const PROPERTY_SET_NAME: &str = "IfcLite_PdfVectorConversion";
/// Bound for the `Omissions` text so a pathological page cannot grow one row.
const MAX_OMISSIONS_TEXT: usize = 4000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OmissionEntry<'a> {
    kind: &'a str,
    count: u32,
    visible: u32,
}

/// Compact JSON of the summary counts, truncated by whole entries with a final
/// `{"kind":"…","count":<rest>}` marker when the bound would be exceeded.
pub(super) fn omissions_text(fidelity: &FidelityReport) -> String {
    let mut entries: Vec<OmissionEntry<'_>> = Vec::new();
    let mut rendered = String::from("[]");
    for (index, entry) in fidelity.summary.iter().enumerate() {
        entries.push(OmissionEntry {
            kind: &entry.kind,
            count: entry.count,
            visible: entry.visible_count,
        });
        let candidate = serde_json::to_string(&entries).unwrap_or_default();
        if candidate.len() > MAX_OMISSIONS_TEXT - 64 {
            entries.pop();
            let rest: u32 = fidelity.summary[index..].iter().map(|s| s.count).sum();
            entries.push(OmissionEntry {
                kind: "...",
                count: rest,
                visible: fidelity.summary[index..].iter().map(|s| s.visible_count).sum(),
            });
            return serde_json::to_string(&entries).unwrap_or_default();
        }
        rendered = candidate;
    }
    rendered
}

fn json_numbers(values: &[f64]) -> String {
    serde_json::to_string(values).unwrap_or_default()
}

pub(super) struct Provenance<'a> {
    pub request: &'a PdfFillAnnotationRequest,
    pub prepared: &'a PreparedPdfVectorPage,
    pub grid_size_metres: f64,
    pub fill_regions: usize,
}
impl Provenance<'_> {
    fn properties(&self) -> Vec<(&'static str, A)> {
        let page = &self.request.page;
        let fidelity = &self.prepared.fidelity;
        let text = |s: String| typed("IfcText", A::String(s));
        let label = |s: &str| typed("IfcLabel", A::String(s.into()));
        let identifier = |s: &str| typed("IfcIdentifier", A::String(s.into()));
        let integer = |n: i64| typed("IfcInteger", A::Integer(n));
        let real = |x: f64| typed("IfcReal", A::Float(x));
        let boolean = |b: bool| typed("IfcBoolean", A::Enum(if b { "T" } else { "F" }.into()));
        vec![
            ("SourcePdfSha256", identifier(&page.pdf_sha256)),
            ("SourcePageNumber", integer(i64::from(page.page_number))),
            ("SourceCropBox", text(json_numbers(&page.view_box))),
            ("SourceUserUnit", real(page.user_unit)),
            ("SourceRotation", integer(i64::from(page.intrinsic_rotation))),
            ("DecoderVersion", label(&format!("PDF.js {}", page.decoder_version))),
            ("CalibrationKey", text(page.calibration_key.clone())),
            ("ModelMetresFromPdf", text(json_numbers(&page.model_metres_from_pdf))),
            ("ToleranceMetres", real(page.tolerance_metres)),
            ("GridSizeMetres", real(self.grid_size_metres)),
            ("Algorithm", label(super::pdf_fill::ALGORITHM)),
            ("RequestSha256", identifier(&self.prepared.request_sha256)),
            ("FidelityAlgorithm", label(fidelity.algorithm)),
            ("FidelitySha256", identifier(&fidelity.sha256)),
            ("ExactConversion", boolean(fidelity.exact)),
            ("AcceptedPartialConversion", boolean(!fidelity.exact)),
            ("ConvertedPaths", integer(i64::from(fidelity.convertible_paths))),
            ("FillRegions", integer(self.fill_regions as i64)),
            ("OmittedPaints", integer(i64::from(fidelity.omitted_paints))),
            ("Omissions", text(omissions_text(fidelity))),
        ]
    }
    /// Rows this provenance adds: one property set, one relationship and one
    /// single value per property.
    pub fn reserve(&self) -> usize {
        self.properties().len() + 2
    }
    /// Author the rows after the annotation exists; returns the property set id.
    pub fn author(&self, author: &mut Author, owner: &A, annotation: u32) -> Result<u32, String> {
        let mut values = Vec::new();
        for (name, value) in self.properties() {
            super::wire_text::validate(name, "PDF provenance property name")?;
            values.push(author.add(
                IfcType::IfcPropertySingleValue,
                vec![A::String(name.into()), A::Null, value, A::Null],
            ));
        }
        let set = author.add(
            IfcType::IfcPropertySet,
            vec![
                A::String(self.request.property_set_global_id.clone()),
                owner.clone(),
                A::String(PROPERTY_SET_NAME.into()),
                A::String(format!("PDF vector conversion provenance ({})", self.prepared.fidelity.describe())),
                refs(&values),
            ],
        );
        author.add(
            IfcType::IfcRelDefinesByProperties,
            vec![
                A::String(self.request.property_relation_global_id.clone()),
                owner.clone(),
                A::Null,
                A::Null,
                refs(&[annotation]),
                A::EntityRef(set),
            ],
        );
        Ok(set)
    }
}
