// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Source-schema attribute layout and the IfcGridAxis -> IfcGrid inverse.
//!
//! The canonical [`crate::IfcType`] is the IFC4X3 universe, but an entity's
//! attribute POSITIONS are defined by the schema the file declares. Most
//! geometry entities share one layout across IFC2X3/IFC4/IFC4X3, so readers
//! index them directly; the few that moved (IfcGridPlacement gained the
//! inherited `PlacementRelTo` in IFC4X1) must ask here instead of hard-coding
//! an offset, or an IFC2X3/IFC4 file is read one slot out (#6232 F2).

use super::{EntityDecoder, EntityScanner};
use crate::generated::schema_registry::SchemaVersion;
use rustc_hash::FxHashMap;
use std::sync::{Arc, OnceLock};

/// Source-scoped, lazily built `IfcGridAxis` id -> owning `IfcGrid` id map.
///
/// Opaque and shareable: every decoder over one source may hold the same
/// `Arc<GridAxisIndex>` ([`EntityDecoder::set_grid_axis_index`]), so the one
/// scan that builds it is paid once per source rather than once per
/// per-element decoder. The columnar and dense entity indexes carry one and
/// install it with themselves.
#[derive(Debug, Default)]
pub struct GridAxisIndex(OnceLock<FxHashMap<u32, u32>>);

impl EntityDecoder<'_> {
    /// The EXPRESS schema this source declares in its `FILE_SCHEMA` header,
    /// read from a bounded header window on first use and cached. `None` when
    /// no declared identifier names a bundled schema family.
    pub(crate) fn schema_version(&mut self) -> Option<SchemaVersion> {
        if let Some(cached) = self.schema_version_cache {
            return cached;
        }
        let version = crate::parser::header::declared_schemas_bounded(self.content)
            .iter()
            .find_map(|label| SchemaVersion::from_file_schema(label));
        self.schema_version_cache = Some(version);
        version
    }

    /// Position of `attribute` in `entity_name`'s record under this source's
    /// schema. A source whose schema is undeclared or unknown is read with the
    /// canonical IFC4X3 layout (the same universe [`crate::IfcType`] uses).
    /// `None` when the entity or attribute does not exist in that schema, e.g.
    /// `IfcGridPlacement.PlacementRelTo` on IFC2X3/IFC4.
    pub fn attribute_index(&mut self, entity_name: &str, attribute: &str) -> Option<usize> {
        let schema = self.schema_version().unwrap_or(SchemaVersion::Ifc4x3);
        schema
            .attribute_names(entity_name)?
            .iter()
            .position(|name| name.eq_ignore_ascii_case(attribute))
    }

    /// The `IfcGrid` that lists `axis_id` among its `UAxes`/`VAxes`/`WAxes`
    /// (the inverse `PartOfU`/`PartOfV`/`PartOfW`). An axis claimed by more
    /// than one grid resolves to the first in file order.
    ///
    /// Built by one scan over the source the first time a caller asks (nothing
    /// asks unless it met an IFC2X3/IFC4 grid placement), into this decoder's
    /// [`GridAxisIndex`], which may be shared across decoders of one source.
    pub fn grid_of_axis(&mut self, axis_id: u32) -> Option<u32> {
        let slots: Vec<usize> = ["UAxes", "VAxes", "WAxes"]
            .iter()
            .filter_map(|name| self.attribute_index("IfcGrid", name))
            .collect();
        self.grid_axis_index
            .0
            .get_or_init(|| self.build_grid_axis_owners(&slots))
            .get(&axis_id)
            .copied()
    }

    /// Share one source's [`GridAxisIndex`] with this decoder. The index must
    /// belong to this decoder's source bytes; installing a columnar or dense
    /// entity index installs that index's own.
    pub fn set_grid_axis_index(&mut self, index: Arc<GridAxisIndex>) {
        self.grid_axis_index = index;
    }

    fn build_grid_axis_owners(&self, axis_slots: &[usize]) -> FxHashMap<u32, u32> {
        let mut owners = FxHashMap::default();
        let mut scanner = EntityScanner::new(self.content);
        while let Some((id, type_name, start, end)) = scanner.next_entity() {
            // Raw keyword slice; STEP keywords are case-insensitive (#4497).
            if !type_name.eq_ignore_ascii_case("IFCGRID") {
                continue;
            }
            let Ok(grid) = self.decode_at_uncached(start, end) else {
                continue;
            };
            for &slot in axis_slots {
                for axis in grid.get_refs(slot).unwrap_or_default() {
                    owners.entry(axis).or_insert(id);
                }
            }
        }
        owners
    }
}

