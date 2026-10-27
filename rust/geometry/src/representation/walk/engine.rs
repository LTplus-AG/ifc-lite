// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Iterative DFS. A suspended list holds only its remaining siblings; `Leave`
//! pairs entered levels, including on terminal refusal or visitor stop.
use super::*;
use ifc_lite_core::{
    slot::{IfcMappedItem, IfcRepresentation},
    IfcType,
};

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
        &self,
        run: &mut Run<'_, V>,
        rep: Option<&DecodedEntity>,
        items: &[DecodedEntity],
        decoder: &mut EntityDecoder,
    ) -> Flow {
        // The usual representation is flat. Visit its borrowed prefix without
        // cloning a list or allocating continuation storage. A mapped suffix
        // still enters the same iterative engine with the same shared meters.
        for (index, item) in items.iter().enumerate() {
            if item.ifc_type == IfcType::IfcMappedItem && !matches!(self.nested, NestedMaps::Leaf) {
                // A final mapped member has no sibling continuation. Enter it
                // directly, as mapped_item does, without cloning a one-item list.
                if index + 1 == items.len() {
                    return self.execute(run, Task::Enter(item.clone()), decoder);
                }
                // Suspended continuations own their suffix across mapped descent.
                let remaining = items[index..].to_vec();
                return self.execute(
                    run,
                    Task::List {
                        rep: rep.cloned(),
                        items: remaining.into_iter(),
                        first_mapped: None,
                    },
                    decoder,
                );
            }
            let at = WalkCtx {
                element: run.element,
                shape_rep: rep,
                path: &run.path,
            };
            if run.visitor.item(item, &at, decoder) == Flow::Stop {
                return Flow::Stop;
            }
        }
        Flow::Continue
    }

    pub(super) fn execute<V: WalkVisitor>(
        &self,
        run: &mut Run<'_, V>,
        initial: Task,
        decoder: &mut EntityDecoder,
    ) -> Flow {
        let mut tasks = smallvec::smallvec![initial];
        let chain = matches!(self.nested, NestedMaps::FirstChain { .. });
        while let Some(task) = tasks.pop() {
            let flow = match task {
                Task::Leave => {
                    Self::leave(run);
                    Flow::Continue
                }
                Task::Enter(item) => self.enter(run, &item, decoder, &mut tasks),
                Task::List {
                    rep,
                    items,
                    first_mapped,
                } => self.list(run, rep, items, first_mapped, chain, decoder, &mut tasks),
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

    #[allow(clippy::too_many_arguments)] // one suspended list and its walk context
    fn list<V: WalkVisitor>(
        &self,
        run: &mut Run<'_, V>,
        rep: Option<DecodedEntity>,
        mut items: std::vec::IntoIter<DecodedEntity>,
        mut first_mapped: Option<DecodedEntity>,
        chain: bool,
        decoder: &mut EntityDecoder,
        tasks: &mut smallvec::SmallVec<[Task; 3]>,
    ) -> Flow {
        while let Some(item) = items.next() {
            if item.ifc_type == IfcType::IfcMappedItem && !matches!(self.nested, NestedMaps::Leaf) {
                if chain {
                    if first_mapped.is_none() {
                        first_mapped = Some(item);
                    }
                    continue;
                }
                // Suspend only when descending, never once per plain item.
                tasks.push(Task::List {
                    rep,
                    items,
                    first_mapped,
                });
                tasks.push(Task::Enter(item));
                return Flow::Continue;
            }
            let at = WalkCtx {
                element: run.element,
                shape_rep: rep.as_ref(),
                path: &run.path,
            };
            if run.visitor.item(&item, &at, decoder) == Flow::Stop {
                return Flow::Stop;
            }
        }
        if let Some(item) = first_mapped {
            tasks.push(Task::Enter(item));
        }
        Flow::Continue
    }

    fn leave<V: WalkVisitor>(run: &mut Run<'_, V>) {
        if let Some(level) = run.path.pop() {
            run.visitor.leave_map(&level);
        }
    }

    fn enter<V: WalkVisitor>(
        &self,
        run: &mut Run<'_, V>,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
        tasks: &mut smallvec::SmallVec<[Task; 3]>,
    ) -> Flow {
        let max_depth = match self.nested {
            NestedMaps::Expand { max_depth, .. } | NestedMaps::FirstChain { max_depth } => {
                max_depth
            }
            NestedMaps::Refuse | NestedMaps::Leaf => 0,
        };
        let bail = matches!(self.nested, NestedMaps::Refuse);
        let refuse = |run: &mut Run<'_, V>, why| {
            let at = WalkCtx {
                element: run.element,
                shape_rep: None,
                path: &run.path,
            };
            run.visitor.refused(item, why, &at);
            if bail {
                Flow::Stop
            } else {
                Flow::Continue
            }
        };
        if run.path.len() >= max_depth as usize {
            return refuse(run, WalkRefusal::TooDeep { max_depth });
        }
        if run.path.iter().any(|level| level.item.id == item.id) {
            return refuse(run, WalkRefusal::Cyclic);
        }
        if let NestedMaps::Expand { max_levels, .. } = self.nested {
            if run.levels >= max_levels {
                refuse(run, WalkRefusal::Budget { max_levels });
                return Flow::Stop;
            }
            run.levels += 1;
        }
        let (map, mapped_rep) = match Self::resolve_level(item, decoder) {
            Ok(resolved) => resolved,
            Err(why) => return refuse(run, why),
        };
        let level = MappedLevel {
            item: item.clone(),
            map,
            mapped_rep,
        };
        let at = WalkCtx {
            element: run.element,
            shape_rep: None,
            path: &run.path,
        };
        let flow = run.visitor.enter_map(&level, &at, decoder);
        run.path.push(level);
        tasks.push(Task::Leave);
        if flow != Flow::Continue {
            return if flow == Flow::Stop {
                Flow::Stop
            } else {
                Flow::Continue
            };
        }
        // Decode lazily: a source-cache hit may skip children without reading
        // their Items. Report an item-list failure inside the entered scope.
        let last = run.path.len() - 1;
        let rep = &run.path[last].mapped_rep;
        match self.level_items(&mut run.items, rep, decoder) {
            Ok(items) => tasks.push(Task::List {
                rep: Some(rep.clone()),
                items: items.into_iter(),
                first_mapped: None,
            }),
            Err(why) => {
                let at = WalkCtx {
                    element: run.element,
                    shape_rep: None,
                    path: &run.path[..last],
                };
                let terminal = matches!(why, WalkRefusal::Budget { .. });
                run.visitor.refused(item, why, &at);
                if bail || terminal {
                    return Flow::Stop;
                }
            }
        }
        Flow::Continue
    }

    // File references and public inputs are not owner-validated (#8020).
    // Named positional reads preserve malformed-target refusal without assertion.
    fn resolve_level(
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<(DecodedEntity, DecodedEntity), WalkRefusal> {
        let source = item
            .get(IfcMappedItem::MAPPING_SOURCE.index())
            .ok_or(WalkRefusal::MissingSource)?;
        let map = decoder
            .resolve_ref(source)
            .map_err(WalkRefusal::Decode)?
            .ok_or(WalkRefusal::UnresolvedSource)?;
        let rep = map
            .get(IfcRepresentationMap::MAPPED_REPRESENTATION.index())
            .ok_or(WalkRefusal::MissingMappedRepresentation)?;
        let mapped_rep = decoder
            .resolve_ref(rep)
            .map_err(WalkRefusal::Decode)?
            .ok_or(WalkRefusal::UnresolvedMappedRepresentation)?;
        Ok((map, mapped_rep))
    }

    /// Pay for every member, including ignored non-reference values, BEFORE
    /// resolve_ref_list allocates or decodes. Repeated DAG occurrences pay again.
    /// This complements the mapped-level meter: N entries into the same N-leaf
    /// source can no longer materialize N² items under an N-level allowance.
    pub(super) fn admit_items(&self, used: &mut u32, count: usize) -> Result<(), WalkRefusal> {
        if let NestedMaps::Expand { max_levels, .. } = self.nested {
            if count > (max_levels - *used) as usize {
                return Err(WalkRefusal::Budget { max_levels });
            }
            *used += count as u32; // bounded by the u32 allowance above
        }
        Ok(())
    }

    /// The product/map root is admitted too, before materializing its list.
    /// Root failures retain ShapeError; budget refusal uses the visitor channel.
    pub(super) fn root_items<V: WalkVisitor>(
        &self,
        run: &mut Run<'_, V>,
        rep: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Option<Vec<DecodedEntity>>, ShapeError> {
        let list = rep
            .get(IfcRepresentation::ITEMS.index())
            .ok_or(ShapeError::MissingItems)?;
        if let Err(why) = self.admit_items(
            &mut run.items,
            list.as_list().map_or(0, |items| items.len()),
        ) {
            let at = WalkCtx {
                element: run.element,
                shape_rep: Some(rep),
                path: &run.path,
            };
            run.visitor.refused(rep, why, &at);
            return Ok(None);
        }
        Ok(Some(decoder.resolve_ref_list(list)?))
    }

    fn level_items(
        &self,
        used: &mut u32,
        rep: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<DecodedEntity>, WalkRefusal> {
        let list = rep
            .get(IfcRepresentation::ITEMS.index())
            .ok_or(WalkRefusal::MissingItems)?;
        self.admit_items(used, list.as_list().map_or(0, |items| items.len()))?;
        decoder.resolve_ref_list(list).map_err(WalkRefusal::Decode)
    }
}
