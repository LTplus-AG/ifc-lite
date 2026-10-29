// SPDX-License-Identifier: MPL-2.0
//! The M11-A per-key appearance gate as a pure function over observed looks, so its failure modes are
//! testable without a kernel. Exact is the colour authority: for every `(product, geometry_item_id)` key the
//! retained parts must carry exactly the multiset of looks exact emits, in both directions. A set would let
//! one look stand in for a missing one (glass rendered twice where the source says glass and frame).
use std::collections::BTreeMap;

pub type Key = (u32, Option<u32>);
/// Bitwise RGBA and the authored material name.
pub type Look = ([u32; 4], Option<String>);
/// A multiset of looks: how many meshes (exact) or parts (retained) carry each.
pub type Looks = BTreeMap<Look, usize>;

pub fn add(looks: &mut Looks, look: Look) { *looks.entry(look).or_default() += 1; }

/// A key whose exact meshes and retained parts legitimately differ in how many pieces carry the same
/// looks (one side splits a body the other keeps whole). It never excuses a missing or extra look.
pub struct Split {
    pub model: &'static str,
    pub product: u32,
    pub item: Option<u32>,
    #[allow(dead_code)] // the audit trail for the exception; the comparator needs only the key
    pub reason: &'static str,
}

pub fn violations(model: &str, product: u32, ours: &BTreeMap<Option<u32>, Looks>, exact: &BTreeMap<Key, Looks>,
    splits: &[Split]) -> Vec<String> {
    let theirs: BTreeMap<Option<u32>, &Looks> = exact.iter().filter(|((p, _), _)| *p == product).map(|((_, item), looks)| (*item, looks)).collect();
    let mut keys: Vec<_> = ours.keys().chain(theirs.keys()).copied().collect();
    keys.sort();
    keys.dedup();
    keys.into_iter().filter_map(|item| match (ours.get(&item), theirs.get(&item)) {
        (Some(o), Some(e)) if o == *e => None,
        (Some(o), Some(e)) => {
            let same_looks = o.keys().eq(e.keys());
            let allowed = same_looks && splits.iter().any(|s| s.model == model && s.product == product && s.item == item);
            (!allowed).then(|| format!("{model} #{product} item {item:?}: retained looks {o:?} are not exact's {e:?}"))
        }
        (Some(o), None) => Some(format!("{model} #{product} item {item:?}: exact emits no mesh under this key; retained carries {o:?}")),
        (None, Some(e)) => Some(format!("{model} #{product} item {item:?}: exact emits {e:?} but no retained part carries this key")),
        (None, None) => None,
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn look(rgba: f32, name: &str) -> Look { ([rgba.to_bits(); 4], Some(name.to_owned())) }
    fn looks(items: &[(&str, f32, usize)]) -> Looks { items.iter().map(|(n, c, k)| (look(*c, n), *k)).collect() }
    fn exact_396() -> BTreeMap<Key, Looks> {
        // l-window-twice #396: one item, two occurrences, so the material cursor gives glass then frame.
        BTreeMap::from([((396, Some(378)), looks(&[("Window_Glass", 0.5, 1), ("Window_Frame_378", 0.25, 1)]))])
    }
    fn ours(items: &[(&str, f32, usize)]) -> BTreeMap<Option<u32>, Looks> { BTreeMap::from([(Some(378), looks(items))]) }

    #[test]
    fn glass_and_frame_match_exact() {
        assert!(violations("m", 396, &ours(&[("Window_Glass", 0.5, 1), ("Window_Frame_378", 0.25, 1)]), &exact_396(), &[]).is_empty());
    }
    #[test]
    fn glass_rendered_twice_where_exact_has_glass_and_frame_fails() {
        // The old membership gate accepted this: every retained look was "among exact's" and the key was present.
        let found = violations("m", 396, &ours(&[("Window_Glass", 0.5, 2)]), &exact_396(), &[]);
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(found[0].contains("not exact's"), "{found:?}");
    }
    #[test]
    fn a_missing_frame_fails_even_when_the_glass_is_right() {
        assert!(!violations("m", 396, &ours(&[("Window_Glass", 0.5, 1)]), &exact_396(), &[]).is_empty());
    }
    #[test]
    fn a_key_only_one_side_has_fails_in_both_directions() {
        let other = BTreeMap::from([(Some(999), looks(&[("Window_Glass", 0.5, 1)]))]);
        assert_eq!(violations("m", 396, &other, &exact_396(), &[]).len(), 2);
    }
    #[test]
    fn a_listed_split_excuses_multiplicity_only() {
        let splits = [Split { model: "m", product: 396, item: Some(378), reason: "test" }];
        let doubled = ours(&[("Window_Glass", 0.5, 2), ("Window_Frame_378", 0.25, 3)]);
        assert!(violations("m", 396, &doubled, &exact_396(), &splits).is_empty());
        assert!(!violations("m", 396, &doubled, &exact_396(), &[]).is_empty(), "unlisted splits fail");
        assert!(!violations("m", 396, &ours(&[("Window_Glass", 0.5, 2)]), &exact_396(), &splits).is_empty(), "a split never excuses a missing look");
    }
}
