// SPDX-License-Identifier: MPL-2.0
//! Spatial-structure unification for merged export. Ports `buildSpatialLookup`,
//! `unifySpatialEntities` and `matchRootContainer` from `merged-exporter.ts`:
//! match a later model's `IfcSite` / `IfcBuilding` / `IfcBuildingStorey` onto the
//! first model's so the federation shares one spatial tree instead of stacking N
//! disjoint ones.
//!
//! Matching is by lowercased `Name` (attribute 2) and — for storeys — a fallback
//! on `Elevation` (attribute 9) within a tolerance. All extraction is text-level
//! against the raw STEP line, mirroring the JS which also has no schema table.

use std::collections::HashMap;

/// Strategy for matching a later model's `IfcSite` / `IfcBuilding` onto the first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum ContainerMergeStrategy {
    /// Only unify when both models declare exactly one instance.
    Single,
    /// Unify by lowercased `Name`.
    ByName,
    /// Name first, single-instance fallback (JS default when the option is omitted).
    #[default]
    NameThenSingle,
}

/// Strategy for matching a later model's `IfcBuildingStorey` onto the first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum StoreyMergeStrategy {
    /// Match by lowercased `Name` only.
    ByName,
    /// Match by `Elevation` only (within tolerance).
    ByElevation,
    /// Name first, elevation fallback (JS default).
    #[default]
    ByNameThenElevation,
}

/// First-model spatial index used to match later models' containers onto it.
#[derive(Default)]
pub struct SpatialLookup {
    sites_by_name: HashMap<String, u32>,
    buildings_by_name: HashMap<String, u32>,
    storeys_by_name: HashMap<String, u32>,
    storeys_by_elevation: Vec<(u32, f64)>,
    site_ids: Vec<u32>,
    building_ids: Vec<u32>,
}

