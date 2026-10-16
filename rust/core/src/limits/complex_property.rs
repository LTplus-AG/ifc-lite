// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The `IfcComplexProperty` walk policy (#7675): its bounds, markers and
//! every charge, re-exported as `ifc_lite_core::limits::*`.
//!
//! The walk has three copies that must write the same value for the same
//! file: the server's data model
//! (`apps/server/src/services/data_model/property_value.rs`), the Rust STEP
//! exporter's property base (`ifc_lite_export` `step_log/base_complex.rs`)
//! and the browser's store pass (`packages/parser/src/complex-property-store.ts`
//! over `property-complex-value.ts`). The two Rust copies take every bound,
//! marker and charge from here; the TypeScript twin mirrors
//! [`ComplexPropertyBudget`] method for method, and one shared vector
//! (`packages/parser/test/fixtures/complex-property-budget-7675.json`) pins
//! all three.
//!
//! A lean file, one with no geometry to dilute the input, cuts sooner than a
//! typical model: at a 120-member shared property, or at 10 distinct
//! 256-byte texts per element over 3 000 elements.

use std::collections::HashMap;

/// How deep an `IfcComplexProperty`'s `HasProperties` walk descends. A member
/// past it is not read; its value says so with
/// [`complex_property_depth_marker`].
pub const MAX_COMPLEX_PROPERTY_DEPTH: usize = 8;

/// Nested members one top-level complex property may read across all its
/// levels. The depth cap bounds a path's LENGTH only: a member listing itself
/// `k` times is `k^8` reads. Output accumulates (the same member down two
/// branches is two real parts), so a visited set would drop real members; a
/// work budget is the right bound (AGENTS.md "Bounding walks").
pub const MAX_COMPLEX_PROPERTY_MEMBERS: usize = 1024;

/// The floor of a model's complex-property output budget
/// ([`complex_property_output_budget`]), so a small file can still carry
/// ordinary complex properties in full.
pub const COMPLEX_PROPERTY_OUTPUT_BYTES: usize = 1 << 20;

/// Output bytes a model's complex properties may cost per input byte, above
/// the [`COMPLEX_PROPERTY_OUTPUT_BYTES`] floor. The first listing of a
/// complex property costs its walk: each member's entry
/// ([`COMPLEX_PROPERTY_MEMBER_BYTES`]), name and value, its part, and the
/// joined level, about three times what it keeps. A repeat listing costs
/// only what it keeps ([`complex_property_listing_bytes`]). 16 is the
/// server's material-row policy too, and keeps one 20-member property shared
/// by 3 000 sets (the shape a de-duplicating optimiser writes, 664 KB in,
/// about 2.5 MB charged) whole with room to spare. What it binds is reuse
/// past that: one 1 KB value listed a thousand times by each of a thousand
/// properties built 685 MB from 10.7 KB (#7675); that is now the floor.
pub const COMPLEX_PROPERTY_BYTES_PER_INPUT_BYTE: usize = 16;

/// What a read member costs before its text: its `members` / `values` entry.
/// Without it a member with a name but no value would be free, and one walk
/// could retain a member object per visit for every property in the model.
pub const COMPLEX_PROPERTY_MEMBER_BYTES: usize = 16;

/// The output budget of ONE model's complex properties: `input_bytes` times
/// [`COMPLEX_PROPERTY_BYTES_PER_INPUT_BYTE`], at least
/// [`COMPLEX_PROPERTY_OUTPUT_BYTES`].
///
/// Scope, identical in every copy: one budget per model (the server's
/// extraction, the exporter's `BaseSets`, the browser's `IfcDataStore`),
/// spent on every `IfcComplexProperty` listed by an `IfcPropertySet`, in file
/// order of the sets and then `HasProperties` order. A set id is read once,
/// at its LAST record in the file, the record core's entity index resolves
/// the id to (keep-last, #7682); an earlier record with the id is not a set.
/// A complex property id is walked once, at its first listing; every later
/// listing reuses that value through [`ComplexPropertyBudget::listing`]. A
/// value is therefore the same whichever entity asks for it first, and no
/// number of entities sharing a set multiplies the output.
pub fn complex_property_output_budget(input_bytes: usize) -> usize {
    input_bytes
        .saturating_mul(COMPLEX_PROPERTY_BYTES_PER_INPUT_BYTE)
        .max(COMPLEX_PROPERTY_OUTPUT_BYTES)
}

/// What one listing of a resolved complex property keeps: its `value`, and
/// per entry of its `values` list the entry ([`COMPLEX_PROPERTY_MEMBER_BYTES`])
/// and its text. A repeat listing is charged exactly this.
pub fn complex_property_listing_bytes<S: AsRef<str>>(value: &str, values: &[S]) -> usize {
    values
        .iter()
        .fold(value.len(), |n, v| n.saturating_add(COMPLEX_PROPERTY_MEMBER_BYTES + v.as_ref().len()))
}

/// Appended to a complex property cut by [`MAX_COMPLEX_PROPERTY_DEPTH`].
pub fn complex_property_depth_marker() -> String {
    format!("(truncated: nesting deeper than {MAX_COMPLEX_PROPERTY_DEPTH} levels)")
}

