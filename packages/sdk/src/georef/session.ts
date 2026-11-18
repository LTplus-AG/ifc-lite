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
import { isExpressibleMapUnit } from '@ifc-lite/export';
import { PropertyValueType } from '@ifc-lite/data';
import { recordCompoundMutation, recordSessionMutation, StoreEditor, type MutablePropertyView } from '@ifc-lite/mutations';
import { collectGeorefModelFacts, storageForSchema, type GeorefModelFacts } from './model-facts.js';
import { conventionSetsOf, decodeNumber, sourceOrderConflicts } from './epset-locator.js';
import { CRS_FIELDS, MC_FIELDS, exporterKey, planRemove, planSet, stateAfter, type GeorefWritePlan, type PropertySetOp, type StepGeorefMutations } from './plan.js';
import { withAttributeEdits } from './attribute-overlay.js';
import { assertWritable, assessTrust } from './trust.js';
import { planUpdate } from './plan-update.js';
import { compact, readSourceGeoreferencing, readWithoutGeoreferencing, rotationOf } from './read.js';
import { planSiteWrite, withSiteEdits } from './site-write.js';
import { GeoreferencingError, type GeorefSiteInput, type GeorefSiteWriteResult, type GeorefMapConversionAttributes, type GeorefProjectedCRSAttributes, type GeoreferencingState, type GeoreferencingWriteRequest, type GeoreferencingWriteResult } from './types.js';

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
   * history is inactive here; undoing a host deletion may restore its marker.
   */
  private writes: AppliedWrite[] = [];
  private siteEditIds = new Set<string>();

  constructor(private readonly deps: GeoreferencingSessionDeps) {}

  /** The effective georeferencing: this session's latest write, or the source minus its deletions; IfcSite edits applied. */
  get(): GeoreferencingState {
    // A snapshot: the caller may change what it gets without changing the session's own record of its writes.
    const state = withSiteEdits(structuredClone(this.read()), this.deps.store, this.deps.view());
    const view = this.deps.view();
    if (!view) {
      const native = (state.MapConversion && state.MapConversion.type !== 'ePSet_MapConversion') || state.RigidOperation;
      const why = native ? [] : sourceOrderConflicts(this.deps.store);
      return why.length > 0 ? { ...state, untrusted: why } : state;
    }
    const { reasons, foreign } = this.trust(state, view);
    const untrusted = Object.entries(reasons).filter(([part]) => part !== 'site' || state.site).flatMap(([, why]) => why);
    if (untrusted.length === 0) return state;
    // A unit read from an untrusted CRS (or unit record) is not carried into a write: the existing unresolved-unit refusal applies.
    const unitUnsettled = !!(reasons.ProjectedCRS || reasons.MapUnit || reasons.ePSet || foreign.length) && state.ProjectedCRS?.MapUnit !== undefined;
    return { ...state, untrusted, ...(unitUnsettled && state.ProjectedCRS ? { ProjectedCRS: { ...state.ProjectedCRS, mapUnitResolved: false } } : {}) };
  }

  /** Trust in what `state` is read from. A change to a convention set only matters while the state is read from one. */
  private trust(state: GeoreferencingState, view: MutablePropertyView) {
    const assessed = assessTrust(this.deps.store, view, this.current()?.pending ?? null);
    const trust = { reasons: { ...assessed.reasons }, foreign: assessed.foreign };
    // The convention sets are read back live for IFC2X3 only; elsewhere an edited or created copy is not reflected.
    // Which copy the reader takes is known only while the session left the copies alone.
    const sets = conventionSetsOf(this.deps.store, view);
    const why = [...sets.ambiguous, ...(storageForSchema(String(this.deps.store.schemaVersion ?? '')) === 'entities' && sets.touched ? ['convention sets were changed outside bim.georef, which is not read back in this schema'] : [])];
    // An IfcMapConversion or IfcRigidOperation governs: the reader never reaches the sets.
    if (why.length > 0 && !(state.MapConversion && state.MapConversion.type !== 'ePSet_MapConversion') && !state.RigidOperation) trust.reasons.ePSet = why;
    return trust;
  }

  /** IfcSite RefLatitude/RefLongitude/RefElevation, as one compound mutation (one undo step). */
  writeSite(input: GeorefSiteInput): GeorefSiteWriteResult {
    this.deps.editor();
    const view = this.deps.view();
    if (!view) throw new Error('georef: the session has no mutation view to record the write in');
    const plan = planSiteWrite(this.deps.store, view, input, this.siteEditIds);
    const recorded: string[] = [];
    recordCompoundMutation(view, (draft) => {
      for (const [slot, value] of plan.edits) recorded.push(draft.setPositionalAttribute(plan.siteId, slot, value).id);
      return recordSessionMutation(draft, plan.siteId, GEOREF_SESSION_KIND);
    });
    for (const id of recorded) this.siteEditIds.add(id);
    return plan.result;
  }

  /** Throws what `writeSite(input)` would, without writing. */
  validateSite(input: GeorefSiteInput): void {
    planSiteWrite(this.deps.store, this.deps.view(), input, this.siteEditIds);
  }

  private read(): GeoreferencingState {
    const top = this.current();
    const view = this.deps.view();
    if (top) {
      // IFC2X3 keeps its georeferencing in ordinary property sets, which any later edit can create or change: read them
      // back whenever there are any, also after a remove() that left the cached state empty.
      if (top.state.storage === 'propertySets' && view && (top.state.hasGeoreference || conventionSetsOf(this.deps.store, view).copies.length > 0)) return this.liveEPSetState();
      // A record the cached state names was deleted outside bim.georef (generic store API): the
      // cache describes a file the export will not write, so report the source minus deletions.
      // The pending edit still stands (the exporter refuses to create from it), hence `pending`.
      if (view && [top.state.ProjectedCRS, top.state.MapConversion, top.state.RigidOperation, top.state.site].some((r) => r?.expressId !== undefined && view.isDeleted(r.expressId))) {
        return { ...withAttributeEdits(withPendingFields(readSourceGeoreferencing(this.deps.store, this.deps.modelId, (id) => view.isDeleted(id)), top.pending), view, top.pending), pending: true };
      }
      return view ? withAttributeEdits(top.state, view, top.pending) : top.state;
    }
    const source = readSourceGeoreferencing(this.deps.store, this.deps.modelId, view ? (id) => view.isDeleted(id) : undefined);
    // No georeferencing write, but an ordinary property edit of an IFC2X3 convention set
    // changes what the export says: read the sets back from the overlay, as after a write.
    return view && source.storage === 'propertySets' && conventionSetsOf(this.deps.store, view).touched
      ? this.liveEPSetState()
      : view ? withAttributeEdits(source, view) : source;
  }

  write(request: GeoreferencingWriteRequest): GeoreferencingWriteResult {
    const prior = this.current();
    const { store, modelId } = this.deps;
    this.deps.editor();
    const view = this.deps.view();
    if (!view) throw new Error('georef: the session has no mutation view to record the write in');
    const facts = collectGeorefModelFacts(this.deps.store, view);
    if (facts.unknown.length > 0) {
      throw new GeoreferencingError('UNSUPPORTED_RECORD', `The model's entities that georeferencing is planned from cannot be read reliably after the session's generic edits (${facts.unknown.join('; ')}), so nothing was written.`);
    }
    const current = this.get();
    assertWritable(request.action, this.trust(current, view));
    const ctx = {
      modelId: this.deps.modelId, facts, current, pending: prior?.pending ?? null,
      afterRemove: (withPropertySets: boolean) => readWithoutGeoreferencing(store, modelId, withPropertySets, (id) => view.isDeleted(id)),
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
    this.writes.push({ marker: marker.id, pending: plan.georefMutations, state: structuredClone(plan.next) });
    return {
      action: plan.action,
      storage: plan.storage,
      state: plan.next,
      removed: plan.removed,
      mapUnit: plan.mapUnit,
      notes: plan.notes,
    };
  }

  /**
   * An IFC2X3 write lives in ordinary property sets, which any later property
   * edit or deletion can change; read them back from the overlay so `get()`
   * stays what the export will say. The reader takes `ePSet_ProjectedCRS`
   * only alongside an `ePSet_MapConversion`, so without one nothing is
   * georeferenced (the IfcSite fallback aside).
   */
  private liveEPSetState(): GeoreferencingState {
    const view = this.deps.view();
    const none = () => readWithoutGeoreferencing(this.deps.store, this.deps.modelId, true, view ? (id) => view.isDeleted(id) : undefined);
    if (!view) return none();
    const facts = collectGeorefModelFacts(this.deps.store, view);
    const text = (value: unknown) => typeof value === 'number' ? String(value)
      : typeof value === 'string' && value.length > 0 ? value : undefined;
    const pick = (loc: GeorefModelFacts['ePSetMapConversion'], fields: readonly string[], numeric = false) =>
      loc ? Object.fromEntries(fields.map((f) => [f, numeric ? decodeNumber(loc.values[f]) : text(loc.values[f])]).filter(([, value]) => value !== undefined)) : null;
    const mc = pick(facts.ePSetMapConversion, MC_FIELDS, true);
    const crs = pick(facts.ePSetProjectedCRS, CRS_FIELDS);
    if (!mc) return none();
    const state = stateAfter({ modelId: this.deps.modelId, facts }, 'propertySets', crs as GeorefProjectedCRSAttributes | null, mc as unknown as GeorefMapConversionAttributes);
    // The unit's resolution is the source reading's while the label is the file's own; a label the session
    // wrote or an edit changed is resolved only when the writer can express it. Never marked resolved by presence alone.
    const unit = state.ProjectedCRS?.MapUnit;
    if (state.ProjectedCRS && unit !== undefined) {
      const fromFile = readSourceGeoreferencing(this.deps.store, this.deps.modelId).ProjectedCRS;
      state.ProjectedCRS.mapUnitResolved = unit === fromFile?.MapUnit ? fromFile.mapUnitResolved !== false : isExpressibleMapUnit(String(unit));
    }
    return state;
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
    for (let i = this.writes.length - 1; i >= 0; i--) if (inHistory(this.writes[i].marker)) return this.writes[i];
    return null;
  }
}

