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
 * leaves the session exactly as it was. An applied write is one compound
 * mutation, so `mutation_undo` takes it back whole.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import { PropertyValueType } from '@ifc-lite/data';
import { recordCompoundMutation, recordSessionMutation, StoreEditor, type MutablePropertyView } from '@ifc-lite/mutations';
import { collectGeorefModelFacts, type GeorefModelFacts } from './model-facts.js';
import { planRemove, planSet, type GeorefWritePlan, type PropertySetOp, type StepGeorefMutations } from './plan.js';
import { planUpdate } from './plan-update.js';
import { readSourceGeoreferencing, readWithoutGeoreferencing } from './read.js';
import type { GeoreferencingState, GeoreferencingWriteRequest, GeoreferencingWriteResult } from './types.js';

export interface GeoreferencingSessionDeps {
  store: IfcDataStore;
  modelId: string;
  /** The session's mutation view, if it has one yet. */
  view(): MutablePropertyView | null;
  /** Create (or return) the session's editor; its view becomes `view()`. */
  editor(): StoreEditor;
}

/** The `SESSION_EDIT` label a georeferencing write is recorded under. */
export const GEOREF_SESSION_KIND = 'georeferencing';

/** One applied write: its history marker and what the session holds after it. */
interface AppliedWrite {
  marker: string;
  pending: StepGeorefMutations | null;
  state: GeoreferencingState;
}

export class GeoreferencingSession {
  /**
   * Applied writes, oldest first. Each was recorded as one compound mutation
   * (its tombstones, IFC2X3 property edits and a `SESSION_EDIT` marker), so
   * one undo step takes all of it back; a write whose marker has left the
   * history is dropped here, and the one below it is current again.
   */
  private writes: AppliedWrite[] = [];

  constructor(private readonly deps: GeoreferencingSessionDeps) {}

  /** The effective georeferencing: this session's latest write, or the source minus its deletions. */
  get(): GeoreferencingState {
    const top = this.current();
    if (top) return top.state;
    const view = this.deps.view();
    return readSourceGeoreferencing(this.deps.store, this.deps.modelId, view ? (id) => view.isDeleted(id) : undefined);
  }

  write(request: GeoreferencingWriteRequest): GeoreferencingWriteResult {
    const prior = this.current();
    const { store, modelId } = this.deps;
    this.deps.editor();
    const view = this.deps.view();
    if (!view) throw new Error('georef: the session has no mutation view to record the write in');
    const facts = collectGeorefModelFacts(this.deps.store, {
      isDeleted: (id) => view.isDeleted(id),
      getForEntity: (id) => view.getForEntity(id),
    });
    const ctx = {
      modelId: this.deps.modelId, facts, current: this.get(), pending: prior?.pending ?? null,
      afterRemove: (withPropertySets: boolean) => readWithoutGeoreferencing(store, modelId, withPropertySets),
    };
    const plan: GeorefWritePlan = request.action === 'set' ? planSet(request.input, ctx)
      : request.action === 'update' ? planUpdate(request.input, ctx)
        : planRemove(ctx);

    const marker = recordCompoundMutation(view, (draft) => {
      const editor = new StoreEditor(this.deps.store, draft);
      for (const id of plan.tombstone) editor.removeEntity(id);
      for (const op of plan.propertySetOps) applyPropertySetOp(draft, op);
      return recordSessionMutation(draft, historyEntity(facts, plan), GEOREF_SESSION_KIND);
    });
    this.writes.push({ marker: marker.id, pending: plan.georefMutations, state: plan.next });
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
    const m = this.current()?.pending;
    if (!m) return undefined;
    const any = Object.keys(m.projectedCRS ?? {}).length > 0 || Object.keys(m.mapConversion ?? {}).length > 0;
    return any ? m : undefined;
  }

  hasPendingChanges(): boolean {
    return this.current() !== null;
  }

  /**
   * The latest write still in the mutation history. `mutation_undo` reverts
   * a recorded compound as a whole, marker included, so a write is either
   * entirely in the history (and current, unless a later one is) or entirely
   * gone; there is no half-undone write to export.
   */
  private current(): AppliedWrite | null {
    if (this.writes.length === 0) return null;
    const history = this.deps.view()?.getMutations() ?? [];
    const inHistory = (marker: string) => {
      for (let i = history.length - 1; i >= 0; i--) if (history[i].id === marker) return true;
      return false;
    };
    while (this.writes.length > 0 && !inHistory(this.writes[this.writes.length - 1].marker)) this.writes.pop();
    return this.writes[this.writes.length - 1] ?? null;
  }
}

/**
 * A georeferencing write the exporter refused or wrote only in part
 * (`stats.georeferencingWarnings`) must not come back as a file that
 * silently lacks it: throw instead of returning that file.
 */
export function assertGeorefWritten(warnings: readonly string[] | undefined, schema: string): void {
  if (!warnings?.length) return;
  throw new Error(`export.ifc: this session's georeferencing write cannot be written to this ${schema} file as given, so no file was produced:\n- ${warnings.join('\n- ')}`);
}

/** A positive entity for the history marker: the anchor the write concerns. */
function historyEntity(facts: GeorefModelFacts, plan: GeorefWritePlan): number {
  const id = plan.storage === 'propertySets'
    ? facts.sites[0] ?? facts.ePSetMapConversion?.hostId ?? facts.ePSetProjectedCRS?.hostId
    : facts.contexts[0] ?? plan.tombstone[0];
  if (id === undefined) throw new Error('georef: no entity to record the write against');
  return id;
}

function applyPropertySetOp(view: MutablePropertyView, op: PropertySetOp): void {
  if (op.op === 'deleteSet') {
    view.deletePropertySet(op.hostId, op.pset);
  } else if (op.op === 'deleteProperty') {
    view.deleteProperty(op.hostId, op.pset, op.prop);
  } else {
    const valueType = typeof op.value === 'number' ? PropertyValueType.Real
      : op.dataType === 'IfcText' ? PropertyValueType.Text : PropertyValueType.Label;
    view.setProperty(op.hostId, op.pset, op.prop, op.value, valueType, undefined, false, op.dataType);
  }
}