/// The value of a level cut by [`ComplexPropertyBudget`]: its parts so far,
/// then this marker. The usage name is not repeated, so a reference to a
/// complex property past the budget costs the marker and nothing else. A walk
/// that keeps a member list (`values`, the browser's `members`) ends a cut
/// level's list with this marker too, so a member past the cut reads as
/// truncated rather than absent. A repeat listing refused by
/// [`ComplexPropertyBudget::listing`] reads as a cut level with no parts.
pub const COMPLEX_PROPERTY_BUDGET_MARKER: &str = "(truncated: nested properties over the walk budget)";

/// The walk state every `IfcComplexProperty` walker charges: member visits for
/// the current top-level property, output bytes for the whole model
/// ([`complex_property_output_budget`]), and how many levels it cut.
///
/// Check order, identical in every copy, and every charge is made HERE so the
/// copies cannot drift: [`Self::listing`] for each listing a set makes;
/// within a first listing's walk, [`Self::admit_member`] before reading a
/// member, [`Self::member_part`] once the member is read (charges its entry,
/// and its part when it has a display), and [`Self::level_value`] once the
/// level's members are done (charges the joined value, and only a value that
/// has parts).
#[derive(Debug, Clone)]
pub struct ComplexPropertyBudget {
    visits: usize,
    bytes_left: usize,
    cuts: usize,
}

impl ComplexPropertyBudget {
    /// A scope that may build `output_bytes` of text.
    pub fn new(output_bytes: usize) -> Self {
        Self { visits: 0, bytes_left: output_bytes, cuts: 0 }
    }

    /// The budget of one model whose source is `input_bytes` long.
    pub fn for_input(input_bytes: usize) -> Self {
        Self::new(complex_property_output_budget(input_bytes))
    }

    /// One listing of complex property `id` by a set. The first listing of an
    /// id calls `resolve`, which starts the property and walks it against
    /// this budget, and returns the value with its
    /// [`complex_property_listing_bytes`]; `memo` keeps both. A later listing
    /// reuses the value, charged its listing bytes, or reads `spent()` (a
    /// counted cut) once the budget is spent. Memoised per id, not per
    /// listing: a repeat costs what it keeps, not a fresh walk.
    ///
    /// A repeat listing is admitted while any budget is left and charged in
    /// full, so one admitted with almost nothing left overshoots: the total
    /// stays under the budget plus one listing.
    pub fn listing<V: Clone>(
        &mut self,
        memo: &mut HashMap<u32, (V, usize)>,
        id: u32,
        resolve: impl FnOnce(&mut Self) -> (V, usize),
        spent: impl FnOnce() -> V,
    ) -> V {
        if let Some((value, bytes)) = memo.get(&id) {
            if self.bytes_left == 0 {
                self.cuts += 1;
                return spent();
            }
            self.charge(*bytes);
            return value.clone();
        }
        let (value, bytes) = resolve(self);
        memo.insert(id, (value.clone(), bytes));
        value
    }

    /// Start a top-level property: its member visits start at zero, the byte
    /// budget carries on.
    pub fn start_property(&mut self) {
        self.visits = 0;
    }

    /// Whether one more member may be read, counting it if so.
    pub fn admit_member(&mut self) -> bool {
        if self.visits >= MAX_COMPLEX_PROPERTY_MEMBERS || self.bytes_left == 0 {
            return false;
        }
        self.visits += 1;
        true
    }

    /// A member that was read, under `name` (empty without one) with
    /// `display` (empty when it has no value): charge its entry, and return
    /// the `"Name: value"` part (bare `value` without a name), charged too,
    /// or `None` when there is no display to show. A member without a name is
    /// still read for its value, in every copy.
    pub fn member_part(&mut self, name: &str, display: &str) -> Option<String> {
        self.charge(COMPLEX_PROPERTY_MEMBER_BYTES + name.len() + display.len());
        if display.is_empty() {
            return None;
        }
        let part = if name.is_empty() { display.to_string() } else { format!("{name}: {display}") };
        self.charge(part.len());
        Some(part)
    }

    /// A level's value from its parts, `cut` when [`Self::admit_member`]
    /// refused one of its members: the parts joined with `", "` (then the
    /// budget marker when cut), the bare marker when cut with no parts, or
    /// `None` (the caller's bare `UsageName`) when nothing resolved. Only a
    /// value with parts is charged; the bare marker is bounded by the members
    /// admitted to reach it.
    pub fn level_value(&mut self, parts: &[String], cut: bool) -> Option<String> {
        if cut {
            self.cuts += 1;
        }
        if parts.is_empty() {
            return cut.then(|| COMPLEX_PROPERTY_BUDGET_MARKER.to_string());
        }
        let joined = parts.join(", ");
        let value = if cut { format!("{joined} {COMPLEX_PROPERTY_BUDGET_MARKER}") } else { joined };
        self.charge(value.len());
        Some(value)
    }

    /// Levels and listings this budget has cut so far (D3: counted, and
    /// logged by the walk's owner, never silent).
    pub fn cuts(&self) -> usize {
        self.cuts
    }

    fn charge(&mut self, bytes: usize) {
        self.bytes_left = self.bytes_left.saturating_sub(bytes);
    }
}

#[cfg(test)]
#[path = "complex_property_tests.rs"]
mod tests;
