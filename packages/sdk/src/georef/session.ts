/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A model's georeferencing edits for one headless session — the headless
 * counterpart of the viewer's per-model `georefMutations` (mutationSlice):
 * edits to IFC4/IFC4X3 georeferencing entities are held here and handed to
 * `StepExporter` as `georefMutations` at export, while deletions of replaced
 * records and IFC2X3 property-set edits go into the session's ordinary
 * mutation view.
 *
 * A plan is computed in full before anything is applied, so a refused write
 * leaves the session exactly as it was.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import { PropertyValueType } from '@ifc-lite/data';
import type { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { collectGeorefModelFacts } from './model-facts.js';
import { planRemove, planSet, type GeorefWritePlan, type PropertySetOp, type StepGeorefMutations } from './plan.js';
import { planUpdate } from './plan-update.js';
import { readSourceGeoreferencing } from './read.js';
import type { GeoreferencingState, GeoreferencingWriteRequest, GeoreferencingWriteResult } from './types.js';

export interface GeoreferencingSessionDeps {
  store: IfcDataStore;
  modelId: string;
  /** The session's mutation view, if it has one yet. */
  view(): MutablePropertyView | null;
  /** Create (or return) the session's editor; its view becomes `view()`. */
  editor(): StoreEditor;
}

export class GeoreferencingSession {
  private pending: StepGeorefMutations | null = null;
  private pendingState: GeoreferencingState | null = null;
  /** Records this session deleted for a georeferencing write. */
  private tombstoned: number[] = [];

  constructor(private readonly deps: GeoreferencingSessionDeps) {}

  /** The effective georeferencing: the source, or this session's write. */
  get(): GeoreferencingState {
    this.forgetIfUndone();
    return this.pendingState ?? readSourceGeoreferencing(this.deps.store, this.deps.modelId);
  }

  write(request: GeoreferencingWriteRequest): GeoreferencingWriteResult {
    this.forgetIfUndone();
    const editor = this.deps.editor();
    const view = this.deps.view();
    const facts = collectGeorefModelFacts(this.deps.store, view && {
      isDeleted: (id) => view.isDeleted(id),
      getForEntity: (id) => view.getForEntity(id),
    });
    const ctx = { modelId: this.deps.modelId, facts, current: this.get(), pending: this.pending };
    const plan: GeorefWritePlan = request.action === 'set' ? planSet(request.input, ctx)
      : request.action === 'update' ? planUpdate(request.input, ctx)
        : planRemove(ctx);

    for (const id of plan.tombstone) editor.removeEntity(id);
    if (view) for (const op of plan.propertySetOps) applyPropertySetOp(view, op);
    this.pending = plan.georefMutations;
    this.pendingState = plan.next;
    this.tombstoned.push(...plan.tombstone);
    return {
      action: plan.action,
      storage: plan.storage,
      state: plan.next,
      removed: plan.removed,
      mapUnit: plan.mapUnit,
      notes: plan.notes,
    };
  }

  /** `StepExportOptions.georefMutations` for an export of this session, if any. */
  exportMutations(): StepGeorefMutations | undefined {
    this.forgetIfUndone();
    const m = this.pending;
    if (!m) return undefined;
    const any = Object.keys(m.projectedCRS ?? {}).length > 0 || Object.keys(m.mapConversion ?? {}).length > 0;
    return any ? m : undefined;
  }

  hasPendingChanges(): boolean {
    this.forgetIfUndone();
    return this.pendingState !== null;
  }

  /**
   * `mutation_undo` / `bim.mutate.undo` can restore a record this session
   * deleted for a `set --replace` or `remove`. The georeferencing write it
   * belonged to is then no longer what the session holds, so it is dropped as
   * a whole rather than exported half-applied.
   */
  private forgetIfUndone(): void {
    if (this.tombstoned.length === 0) return;
    const view = this.deps.view();
    if (view && this.tombstoned.every((id) => view.isDeleted(id))) return;
    this.pending = null;
    this.pendingState = null;
    this.tombstoned = [];
  }
}

function applyPropertySetOp(view: MutablePropertyView, op: PropertySetOp): void {
  if (op.op === 'deleteSet') {
    view.deletePropertySet(op.hostId, op.pset);
  } else if (op.op === 'deleteProperty') {
    view.deleteProperty(op.hostId, op.pset, op.prop);
  } else {
    const valueType = typeof op.value === 'number' ? PropertyValueType.Real : PropertyValueType.Label;
    view.setProperty(op.hostId, op.pset, op.prop, op.value, valueType, undefined, false, op.dataType);
  }
}
