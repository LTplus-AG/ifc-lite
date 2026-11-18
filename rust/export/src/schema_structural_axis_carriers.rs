// SPDX-License-Identifier: MPL-2.0
//! IFC2X3 profile associations holding an IFC4 curve member's section axis.
use std::collections::{BTreeMap, HashMap, HashSet};

use nalgebra::Vector3;

use crate::schema_structural_axes::{direction_tuple, list_items, reference, unset};

const RELATION: &str = "IFCRELASSOCIATESPROFILEPROPERTIES";
const NAME: &str = "'IFC4 Axis'";

pub(super) struct AxisPlan {
    pub(super) member: u32,
    pub(super) axis: u32,
    pub(super) turned: bool,
    pub(super) ratios: Vector3<f64>,
    pub(super) args: Vec<String>,
}

pub(super) struct RemovableAssociation {
    relationship: u32,
    properties: u32,
    pub(super) direction: Option<u32>,
}

#[derive(Default)]
pub(crate) struct AxisCarrierRecords {
    carried: HashSet<u32>,
    fills: HashMap<u32, u32>,
    consumed: HashSet<u32>,
    added: Vec<String>,
}

fn related(args: &[String]) -> Vec<Option<u32>> {
    list_items(&args[4]).unwrap_or_default().iter().map(|token| reference(token)).collect()
}

fn same(a: Vector3<f64>, b: Vector3<f64>) -> bool {
    a.try_normalize(1e-9).zip(b.try_normalize(1e-9))
        .is_some_and(|(a, b)| (a - b).iter().all(|difference| difference.abs() <= 1e-9))
}

impl AxisCarrierRecords {
    pub(super) fn downgrade(
        plans: Vec<AxisPlan>,
        associations: Vec<(u32, Vec<String>)>,
        directions: &HashMap<u32, Vector3<f64>>,
        mut allocate: impl FnMut() -> Option<u32>,
    ) -> Self {
        let mut result = Self::default();
        let mut owners = HashMap::<u32, Vec<usize>>::new();
        for (index, (_, args)) in associations.iter().enumerate() {
            for member in related(args).into_iter().flatten() {
                owners.entry(member).or_default().push(index);
            }
        }
        let plans: BTreeMap<u32, AxisPlan> = plans.into_iter().map(|plan| (plan.member, plan)).collect();
        for (&member, plan) in &plans {
            match owners.get(&member).map(Vec::as_slice).unwrap_or_default() {
                [] => {
                    let Some(properties) = allocate() else { continue; };
                    let Some(rel) = allocate() else { continue; };
                    let Some(axis) = result.direction(plan, &mut allocate) else { continue; };
                    let guid = crate::merged::deterministic_global_id(&format!("ifc4-axis:{}", plan.args[0].trim()));
                    let owner_history = &plan.args[1];
                    result.added.push(format!("#{properties}=IFCGENERALPROFILEPROPERTIES($,$,$,$,$,$,$);"));
                    result.added.push(format!("#{rel}={RELATION}('{guid}',{owner_history},{NAME},$,(#{member}),#{properties},$,#{axis});"));
                    result.carried.insert(member);
                }
                [index] => {
                    let (rel, args) = &associations[*index];
                    if let Some(axis) = reference(&args[7]) {
                        if directions.get(&axis).is_some_and(|value| same(*value, plan.ratios)) {
                            result.carried.insert(member);
                        }
                    } else if result.fills.contains_key(rel) {
                        result.carried.insert(member);
                    } else if unset(&args[7]) && related(args).into_iter().all(|id| {
                        id.and_then(|id| plans.get(&id)).is_some_and(|other| {
                            owners[&other.member].len() == 1 && same(other.ratios, plan.ratios)
                        })
                    }) {
                        if let Some(axis) = result.direction(plan, &mut allocate) {
                            result.fills.insert(*rel, axis);
                            result.carried.insert(member);
                        }
                    }
                }
                _ => {}
            }
        }
        result
    }

    fn direction(&mut self, plan: &AxisPlan, allocate: &mut impl FnMut() -> Option<u32>) -> Option<u32> {
        if !plan.turned { return Some(plan.axis); }
        let id = allocate()?;
        self.added.push(format!("#{id}=IFCDIRECTION({});", direction_tuple(plan.ratios, 15)));
        Some(id)
    }

    pub(super) fn removable_associations(
        associations: &[(u32, Vec<String>)],
        properties: &HashSet<u32>,
        plans: &[AxisPlan],
        content: &[u8],
        kept: impl Fn(u32, usize) -> bool,
    ) -> HashMap<u32, RemovableAssociation> {
        let by_member: HashMap<_, _> = plans.iter().map(|plan| (plan.member, plan)).collect();
        let candidates: Vec<_> = associations.iter().filter_map(|(relationship, args)| {
            if args[2].trim() != NAME || !unset(&args[3]) || !unset(&args[6]) { return None; }
            let members = related(args);
            let [Some(member)] = members.as_slice() else { return None; };
            let plan = by_member.get(member)?;
            let props = reference(&args[5]).filter(|id| properties.contains(id))?;
            (reference(&args[7]) == Some(plan.axis)).then_some((
                *member, *relationship, props, plan.turned.then_some(plan.axis),
            ))
        }).collect();
        if candidates.is_empty() { return HashMap::new(); }

        let mut counts: HashMap<u32, usize> = candidates.iter()
            .flat_map(|&(_, rel, props, axis)| [Some(rel), Some(props), axis].into_iter().flatten())
            .map(|id| (id, 0)).collect();
        let mut scanner = ifc_lite_core::EntityScanner::new(content);
        let mut refs = Vec::new();
        while let Some((id, _, start, end)) = scanner.next_entity() {
            if !kept(id, start) { continue; }
            crate::merged::arg_refs(&content[start..end], &mut refs);
            refs.retain(|id| counts.contains_key(id));
            refs.sort_unstable();
            refs.dedup();
            for id in refs.drain(..) {
                if let Some(count) = counts.get_mut(&id) { *count += 1; }
            }
        }
        candidates.into_iter().filter_map(|(member, relationship, properties, axis)| {
            if counts[&relationship] != 0 || counts[&properties] != 1 { return None; }
            let direction = axis.filter(|id| counts[id] == 1);
            Some((member, RemovableAssociation { relationship, properties, direction }))
        }).collect()
    }

    pub(super) fn consume(&mut self, carrier: &RemovableAssociation) {
        self.consumed.extend([carrier.relationship, carrier.properties]);
        self.consumed.extend(carrier.direction);
    }

    pub(crate) fn drops(&self, id: u32) -> bool { self.consumed.contains(&id) }

    pub(super) fn added(&mut self) -> Vec<String> { std::mem::take(&mut self.added) }

    pub(crate) fn rewrite(&self, id: u32, entity: &str, args: &[String]) -> Option<(String, bool)> {
        if self.carried.contains(&id) && args.len() == 9 {
            return Some((format!("{entity}({})", args[..8].join(",")), true));
        }
        let axis = self.fills.get(&id)?;
        (entity == RELATION && args.len() == 8)
            .then(|| (format!("{entity}({},#{axis})", args[..7].join(",")), false))
    }
}
