// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Iterative DFS. A suspended list holds only its remaining siblings; `Leave`
//! pairs entered levels, including on terminal refusal or visitor stop.
use super::*;
use ifc_lite_core::{slot::{IfcMappedItem, IfcRepresentation}, IfcType};

pub(super) enum Task {
    List {
        rep: Option<DecodedEntity>,
        items: std::vec::IntoIter<DecodedEntity>,
        first_mapped: Option<DecodedEntity>,
    },
    Enter(DecodedEntity),
    Leave,
}

impl RepresentationWalk {
    pub(super) fn items<V: WalkVisitor>(
        &self, run: &mut Run<'_, V>, rep: Option<&DecodedEntity>,
        items: &[DecodedEntity], decoder: &mut EntityDecoder,
    ) -> Flow {
        self.execute(run, Task::List {
            rep: rep.cloned(), items: items.to_vec().into_iter(), first_mapped: None,
        }, decoder)
    }

    pub(super) fn execute<V: WalkVisitor>(
        &self, run: &mut Run<'_, V>, initial: Task, decoder: &mut EntityDecoder,
    ) -> Flow {
        let mut tasks = vec![initial];
        let chain = matches!(self.nested, NestedMaps::FirstChain { .. });
        while let Some(task) = tasks.pop() {
            let flow = match task {
                Task::Leave => {
                    Self::leave(run);
                    Flow::Continue
                }
                Task::Enter(item) => self.enter(run, &item, decoder, &mut tasks),
                Task::List { rep, mut items, mut first_mapped } => {
                    if let Some(item) = items.next() {
                        let mapped = item.ifc_type == IfcType::IfcMappedItem
                            && !matches!(self.nested, NestedMaps::Leaf);
                        let flow = if mapped {
                            if chain && first_mapped.is_none() {
                                first_mapped = Some(item.clone());
                            }
                            Flow::Continue
                        } else {
                            let at = WalkCtx { element: run.element, shape_rep: rep.as_ref(), path: &run.path };
                            run.visitor.item(&item, &at, decoder)
                        };
                        tasks.push(Task::List { rep, items, first_mapped });
                        if mapped && !chain {
                            tasks.push(Task::Enter(item));
                        }
                        flow
                    } else {
                        if let Some(item) = first_mapped {
                            tasks.push(Task::Enter(item));
                        }
                        Flow::Continue
                    }
                }
            };
            if flow == Flow::Stop {
                // Remaining lists are discarded, but every entered level leaves
                // innermost first. Visitors may hold transform/drop scopes.
                while !run.path.is_empty() {
                    Self::leave(run);
                }
                return Flow::Stop;
            }
        }
        Flow::Continue
    }

    fn leave<V: WalkVisitor>(run: &mut Run<'_, V>) {
        if let Some(level) = run.path.pop() {
            run.visitor.leave_map(&level);
        }
    }

    fn enter<V: WalkVisitor>(
        &self, run: &mut Run<'_, V>, item: &DecodedEntity,
        decoder: &mut EntityDecoder, tasks: &mut Vec<Task>,
    ) -> Flow {
        let (max_depth, max_levels) = match self.nested {
            NestedMaps::Expand { max_depth, max_levels } => (max_depth, max_levels),
            NestedMaps::FirstChain { max_depth } => (max_depth, u32::MAX),
            NestedMaps::Refuse | NestedMaps::Leaf => (0, u32::MAX),
        };
        let bail = matches!(self.nested, NestedMaps::Refuse);
        let refuse = |run: &mut Run<'_, V>, why| {
            let at = WalkCtx { element: run.element, shape_rep: None, path: &run.path };
            run.visitor.refused(item, why, &at);
            if bail { Flow::Stop } else { Flow::Continue }
        };
        if run.path.len() >= max_depth as usize {
            return refuse(run, WalkRefusal::TooDeep { max_depth });
        }
        if run.path.iter().any(|level| level.item.id == item.id) {
            return refuse(run, WalkRefusal::Cyclic);
        }
        if run.levels >= max_levels {
            refuse(run, WalkRefusal::Budget { max_levels });
            return Flow::Stop;
        }
        run.levels += 1;
        let (map, mapped_rep) = match Self::resolve_level(item, decoder) {
            Ok(resolved) => resolved,
            Err(why) => return refuse(run, why),
        };
        let level = MappedLevel { item: item.clone(), map, mapped_rep };
        let at = WalkCtx { element: run.element, shape_rep: None, path: &run.path };
        let flow = run.visitor.enter_map(&level, &at, decoder);
        run.path.push(level);
        tasks.push(Task::Leave);
        if flow != Flow::Continue {
            return if flow == Flow::Stop { Flow::Stop } else { Flow::Continue };
        }
        // Decode lazily: a source-cache hit may skip children without reading
        // their Items. Report an item-list failure inside the entered scope.
        let last = run.path.len() - 1;
        let rep = &run.path[last].mapped_rep;
        match Self::level_items(rep, decoder) {
            Ok(items) => tasks.push(Task::List {
                rep: Some(rep.clone()), items: items.into_iter(), first_mapped: None,
            }),
            Err(why) => {
                let at = WalkCtx { element: run.element, shape_rep: None, path: &run.path[..last] };
                run.visitor.refused(item, why, &at);
                if bail { return Flow::Stop; }
            }
        }
        Flow::Continue
    }

    fn resolve_level(
        item: &DecodedEntity, decoder: &mut EntityDecoder,
    ) -> Result<(DecodedEntity, DecodedEntity), WalkRefusal> {
        let source = item.attr(IfcMappedItem::MAPPING_SOURCE).ok_or(WalkRefusal::MissingSource)?;
        let map = decoder.resolve_ref(source).map_err(WalkRefusal::Decode)?
            .ok_or(WalkRefusal::UnresolvedSource)?;
        let rep = map.attr(IfcRepresentationMap::MAPPED_REPRESENTATION)
            .ok_or(WalkRefusal::MissingMappedRepresentation)?;
        let mapped_rep = decoder.resolve_ref(rep).map_err(WalkRefusal::Decode)?
            .ok_or(WalkRefusal::UnresolvedMappedRepresentation)?;
        Ok((map, mapped_rep))
    }

    fn level_items(
        rep: &DecodedEntity, decoder: &mut EntityDecoder,
    ) -> Result<Vec<DecodedEntity>, WalkRefusal> {
        let list = rep.attr(IfcRepresentation::ITEMS).ok_or(WalkRefusal::MissingItems)?;
        decoder.resolve_ref_list(list).map_err(WalkRefusal::Decode)
    }
}