/// Extract the trimmed content of the 0-based top-level attribute `n` of a STEP
/// entity line (`#id=TYPE(a,b,c,…);`), honouring quoted strings and nested
/// parentheses. Returns `None` when the line has no argument list or `n` is out
/// of range.
pub fn nth_attr(line: &str, n: usize) -> Option<&str> {
    let bytes = line.as_bytes();
    let open = bytes.iter().position(|&b| b == b'(')?;
    let mut depth = 0i32;
    let mut in_string = false;
    let mut idx = 0usize;
    let mut arg_start = open + 1;
    let mut i = open;
    while i < bytes.len() {
        let c = bytes[i];
        if in_string {
            if c == b'\'' {
                if bytes.get(i + 1) == Some(&b'\'') {
                    i += 2;
                    continue;
                }
                in_string = false;
            }
            i += 1;
            continue;
        }
        match c {
            b'\'' => in_string = true,
            b'(' => {
                depth += 1;
                if depth == 1 {
                    arg_start = i + 1;
                }
            }
            b')' => {
                depth -= 1;
                if depth == 0 {
                    if idx == n {
                        return Some(line[arg_start..i].trim());
                    }
                    return None;
                }
            }
            b',' if depth == 1 => {
                if idx == n {
                    return Some(line[arg_start..i].trim());
                }
                idx += 1;
                arg_start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// The `Name` (attribute 2) of a rooted entity, lowercased for matching. Returns
/// `None` when the attribute is null (`$`) or not a quoted string.
pub fn entity_name(line: &str) -> Option<String> {
    let raw = nth_attr(line, 2)?;
    if raw == "$" || raw == "*" || !raw.starts_with('\'') || !raw.ends_with('\'') || raw.len() < 2 {
        return None;
    }
    // Unquote and un-double `''` → `'`; keep other bytes verbatim (both the first
    // model and later models decode identically, so matching stays consistent).
    let inner = &raw[1..raw.len() - 1];
    Some(inner.replace("''", "'").to_lowercase())
}

/// The `Elevation` (attribute 9) of an `IfcBuildingStorey`, if numeric.
pub fn storey_elevation(line: &str) -> Option<f64> {
    let raw = nth_attr(line, 9)?;
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "$" || trimmed == "*" {
        return None;
    }
    trimmed.parse::<f64>().ok()
}

impl SpatialLookup {
    /// Build the first-model spatial index from `entities` (id → raw line text).
    /// `order` gives the scan order so name-map "last wins" matches the JS `Map`.
    pub fn build(order: &[u32], line_of: &dyn Fn(u32) -> Option<String>, type_of: &dyn Fn(u32) -> Option<String>) -> Self {
        let mut lookup = SpatialLookup::default();
        for &id in order {
            let Some(type_upper) = type_of(id) else { continue };
            match type_upper.as_str() {
                "IFCSITE" => {
                    lookup.site_ids.push(id);
                    if let Some(line) = line_of(id) {
                        if let Some(name) = entity_name(&line) {
                            lookup.sites_by_name.insert(name, id);
                        }
                    }
                }
                "IFCBUILDING" => {
                    lookup.building_ids.push(id);
                    if let Some(line) = line_of(id) {
                        if let Some(name) = entity_name(&line) {
                            lookup.buildings_by_name.insert(name, id);
                        }
                    }
                }
                "IFCBUILDINGSTOREY" => {
                    if let Some(line) = line_of(id) {
                        if let Some(name) = entity_name(&line) {
                            lookup.storeys_by_name.insert(name, id);
                        }
                        if let Some(elev) = storey_elevation(&line) {
                            lookup.storeys_by_elevation.push((id, elev));
                        }
                    }
                }
                _ => {}
            }
        }
        lookup
    }

    /// Match a later model's site/building `line` onto a first-model container.
    /// `first_ids` / `by_name` select the site-or-building index. `count_in_model`
    /// is how many of this type the later model has (for the single-instance
    /// rule). `matched` records first-model ids already claimed this model.
    fn match_container(
        &self,
        line: &str,
        first_ids: &[u32],
        by_name: &HashMap<String, u32>,
        count_in_model: usize,
        matched: &std::collections::HashSet<u32>,
        strategy: ContainerMergeStrategy,
    ) -> Option<u32> {
        let by_name_match = || -> Option<u32> {
            let name = entity_name(line)?;
            let candidate = *by_name.get(&name)?;
            (!matched.contains(&candidate)).then_some(candidate)
        };
        let by_single = || -> Option<u32> {
            if count_in_model == 1 && first_ids.len() == 1 {
                let candidate = first_ids[0];
                return (!matched.contains(&candidate)).then_some(candidate);
            }
            None
        };
        match strategy {
            ContainerMergeStrategy::Single => by_single(),
            ContainerMergeStrategy::ByName => by_name_match(),
            ContainerMergeStrategy::NameThenSingle => by_name_match().or_else(by_single),
        }
    }

    /// Match a later model's site `line`; see [`Self::match_container`].
    pub fn match_site(
        &self,
        line: &str,
        count_in_model: usize,
        matched: &std::collections::HashSet<u32>,
        strategy: ContainerMergeStrategy,
    ) -> Option<u32> {
        self.match_container(line, &self.site_ids, &self.sites_by_name, count_in_model, matched, strategy)
    }

    /// Match a later model's building `line`; see [`Self::match_container`].
    pub fn match_building(
        &self,
        line: &str,
        count_in_model: usize,
        matched: &std::collections::HashSet<u32>,
        strategy: ContainerMergeStrategy,
    ) -> Option<u32> {
        self.match_container(line, &self.building_ids, &self.buildings_by_name, count_in_model, matched, strategy)
    }

    /// Match a later model's storey `line` onto a first-model storey. Name first
    /// (unless `ByElevation`), then an elevation fallback (unless `ByName`) with
    /// tolerance `max(0.5, |elevation|·0.01)` in first-model units;
    /// `elevation_factor` rescales the later model's elevation into the primary
    /// unit under normalization (1.0 otherwise).
    pub fn match_storey(
        &self,
        line: &str,
        matched: &std::collections::HashSet<u32>,
        strategy: StoreyMergeStrategy,
        elevation_factor: f64,
    ) -> Option<u32> {
        if strategy != StoreyMergeStrategy::ByElevation {
            if let Some(name) = entity_name(line) {
                if let Some(&candidate) = self.storeys_by_name.get(&name) {
                    if !matched.contains(&candidate) {
                        return Some(candidate);
                    }
                }
            }
        }
        if strategy == StoreyMergeStrategy::ByName {
            return None;
        }
        let elevation = storey_elevation(line)? * elevation_factor;
        for &(id, entry_elev) in &self.storeys_by_elevation {
            if matched.contains(&id) {
                continue;
            }
            let tolerance = 0.5f64.max(entry_elev.abs() * 0.01);
            if (elevation - entry_elev).abs() <= tolerance {
                return Some(id);
            }
        }
        None
    }
}

#[cfg(test)]
mod spatial_tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn nth_attr_handles_strings_and_nested_lists() {
        let line = "#5=IFCBUILDINGSTOREY('guid',#6,'Level 1',$,$,#7,$,$,.ELEMENT.,3000.);";
        assert_eq!(nth_attr(line, 0), Some("'guid'"));
        assert_eq!(nth_attr(line, 2), Some("'Level 1'"));
        assert_eq!(nth_attr(line, 9), Some("3000."));
        let nested = "#1=IFCFOO('a',(#2,#3),$);";
        assert_eq!(nth_attr(nested, 1), Some("(#2,#3)"));
    }

    #[test]
    fn nth_attr_ignores_commas_and_parens_inside_strings() {
        let line = "#1=IFCFOO('a,b (c)',#2,'x');";
        assert_eq!(nth_attr(line, 0), Some("'a,b (c)'"));
        assert_eq!(nth_attr(line, 1), Some("#2"));
        assert_eq!(nth_attr(line, 2), Some("'x'"));
    }

    #[test]
    fn entity_name_lowercases_and_unquotes() {
        let line = "#5=IFCSITE('g',$,'Main SITE',$,$,$,$,$,$);";
        assert_eq!(entity_name(line).as_deref(), Some("main site"));
        let null_name = "#5=IFCSITE('g',$,$,$,$,$,$,$,$);";
        assert_eq!(entity_name(null_name), None);
    }

    #[test]
    fn storey_matches_by_name_then_elevation() {
        let first_storey = "#10=IFCBUILDINGSTOREY('g',$,'Level 1',$,$,#1,$,$,.ELEMENT.,0.);";
        let lookup = SpatialLookup {
            storeys_by_name: HashMap::from([("level 1".to_string(), 10u32)]),
            storeys_by_elevation: vec![(10, 0.0), (11, 3000.0)],
            ..Default::default()
        };
        let matched = HashSet::new();
        // Name hit.
        let by_name_line = "#20=IFCBUILDINGSTOREY('g2',$,'Level 1',$,$,#2,$,$,.ELEMENT.,5.);";
        assert_eq!(
            lookup.match_storey(by_name_line, &matched, StoreyMergeStrategy::ByNameThenElevation, 1.0),
            Some(10)
        );
        // No name hit, elevation within tolerance of the 3000 storey.
        let by_elev_line = "#21=IFCBUILDINGSTOREY('g3',$,'Second',$,$,#3,$,$,.ELEMENT.,3000.2);";
        assert_eq!(
            lookup.match_storey(by_elev_line, &matched, StoreyMergeStrategy::ByNameThenElevation, 1.0),
            Some(11)
        );
        // by-name only → no elevation fallback.
        assert_eq!(
            lookup.match_storey(by_elev_line, &matched, StoreyMergeStrategy::ByName, 1.0),
            None
        );
        let _ = first_storey;
    }

    #[test]
    fn site_matches_single_and_by_name() {
        let lookup = SpatialLookup {
            site_ids: vec![7],
            sites_by_name: HashMap::from([("terrain".to_string(), 7u32)]),
            ..Default::default()
        };
        let matched = HashSet::new();
        let named = "#30=IFCSITE('g',$,'Terrain',$,$,$,$,$,$);";
        assert_eq!(lookup.match_site(named, 1, &matched, ContainerMergeStrategy::ByName), Some(7));
        let unnamed = "#30=IFCSITE('g',$,$,$,$,$,$,$,$);";
        // No name → single fallback (default) still matches the lone site.
        assert_eq!(
            lookup.match_site(unnamed, 1, &matched, ContainerMergeStrategy::NameThenSingle),
            Some(7)
        );
        // Single strategy with two sites in this model → no match.
        assert_eq!(lookup.match_site(unnamed, 2, &matched, ContainerMergeStrategy::Single), None);
    }
}
