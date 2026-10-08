/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { IfcDataStore, ClassificationInfo } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { EntityRef } from '@/store/types';

// The same practical population ceiling as native artifact schema discovery.
// Detail row limits never restrict these facts; unread requested refs remain unknown.
const SCAN_LIMIT = 50_000;
const LABEL_LIMIT = 50;
const MODEL_LIMIT = 25;
const text = (value: string | null) => value === null ? null : value.slice(0, 240);
interface Source {
  store: IfcDataStore | null; view: MutablePropertyView | undefined; name: string;
  classificationsUnavailable: boolean;
  classifications: (id: number) => ClassificationInfo[];
}
interface Counts { requested: number; scanned: number; classified: number; unclassified: number; unknown: number }
interface Label {
  modelId: string; system: string | null; schema: string | null;
  Identification?: string | null; ItemReference?: string | null;
  elements: number; referenceRows: number; unverifiedReferenceRows: number; labelTruncated: boolean;
}
const empty = (): Counts => ({ requested: 0, scanned: 0, classified: 0, unclassified: 0, unknown: 0 });

/** #7238 counts native selected refs, not unique IFC classification identities inferred from text. */
export function selectedClassificationPopulation(refs: readonly EntityRef[], sourceFor: (modelId: string) => Source) {
  const total = empty();
  const models = new Map<string, Counts & { modelId: string; name: string }>();
  const labels = new Map<string, Label>();
  let unscanned = 0, unavailable = 0, missingTargets = 0;
  let referenceRows = 0, unverifiedReferenceRows = 0, referencesWithoutSystem = 0, referencesWithoutCode = 0;
  for (const ref of refs) {
    const source = sourceFor(ref.modelId);
    let model = models.get(ref.modelId);
    if (!model) { model = { ...empty(), modelId: ref.modelId, name: source.name }; models.set(ref.modelId, model); }
    total.requested++; model.requested++;
    if (total.scanned === SCAN_LIMIT) { total.unknown++; model.unknown++; unscanned++; continue; }
    total.scanned++; model.scanned++;
    if (!source.store || source.classificationsUnavailable) {
      total.unknown++; model.unknown++; unavailable++; continue;
    }
    const lookup = source.view?.resolveBaseEntityId(ref.expressId) ?? ref.expressId;
    if (source.view?.isDeleted(ref.expressId) || (!source.view?.getNewEntity(ref.expressId)
      && !source.store.entityIndex?.byId.has(lookup))) {
      total.unknown++; model.unknown++; missingTargets++; continue;
    }
    const entries = source.classifications(ref.expressId);
    if (entries.length === 0) { total.unclassified++; model.unclassified++; continue; }
    total.classified++; model.classified++;
    const seen = new Set<string>();
    for (const info of entries) {
      referenceRows++;
      unverifiedReferenceRows += Number(Boolean(info.unresolved));
      referencesWithoutSystem += Number(info.system === undefined);
      referencesWithoutCode += Number(info.identification === undefined);
      const system = info.system ?? null, code = info.identification ?? null;
      const schema = source.store.schemaVersion ?? null;
      // This key groups exact display values only. Equal labels do not establish equal IFC identities.
      const key = JSON.stringify([ref.modelId, schema, system, code]);
      let label = labels.get(key);
      if (!label) {
        label = { modelId: ref.modelId, schema, system: text(system),
          ...(schema?.toUpperCase() === 'IFC2X3' ? { ItemReference: text(code) } : { Identification: text(code) }),
          elements: 0, referenceRows: 0, unverifiedReferenceRows: 0,
          labelTruncated: (system?.length ?? 0) > 240 || (code?.length ?? 0) > 240 };
        labels.set(key, label);
      }
      label.referenceRows++; label.unverifiedReferenceRows += Number(Boolean(info.unresolved));
      if (!seen.has(key)) { label.elements++; seen.add(key); }
    }
  }
  const ordered = [...labels].sort(([a, x], [b, y]) => y.elements - x.elements || (a < b ? -1 : a > b ? 1 : 0));
  return { ...total, status: total.unknown ? 'partial' : 'complete', scanLimit: SCAN_LIMIT,
    unknownReasons: { unscanned, unavailable, missingTargets }, referenceRows, unverifiedReferenceRows,
    referencesWithoutSystem, referencesWithoutCode,
    models: [...models.values()].slice(0, MODEL_LIMIT), omittedModelGroups: Math.max(0, models.size - MODEL_LIMIT),
    labels: ordered.slice(0, LABEL_LIMIT).map(([, label]) => label), omittedLabelGroups: Math.max(0, labels.size - LABEL_LIMIT),
    labelGroupMeaning: 'Exact native system/code text grouped separately per model/schema, not unique IFC identities. elements counts requested refs carrying each label once; referenceRows retains native repeated entries. Null labels are unknown. Complete status describes membership coverage, not complete system/code attributes. Omitted groups remain outside the displayed distribution.',
  };
}
