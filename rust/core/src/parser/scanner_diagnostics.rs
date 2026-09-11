// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! What an [`EntityScanner`](super::EntityScanner) scan DROPPED, and why.
//!
//! A sibling file for the same reason `scanner_header.rs` and
//! `scanner_attributes.rs` are: `scanner.rs` is at its `module_size_ratchet`
//! budget, and these four accessors share no control flow with the record
//! hunt. They are the reporting surface, and the reasoning they carry (why
//! each is a `Vec` of offsets rather than a count, and why a SHARDED caller
//! needs the offsets) is the same argument twice, so it belongs in one place.

impl<'a> super::EntityScanner<'a> {
    /// How many records this scanner has skipped because their instance name
    /// does not fit `u32` (issue #3395).
    ///
    /// ISO 10303-21 puts no upper bound on `#<digits>`, but every express-id
    /// column in this workspace is `u32` (`ColumnarIndex::ids`,
    /// `MeshData::express_id`, the wasm `express_ids` buffers), so a wider id
    /// cannot be represented — it used to wrap, making `#4294967297`
    /// indistinguishable from `#1`. The record is dropped instead, and this
    /// counter is the other half of that guard: callers report it rather than
    /// letting the model come back quietly short.
    pub fn skipped_oversized_ids(&self) -> usize {
        self.skipped_oversized_id_starts.len()
    }

    /// The `line_start` byte offset of every record this scanner refused,
    /// strictly increasing.
    ///
    /// A whole-file scan only needs the count above. A SHARDED scan needs the
    /// offsets, and the difference is not cosmetic: shard `i > 0` starts at an
    /// arbitrary byte, so it can begin inside a quoted value and parse a
    /// string literal such as `'…#4294967297=IFCWALL(…'` as a record — and
    /// refuse it. That refusal is an artefact of where the shard started, not
    /// a record the file declares, so a count alone would let a file with
    /// NOTHING oversized in it be reported as incomplete. The offset lets the
    /// stitch keep only the refusals inside the byte region it actually
    /// retained from that shard (issue #3395/#3430).
    pub fn skipped_oversized_id_starts(&self) -> &[usize] {
        &self.skipped_oversized_id_starts
    }

    /// The first record this scan dropped for having no terminator of its own,
    /// or `None`. See [`Self::malformed_record_starts`].
    pub fn malformed_record_start(&self) -> Option<usize> {
        self.malformed_record_starts.first().copied()
    }

    /// The `line_start` of EVERY record this scan dropped for having no
    /// terminator of its own, strictly increasing.
    ///
    /// A REPORT, not a stop signal: a record merely missing its `;` is dropped
    /// and the scan CONTINUES past the `)` closing its parameter list (#4179).
    /// Ask [`position`](Self::position), not this, whether a scan finished.
    ///
    /// A `Vec` for the reason
    /// [`skipped_oversized_id_starts`](Self::skipped_oversized_id_starts) is
    /// one, which recovery made load-bearing: a SHARDED scan can now hit a
    /// speculative drop inside a quoted value AND a real one after it, and
    /// keeping only the first made the stitch's "inside my retained region"
    /// filter test the speculative offset and discard the real report with it.
    pub fn malformed_record_starts(&self) -> &[usize] {
        &self.malformed_record_starts
    }
}
