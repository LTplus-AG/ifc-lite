// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Model-level ids located once per decoder by the project locator's byte
//! search and cached: the project, and the `ObjectPlacement`s of the sites.

use super::EntityDecoder;
use crate::parser::{keyword_eq, EntityScanner};
use crate::slot;

impl EntityDecoder<'_> {
    /// The model's `IFCPROJECT` express id: the first in file order, `None`
    /// when the file has none. Located once per decoder by the one locator
    /// ([`crate::find_project_id`], a SIMD keyword search) and cached, so
    /// the unit-scale resolvers share it.
    ///
    /// The byte search misses a legal `IFCPROJECT (` or `#1 /* c */ =` and
    /// can accept a record-shaped decoy in a string; the entity scan these
    /// resolvers used before does neither. So a candidate is kept only when
    /// the index holds it as an `IFCPROJECT`, else that scan decides
    /// ([`crate::project_locator::scan_for_project_id`]).
    pub fn project_id(&mut self) -> Option<u32> {
        if let Some(cached) = self.project_id_cache {
            return cached;
        }
        let located = crate::project_locator::find_project_id(self.content).filter(|&id| self.record_is(id, "IFCPROJECT"));
        let id = located.or_else(|| crate::project_locator::scan_for_project_id(self.content));
        self.project_id_cache = Some(id);
        id
    }

    /// Whether `placement_id` is the `ObjectPlacement` of an `IfcSite`. The
    /// sites come from the project locator's byte search, each confirmed as
    /// an `IFCSITE` record before its placement counts; when it confirms none,
    /// an entity scan decides, as for the project. A file without a site
    /// answers false for every id.
    pub fn is_site_placement(&mut self, placement_id: u32) -> bool {
        // Kept beside the grid axes in the source-scoped index, so decoders
        // recreated per batch over one source locate the sites once.
        if self.grid_axis_index.site_placements.get().is_none() {
            let placements = self.locate_site_placements();
            let _ = self.grid_axis_index.site_placements.set(placements);
        }
        self.grid_axis_index.site_placements.get().is_some_and(|ids| ids.contains(&placement_id))
    }

    fn locate_site_placements(&mut self) -> Vec<u32> {
        let mut sites = crate::project_locator::find_site_ids(self.content);
        sites.retain(|&id| self.record_is(id, "IFCSITE"));
        if sites.is_empty() {
            sites = crate::project_locator::scan_for_site_ids(self.content);
        }
        let placement = slot::IfcProduct::OBJECT_PLACEMENT.index();
        sites.into_iter().filter_map(|id| self.decode_by_id(id).ok()?.get_ref(placement)).collect()
    }

    /// Whether the index holds `id` as a `keyword` record: the check that
    /// confirms a byte-search hit.
    fn record_is(&mut self, id: u32, keyword: &str) -> bool {
        self.get_raw_bytes(id)
            .and_then(|raw| EntityScanner::new(raw).next_entity())
            .is_some_and(|(_, kind, _, _)| keyword_eq(kind, keyword))
    }
}
