// SPDX-License-Identifier: MPL-2.0
//! The STEP exporter's public vocabulary: what a caller asks for
//! ([`StepOptions`] and the three mutation kinds) and what it gets told
//! afterwards ([`StepStats`]).
//!
//! Split out of `step.rs` for the module-size ratchet
//! (`rust/processing/tests/module_size_ratchet.rs`), the same way the text
//! primitives went to `step_text.rs` and the copy-on-write pass to
//! `step_cow.rs`. `step.rs` was 399 lines against a 400-line limit, so the next
//! change to it had to move something out, and these five declaration-only
//! types were the coherent thing to move: no behaviour, no dependency on the
//! export loop, and one theme between them.
//!
//! No CALLER can see the split, and the header does not claim otherwise:
//! `step.rs` re-exports all five (so `crate::step::StepOptions` and every other
//! existing path still resolves) and `lib.rs` already exported them from the
//! crate root. The benefit is to the ratchet and to whoever next reads
//! `step.rs`, not to the interface.

/// A single root-attribute edit: replace the top-level attribute at `index` of entity
/// `express_id` with `value` (already STEP-serialized, e.g. `'New Name'` or `$`).
/// This is the wasm-bridge form of a `MutablePropertyView` UPDATE_ATTRIBUTE mutation.
pub struct AttrMutation {
    pub express_id: u32,
    pub index: usize,
    pub value: String,
}

/// A property create/update: attach (or overwrite) `prop_name` in `pset_name` on
/// `express_id` with `value` — the STEP-serialized nominal value, e.g. `IFCLABEL('2HR')`
/// or `IFCREAL(42.)`. The wasm-bridge form of a `MutablePropertyView` CREATE/UPDATE_PROPERTY.
/// Synthesizes fresh `IfcPropertySingleValue` / `IfcPropertySet` / `IfcRelDefinesByProperties`
/// entities appended to DATA (new psets; merge-into-existing is a follow-on).
pub struct PropMutation {
    pub express_id: u32,
    pub pset_name: String,
    pub prop_name: String,
    pub value: String,
}

/// Replace one attribute of a record that other records share, by copying the
/// record and repointing a single referrer at the copy.
///
/// The reason this is a writer job rather than a caller one is the id. A copy
/// needs a number no record holds, and the writer is what knows `max_id`; a
/// caller that allocates its own has to agree with `PropMutation`'s synthesis
/// about which numbers are free, and two allocators sharing one space is a
/// collision waiting for the first export that uses both.
///
/// Doing it here also keeps the copy inside the emit path, so it is counted in
/// [`StepStats::written`] and converted when the export targets another schema.
/// A record spliced into the output afterwards is neither.
///
/// Property sets are the case this exists for. IFC exporters routinely give
/// each element its own `IfcPropertySet` and point them all at one
/// `IfcPropertySingleValue` per distinct value, so editing that value in place
/// changes it for every element sharing it. Copying first changes one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopyOnWriteMutation {
    /// The record to copy.
    pub express_id: u32,
    /// Which attribute of the copy to replace, zero-based.
    pub index: usize,
    /// The replacement, STEP-serialized, e.g. `IFCLABEL('2HR')`.
    pub value: String,
    /// The record that should point at the copy instead of the original.
    pub referrer_id: u32,
    /// Which attribute of the referrer holds that reference. A list attribute
    /// is rewritten with the one reference substituted and the rest untouched.
    pub referrer_index: usize,
}

/// Options for STEP export.
#[derive(Default)]
pub struct StepOptions {
    /// FILE_SCHEMA label to write (e.g. `IFC4`). `None` ⇒ preserve the source schema.
    /// When `Some` and the target differs, entity types/attributes are converted (P2).
    pub schema: Option<String>,
    /// Express ids to include. `None` ⇒ the whole model. When set, the forward
    /// reference closure is added so every emitted `#ref` resolves.
    pub included: Option<Vec<u32>>,
    /// Root-attribute edits to apply during serialization (P3 mutation bridge).
    pub attribute_mutations: Vec<AttrMutation>,
    /// Property create/update edits — synthesized as new pset entities appended to DATA.
    pub property_mutations: Vec<PropMutation>,
    /// Copy-then-edit mutations for records other records share.
    pub copy_on_write: Vec<CopyOnWriteMutation>,
    /// `FILE_DESCRIPTION` item. `None` ⇒ keep the source file's items, and
    /// fall back to the generic view-definition default only when the source
    /// carried none.
    pub description: Option<String>,
    /// `FILE_NAME` author. `None` ⇒ keep the source file's.
    pub author: Option<String>,
    /// `FILE_NAME` organization. `None` ⇒ keep the source file's.
    pub organization: Option<String>,
    /// `FILE_NAME` preprocessor_version — the tool writing this file.
    /// `None` ⇒ `ifc-lite`.
    pub application: Option<String>,
    /// `FILE_NAME` name. `None` ⇒ `export.ifc`.
    pub filename: Option<String>,
    /// `FILE_NAME` time_stamp. `None` ⇒ the source file's stamp. There is no
    /// clock fallback: `SystemTime::now` is unavailable on the
    /// `wasm32-unknown-unknown` target this exporter ships to, so a caller that
    /// wants "now" states it.
    pub time_stamp: Option<String>,
}

/// Coverage stats for a STEP export.
pub struct StepStats {
    /// Entities in the source model.
    pub total: usize,
    /// Entities written (after filtering + reference closure).
    pub written: usize,
    /// Copy-on-write mutations the file could not express, so none was made.
    /// Non-zero means an edit the caller asked for is not in the output, and
    /// the caller is the only one who can say what to do about it.
    pub copies_refused: usize,
    /// `#<digits>` references above `u32::MAX` refused (issue #3421) while
    /// resolving a filtered export's reference closure. The referenced record
    /// could never itself be a real entity, so this excludes nothing
    /// reachable — it only says the source has an id ifc-lite can't hold (#3752).
    pub refused_refs: usize,
    /// Records whose root-attribute edits could not be applied because the
    /// record's own argument list did not scan into slots, so the line was
    /// emitted as the source wrote it (issue #4125). Non-zero means an edit the
    /// caller asked for is not in the output. Counted rather than left as an
    /// unchanged line, because a refusal that looks like a successful no-op is
    /// the failure this whole family is about: writing by index into a
    /// mis-scanned list lands on the wrong attribute and reports success.
    pub attribute_edits_refused: usize,
}
