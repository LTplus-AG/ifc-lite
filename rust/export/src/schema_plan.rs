// SPDX-License-Identifier: MPL-2.0
//! What schema conversion does to every record of one source TYPE, resolved
//! once per distinct type per conversion (#7683).
//!
//! The decision (rename, proxy, refuse, trim, pad or by-name remap) depends
//! only on the source and target schema and the type name: core's EXPRESS
//! registry answers it from positional attribute NAMES, never from a record's
//! values. Asking the registry per RECORD cost two or three `IfcType::from_str`
//! lookups, each a match over about 650 names, and made schema-converting STEP
//! export 15 to 18% more instructions than the hand tables it replaced. A
//! [`PlanCache`] lives in the per-export [`crate::schema_enum::ConversionChecks`]
//! and keys the decision by type name, so the registry is consulted once per
//! distinct type in the file.

use rustc_hash::FxHashMap;

use crate::schema_convert::{rename_type, schema_attribute_names, should_skip_entity, BY_NAME_ATTR_REMAP_TYPES};
use crate::schema_renames::is_strict_attr_prefix;
use crate::schema_unrepresented::has_representation;

/// How a written record's attribute list is reconciled with the target type.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Adjust {
    /// Same list, or one neither prefix rule nor the by-name remap may touch.
    Keep,
    /// The target list is a strict name prefix of the source's: keep this many.
    Trim(usize),
    /// The source list is a strict name prefix of the target's: pad to this many.
    Pad(usize),
    /// A renamed type in `BY_NAME_ATTR_REMAP_TYPES`: source names, target names.
    ByName(&'static [&'static str], &'static [&'static str]),
}

/// What `convert_record` does with every record of one source type.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Plan {
    /// One of `should_skip_entity`'s IFC4X3 alignment products:
    /// `schema_convert::product_proxy`.
    ProductProxy,
    /// No representation in the target at all: a proxy for a rooted type, an
    /// error otherwise (`schema_unrepresented::resolve_unrepresented_entity`).
    Unrepresented,
    /// Written as `renamed` (`None`: under its own name), attributes adjusted.
    Write { renamed: Option<&'static str>, adjust: Adjust },
}

/// The [`Plan`] for `entity_type` (uppercase) between two different canonical
/// schemas. Same checks in the same order as the TypeScript twin's
/// `convertRecord`: proxy list, representation, then the prefix rules (source
/// names keyed on the ORIGINAL type, target names on the renamed one).
pub(crate) fn plan_for(entity_type: &str, cfrom: &'static str, cto: &'static str) -> Plan {
    let renamed = rename_type(entity_type, cfrom, cto);
    let new_type = renamed.unwrap_or(entity_type);
    if should_skip_entity(new_type, cto) {
        return Plan::ProductProxy;
    }
    let src_names = schema_attribute_names(cfrom, entity_type);
    if !has_representation(cfrom == "IFC4X3" && src_names.is_some(), new_type, cto) {
        return Plan::Unrepresented;
    }
    // The two prefix branches cannot both apply: each needs its own list
    // strictly shorter.
    let adjust = match (src_names, schema_attribute_names(cto, new_type)) {
        (Some(src), Some(tgt)) if is_strict_attr_prefix(entity_type, tgt, src) => Adjust::Trim(tgt.len()),
        (Some(src), Some(tgt)) if is_strict_attr_prefix(entity_type, src, tgt) => Adjust::Pad(tgt.len()),
        (Some(src), Some(tgt)) if new_type != entity_type && BY_NAME_ATTR_REMAP_TYPES.contains(&entity_type) => {
            Adjust::ByName(src, tgt)
        }
        _ => Adjust::Keep,
    };
    Plan::Write { renamed, adjust }
}

/// Index of a canonical schema family, for [`PlanCache`]'s per-pair maps.
fn family(schema: &str) -> usize {
    match schema {
        "IFC2X3" => 0,
        "IFC4" => 1,
        "IFC4X3" => 2,
        _ => 3,
    }
}

/// [`plan_for`], memoised per (source family, target family, type name). One
/// map per schema pair, because a merged export converts models of different
/// source schemas through one cache. Bounded by the distinct type names the
/// input holds, which never exceeds its record count.
#[derive(Default)]
pub(crate) struct PlanCache {
    by_pair: [FxHashMap<Box<str>, Plan>; 16],
}

impl PlanCache {
    pub(crate) fn get(&mut self, entity_type: &str, cfrom: &'static str, cto: &'static str) -> Plan {
        let map = &mut self.by_pair[family(cfrom) * 4 + family(cto)];
        if let Some(plan) = map.get(entity_type) {
            return *plan;
        }
        let plan = plan_for(entity_type, cfrom, cto);
        map.insert(entity_type.into(), plan);
        plan
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cache answers what an uncached lookup does, per schema pair: the
    /// same type name gets a different plan for a different pair.
    #[test]
    fn the_cache_answers_per_schema_pair_7683() {
        let mut cache = PlanCache::default();
        for (ty, from, to) in [
            ("IFCQUANTITYLENGTH", "IFC4", "IFC2X3"),
            ("IFCQUANTITYLENGTH", "IFC2X3", "IFC4"),
            ("IFCALIGNMENT", "IFC4X3", "IFC4"),
            ("IFCALIGNMENT", "IFC4X3", "IFC5"),
            ("IFCDOORTYPE", "IFC4", "IFC2X3"),
            ("IFCTRIANGULATEDFACESET", "IFC4", "IFC2X3"),
        ] {
            let want = plan_for(ty, from, to);
            assert_eq!(cache.get(ty, from, to), want, "{ty} {from}->{to}, first ask");
            assert_eq!(cache.get(ty, from, to), want, "{ty} {from}->{to}, cached");
        }
        assert!(matches!(plan_for("IFCQUANTITYLENGTH", "IFC4", "IFC2X3"), Plan::Write { adjust: Adjust::Trim(_), .. }));
        assert!(matches!(plan_for("IFCQUANTITYLENGTH", "IFC2X3", "IFC4"), Plan::Write { adjust: Adjust::Pad(_), .. }));
        assert_eq!(plan_for("IFCALIGNMENT", "IFC4X3", "IFC4"), Plan::ProductProxy);
        assert_eq!(plan_for("IFCALIGNMENT", "IFC4X3", "IFC5"), Plan::Write { renamed: None, adjust: Adjust::Keep });
        assert!(matches!(plan_for("IFCDOORTYPE", "IFC4", "IFC2X3"), Plan::Write { renamed: Some("IFCDOORSTYLE"), adjust: Adjust::ByName(..) }));
        assert_eq!(plan_for("IFCTRIANGULATEDFACESET", "IFC4", "IFC2X3"), Plan::Unrepresented);
    }
}
