// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! What a sparse worker cannot find by walking references forward from its
//! jobs, collected by the one pass that does see every record (out-of-core
//! ingest):
//!
//! - records the mesh path finds by scanning for a type (`IFCPROJECT` and its
//!   units, the geometric contexts, `IFCSITE`, `IFCGRID`): they become the
//!   preamble every worker starts from;
//! - records that reference geometry rather than being referenced by it
//!   (indexed colour and texture maps): they become inverse edges, so the map
//!   travels with its face set.

use ifc_lite_core::{keyword_eq, parser::StepRecord};

#[derive(Default)]
pub(super) struct SparseFacts {
    /// Installed with everything they reference.
    closure_roots: Vec<u32>,
    /// Installed alone: only the record itself is read by a type scan.
    record_roots: Vec<u32>,
    pub(super) inverse_targets: Vec<u32>,
    pub(super) inverse_referrers: Vec<u32>,
    /// Why this file cannot be meshed from a sparse arena, when it cannot.
    pub(super) unsupported: Option<&'static str>,
    /// Records seen by the scan.
    records: usize,
}

impl SparseFacts {
    /// Called for every record of the scan, in file order.
    #[inline]
    pub(super) fn observe(&mut self, content: &[u8], id: u32, kw: &str, start: usize, end: usize) {
        self.records += 1;
        let bytes = kw.as_bytes();
        // Every keyword of interest is `IFC` + one of A/G/I/P/S: one byte test
        // rejects almost all records before any comparison.
        let Some(&lead) = bytes.get(3) else { return };
        match lead.to_ascii_uppercase() {
            // A fill area's styles are found by scanning the source for the styled items that name it
            // (`router::annotation_style`): an arena holds none, so it would admit fills the whole file refuses.
            b'A' if keyword_eq(kw, "IFCANNOTATIONFILLAREA") => self.unsupported = Some("annotation fill areas"),
            b'P' if keyword_eq(kw, "IFCPROJECT") => self.closure_roots.push(id),
            b'S' if keyword_eq(kw, "IFCSITE") => self.record_roots.push(id),
            b'G' if keyword_eq(kw, "IFCGRID") => self.record_roots.push(id),
            b'G' if keyword_eq(kw, "IFCGEOMETRICREPRESENTATIONCONTEXT")
                || keyword_eq(kw, "IFCGEOMETRICREPRESENTATIONSUBCONTEXT") =>
            {
                self.closure_roots.push(id)
            }
            // `MappedTo` is the first attribute of a colour map and the second
            // of a texture map (whose first is the list of textures).
            b'I' if keyword_eq(kw, "IFCINDEXEDCOLOURMAP") => self.inverse_edge(content, id, start, end, 0),
            b'I' if keyword_eq(kw, "IFCINDEXEDTRIANGLETEXTUREMAP") => self.inverse_edge(content, id, start, end, 1),
            _ => {}
        }
    }

    fn inverse_edge(&mut self, content: &[u8], id: u32, start: usize, end: usize, mapped_to: usize) {
        let target = content.get(start..end).and_then(StepRecord::parse).and_then(|record| record.ref_at(mapped_to));
        if let Some(target) = target {
            self.inverse_targets.push(target);
            self.inverse_referrers.push(id);
        }
    }

    /// The reason this file stays on the whole-file path, given the index built from the same scan.
    ///
    /// An arena holds one record per id, as the index does. A file whose scan saw more records than
    /// the index holds reuses an id (or has ids the index refuses): the whole-file path meshes each
    /// job at its own span there, which an arena cannot reproduce.
    pub(super) fn refusal(&self, indexed_records: usize) -> Option<&'static str> {
        self.unsupported.or((self.records != indexed_records).then_some("entity ids that are reused or not indexed"))
    }

    pub(super) fn preamble(
        &self,
        content: &[u8],
        lookup: impl Fn(u32) -> Option<(usize, usize)>,
    ) -> Vec<u8> {
        ifc_lite_core::build_sparse_preamble(content, lookup, &self.closure_roots, &self.record_roots)
    }
}

#[cfg(test)]
mod tests {
    use super::SparseFacts;

    #[test]
    fn a_file_with_annotation_fill_areas_is_named_unsupported() {
        let record = b"#5=IFCANNOTATIONFILLAREA(#6,$);";
        let mut facts = SparseFacts::default();
        facts.observe(record, 4, "IFCANNOTATIONOCCURRENCE", 0, record.len());
        facts.observe(record, 7, "IFCAXIS2PLACEMENT3D", 0, record.len());
        assert_eq!(facts.unsupported, None);
        facts.observe(record, 5, "IfcAnnotationFillArea", 0, record.len());
        assert_eq!(facts.unsupported, Some("annotation fill areas"));
        assert_eq!(facts.refusal(3), Some("annotation fill areas"));
    }

    #[test]
    fn a_scan_that_saw_more_records_than_the_index_holds_is_named_unsupported() {
        let record = b"#5=IFCWALL($);";
        let mut facts = SparseFacts::default();
        facts.observe(record, 5, "IFCWALL", 0, record.len());
        facts.observe(record, 5, "IFCSLAB", 0, record.len());
        assert_eq!(facts.refusal(2), None);
        assert_eq!(facts.refusal(1), Some("entity ids that are reused or not indexed"));
    }
}
