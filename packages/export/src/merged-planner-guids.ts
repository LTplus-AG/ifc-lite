/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The GlobalId half of the `dropEmptyContainers` planner's claim pass (#5937).
 *
 * The planner has to know, before anything is written, which aggregation edges
 * the emit pass's one-parent claim pass (#5471, #5725) will withhold. That
 * pass resolves ids through GlobalId reconciliation (`planModel`): a later
 * model's entity that repeats a GlobalId an earlier model WROTE is unified
 * onto it. The planner used to resolve through spatial unification only, so an
 * edge withheld because its child unified by GlobalId still counted, and its
 * container was written empty.
 *
 * {@link PlannerGuids} replays that reconciliation from what the planner can
 * know up front. It must never unify two entities the emit pass keeps apart:
 * then the planner would withhold an edge the emit pass writes, and could drop
 * the parent of a full container (the WR41 invariant). So wherever the emit
 * pass's verdict depends on something the planner cannot see, the GlobalId is
 * marked UNKNOWN and nothing resolves through it afterwards. Missing a
 * unification only keeps a container, which is #3643's behaviour before #5725.
 * UNKNOWN covers:
 * - a model exported across schemas: conversion may replace an entity with an
 *   IFCPROXY that carries a fresh GlobalId, so the source one is not recorded;
 * - a relationship: the claim pass itself may withhold it;
 * - an entity whose own GlobalId was already UNKNOWN.
 * A GlobalId one model writes twice is recorded as the emit pass records it:
 * the last copy in index order.
 *
 * Containers are the one thing written or not by the plan being made. A
 * container unifies here only onto a container (and anything else only onto
 * anything else), and only where `canonicalContainers` in
 * `merged-empty-containers.ts` puts both on one node, so a container this pass
 * treats as written but the plan drops takes every copy it was unified with
 * along: the edges to them are withheld by the drop either way.
 */

import { isRelationshipType } from './merged-guid.js';

/** Where the emit pass will have recorded a GlobalId, or `null` when that is not knowable up front. */
type GuidRecord = { finalId: number; scale: number; container: boolean } | null;

/** One model as {@link PlannerGuids.plan} sees it, in merge order. */
export interface PlannerGuidModel {
  /** Rooted entities in emit order: local id → GlobalId (`planModel`'s `localGuids`, `readLocalGuids`). */
  guids: ReadonlyMap<number, string>;
  /** Uppercase STEP type of a local id. */
  typeOf: (localId: number) => string;
  isFirst: boolean;
  compatible: boolean;
  offset: number;
  /** Unit scale the model's entities are recorded with (`ModelMode.effectiveScale`). */
  effectiveScale: number;
  /** Written with its source GlobalId unchanged: false when exported across schemas. */
  keepsGuids: boolean;
  /** Left out before GlobalId reconciliation: the unified IfcProject, a spatially unified container. */
  unifiedEarlier: (localId: number) => boolean;
  /** In the output at all (visibility closure). */
  isIncluded: (localId: number) => boolean;
}

/** The emit pass's GlobalId records, replayed conservatively across one merge. */
export class PlannerGuids {
  private readonly records = new Map<string, GuidRecord>();

  constructor(
    private readonly isPrimaryUnit: (scale: number) => boolean,
    private readonly isContainer: (typeUpper: string) => boolean,
  ) {}

  /**
   * `planModel`'s GlobalId step for one model, then the records its writes
   * leave. Returns local id → final id for the entities the emit pass is sure
   * to unify by GlobalId. Call once per model, in merge order.
   */
  plan(model: PlannerGuidModel): Map<number, number> {
    const unified = new Map<number, number>();
    const settled = new Set<number>();
    for (const [id, guid] of model.guids) {
      if (model.unifiedEarlier(id) || !this.records.has(guid)) continue;
      const type = model.typeOf(id);
      // An earlier record exists: the emit pass unifies or re-stamps, and never records this GlobalId again.
      settled.add(id);
      const prior = this.records.get(guid)!;
      const canUnify = !model.isFirst && model.compatible && prior !== null && this.isPrimaryUnit(prior.scale) && !isRelationshipType(type);
      if (canUnify && prior.container === this.isContainer(type)) unified.set(id, prior.finalId);
    }
    const written = new Map<string, GuidRecord>();
    for (const [id, guid] of model.guids) {
      if (settled.has(id) || model.unifiedEarlier(id) || !model.isIncluded(id)) continue;
      const type = model.typeOf(id);
      const known = model.keepsGuids && !isRelationshipType(type);
      written.set(guid, known ? { finalId: id + model.offset, scale: model.effectiveScale, container: this.isContainer(type) } : null);
    }
    for (const [guid, record] of written) this.records.set(guid, record);
    return unified;
  }
}