/** The fields this session's write still holds for the records that survive: the export applies them to those. */
function withPendingFields(state: GeoreferencingState, pending: StepGeorefMutations | null): GeoreferencingState {
  const over = <T extends object>(record: T | null, fields: readonly string[], changes: object | undefined): T | null =>
    record && changes ? compact({ ...record, ...Object.fromEntries(fields.filter((f) => (changes as Record<string, unknown>)[exporterKey(f)] !== undefined).map((f) => [f, (changes as Record<string, unknown>)[exporterKey(f)]])) }) as T : record;
  const MapConversion = over(state.MapConversion, MC_FIELDS, pending?.mapConversion);
  return { ...state, MapConversion, ProjectedCRS: over(state.ProjectedCRS, CRS_FIELDS.filter((f) => f !== 'MapUnit'), pending?.projectedCRS), rotationDegrees: MapConversion ? rotationOf(MapConversion) : state.rotationDegrees };
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
  if (op.op === 'createSet') {
    view.createPropertySet(op.hostId, op.pset, []);
  } else if (op.op === 'deleteSet') {
    view.deletePropertySet(op.hostId, op.pset);
  } else if (op.op === 'deleteProperty') {
    view.deleteProperty(op.hostId, op.pset, op.prop);
  } else {
    const valueType = typeof op.value === 'number' ? PropertyValueType.Real
      : op.dataType === 'IfcText' ? PropertyValueType.Text : PropertyValueType.Label;
    view.setProperty(op.hostId, op.pset, op.prop, op.value, valueType, undefined, false, op.dataType);
  }
}