#[cfg(test)]
mod tests {
    use super::GridAxisIndex;
    use crate::{ColumnarEntityIndex, EntityDecoder};
    use std::sync::Arc;

    fn source(schema: &str) -> String {
        format!(
            "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('{schema}'));\nENDSEC;\nDATA;\n\
#1=IFCGRIDAXIS('A',$,.T.);\n#2=IFCGRIDAXIS('1',$,.T.);\n#3=IFCGRIDAXIS('X',$,.T.);\n\
#9=IfcGrid('g',$,$,$,$,$,$,(#1),(#2),$);\nENDSEC;\nEND-ISO-10303-21;\n"
        )
    }

    #[test]
    fn grid_placement_layout_follows_the_declared_schema() {
        for (schema, rel_to, location, ref_dir) in [
            ("IFC2X3", None, Some(0), Some(1)),
            ("IFC4", None, Some(0), Some(1)),
            ("IFC4X3_ADD2", Some(0), Some(1), Some(2)),
            ("NOT_A_SCHEMA", Some(0), Some(1), Some(2)),
        ] {
            let content = source(schema);
            let mut decoder = EntityDecoder::new(&content);
            assert_eq!(
                decoder.attribute_index("IfcGridPlacement", "PlacementRelTo"),
                rel_to,
                "{schema}"
            );
            assert_eq!(
                decoder.attribute_index("IfcGridPlacement", "PlacementLocation"),
                location,
                "{schema}"
            );
            assert_eq!(
                decoder.attribute_index("IfcGridPlacement", "PlacementRefDirection"),
                ref_dir,
                "{schema}"
            );
        }
    }

    #[test]
    fn grid_of_axis_is_the_inverse_of_the_grid_axis_lists() {
        let content = source("IFC4");
        let mut decoder = EntityDecoder::new(&content);
        assert_eq!(decoder.grid_of_axis(1), Some(9), "U axis");
        assert_eq!(decoder.grid_of_axis(2), Some(9), "V axis");
        assert_eq!(decoder.grid_of_axis(3), None, "an axis no grid lists");
    }

    #[test]
    fn grid_axis_owners_are_shared_through_the_columnar_index() {
        let content = source("IFC2X3");
        let index = Arc::new(ColumnarEntityIndex::from_scan(content.as_bytes()));
        let mut first = EntityDecoder::with_arc_columnar_index(&content, index.clone());
        assert_eq!(first.grid_of_axis(1), Some(9));
        drop(first);
        assert!(
            index.grid_axis_index.0.get().is_some(),
            "built once per source, not per decoder"
        );
        let mut second = EntityDecoder::with_arc_columnar_index(&content, index);
        assert_eq!(second.grid_of_axis(2), Some(9));
    }

    #[test]
    fn a_shared_grid_axis_index_is_built_once_across_decoders() {
        let content = source("IFC4");
        let shared = Arc::new(GridAxisIndex::default());
        let mut first = EntityDecoder::new(&content);
        first.set_grid_axis_index(shared.clone());
        assert_eq!(first.grid_of_axis(1), Some(9));
        assert!(shared.0.get().is_some());
        // A second decoder over the same source reads the shared map; prove it
        // by handing it a source with no grid at all.
        let empty = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\nENDSEC;\n";
        let mut second = EntityDecoder::new(empty);
        second.set_grid_axis_index(shared);
        assert_eq!(second.grid_of_axis(2), Some(9));
    }
}
