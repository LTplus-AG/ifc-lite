// SPDX-License-Identifier: MPL-2.0
//! What the attribute export can be asked to resolve, and the placement it
//! resolves.
//!
//! Split from `model.rs` under the house rule (AGENTS.md). Keeping `Placement`
//! here also keeps its frame documentation — the part that is easy to get wrong
//! and expensive to get wrong — beside the type rather than buried in the
//! streaming pass.

/// A product's placement, composed from its `IfcLocalPlacement` chain.
///
/// **Which frame this is in**, because the crate contains three and a bare
/// `[f64; 16]` cannot tell them apart:
///
/// * **Column-major** 4×4 (nalgebra's `as_slice` order). Translation is at
///   indices 12, 13, 14 — not 3, 7, 11. The instancing path uses ROW-major
///   (`mat4_to_row_major`); this is not that.
/// * Translation is in **metres**: the file's length unit scale is applied. The
///   basis is unitless.
/// * **No RTC rebase.** Georeferenced models are shifted toward the origin for
///   f32 precision before meshing; this is not shifted.
/// * **No Z-up → Y-up conversion.** The glTF and OBJ exporters map
///   `(x, y, z) → (x, z, −y)`; this does not.
///
/// So: the IFC world frame, which is the frame the file itself is in and not the
/// frame any exporter emits. A consumer combining this with exported geometry
/// has to account for the last two itself.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placement {
    /// Column-major 4×4.
    pub matrix: [f64; 16],
}

impl Placement {
    /// The translation, in metres.
    pub fn translation(&self) -> [f64; 3] {
        [self.matrix[12], self.matrix[13], self.matrix[14]]
    }
}

/// What the export should resolve beyond the attributes it always reads.
///
/// ```
/// # use ifc_lite_export::ModelOptions;
/// let opts = ModelOptions::default().with_placements(true);
/// ```
///
/// `#[non_exhaustive]` plus builders, rather than a plain struct: this will
/// grow, and `non_exhaustive` forbids EVERY struct expression from outside this
/// crate — including `..Default::default()`, which is the one people reach for
/// to survive new fields and which does not compile here. Builders are the
/// shape that actually works for an external caller and keeps working when a
/// field is added.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct ModelOptions {
    /// Resolve each product's `ObjectPlacement` into [`EntityRow::placement`].
    ///
    /// Off by default because it is not free: the placement memo is ~128 B per
    /// distinct placement — one per product in most files, so `O(products)` on
    /// top of the entity index — and each product costs a few extra decodes of
    /// its own chain after the shared upper levels are memoized.
    pub placements: bool,
    /// Merge the property/quantity sets an occurrence inherits from its
    /// `IfcTypeObject` into [`EntityRow::property_sets`] and
    /// [`EntityRow::quantity_sets`], per property, occurrence wins.
    ///
    /// Off by default, which is NOT a claim that off is more correct. It is
    /// not: authoring tools put a great deal on types, a type carrying
    /// `Pset_WallCommon` yields no row of its own here (it only gets one when
    /// it also has orphan geometry), and the browser has resolved inheritance
    /// this way since #1913. Off is the default only because this changes what
    /// every existing CSV/JSON/IFCX/Parquet export contains, and that is a
    /// decision to take deliberately rather than as a side effect of adding
    /// the capability.
    ///
    /// It costs one extra `IfcRelDefinesByType` map in pass 1 (`O(typed
    /// occurrences)`) and one resolve per distinct type, memoized.
    ///
    /// [`EntityRow::property_sets`]: crate::model::EntityRow::property_sets
    /// [`EntityRow::quantity_sets`]: crate::model::EntityRow::quantity_sets
    pub inherit_type_properties: bool,
}

impl ModelOptions {
    /// Resolve each product's `ObjectPlacement`. See [`ModelOptions::placements`].
    #[must_use]
    pub fn with_placements(mut self, yes: bool) -> Self {
        self.placements = yes;
        self
    }

    /// Merge type-inherited property/quantity sets into each occurrence. See
    /// [`ModelOptions::inherit_type_properties`].
    #[must_use]
    pub fn with_inherit_type_properties(mut self, yes: bool) -> Self {
        self.inherit_type_properties = yes;
        self
    }
}
