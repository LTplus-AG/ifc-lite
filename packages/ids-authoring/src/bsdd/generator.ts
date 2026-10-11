/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Dictionary → IDS (05-bsdd.md §2.3, IDS-072). Selected classes of one
 * dictionary become specifications: one per class, or one per related IFC
 * entity with a classification enumeration. Properties come from the class
 * and, optionally, its ancestors in the bSDD hierarchy; scope is the
 * required properties only or all of them.
 *
 * `planDictionaryIds` is pure and returns `bulk.fromBsddClass` ops; the host
 * previews them (`previewDictionaryIds`: gate, counts, lint summary on a
 * dry run) and commits them as ONE history transaction, so one undo
 * removes the whole import.
 */

import type { IFCVersion } from '@ifc-lite/ids';
import type { Section, StudioDocument } from '../document/types.js';
import type { GateContext } from '../gate/context.js';
import { checkOps } from '../gate/check.js';
import type { GateResult } from '../gate/types.js';
import { createLinter } from '../lint/engine.js';
import type { LintContext, LintSeverity } from '../lint/types.js';
import type { BsddClassSnapshot, BulkFromBsddClassOp, SpecCardinality } from '../ops/types.js';
import { apply } from '../reducer/apply.js';
import { uuidv7, type Uuid } from '../uuid.js';
import { effectiveProperties } from './dictionary.js';
import { snapshotBsddClass } from './insert.js';
import { BsddMappingError, mapBsddProperty } from './mapping.js';
import type { BsddClass, BsddClassProperty, BsddDictionary } from './types.js';

export interface DictionaryIdsOptions {
  ifcVersions: IFCVersion[];
  /** `perClass`: one spec per class. `perEntity`: one spec per related IFC entity, classes as an enumeration. */
  grouping?: 'perClass' | 'perEntity';
  /** Include properties inherited from parent classes. Default true. */
  inheritProperties?: boolean;
  /** `required`: only properties bSDD marks required. Default `all`. */
  propertyScope?: 'required' | 'all';
  /**
   * Cardinality of each generated specification. Default `optional`: the
   * requirements apply to the classified elements a model has, without
   * demanding that every class occurs (lint IDSL-CARD-004 flags the latter).
   */
  cardinality?: SpecCardinality;
  /** Where the classification facet goes. Default `applicability`. */
  classificationSection?: Section;
  /** Property set for properties without one; without it they are skipped (and noted). */
  fallbackPropertySet?: string;
  /** Generate classes bSDD marks inactive too. Default false (they are skipped, and noted). */
  includeInactive?: boolean;
}

export interface PlannedSpec {
  specId: Uuid;
  name: string;
  classCodes: string[];
  entities: string[];
  properties: string[];
}

export interface DictionaryIdsPlan {
  ops: BulkFromBsddClassOp[];
  specs: PlannedSpec[];
  /** What was left out and why. */
  notes: string[];
}

export interface DictionaryIdsInput {
  dictionary: BsddDictionary;
  /** Classes by URI: the selection and (for inheritance) their ancestors. */
  classes: ReadonlyMap<string, BsddClass>;
  /** URIs of the classes to generate, in the order wanted. */
  selected: readonly string[];
  options: DictionaryIdsOptions;
  /** Schema tables: split `IfcWallSOLIDWALL`-style names, drop entities unknown in the versions, keep standard data types. */
  gate?: GateContext;
  newId?: () => Uuid;
}

function entityKnown(gate: GateContext | undefined, versions: readonly IFCVersion[], name: string): boolean {
  return !gate || versions.every((v) => gate.tables[v].entities.has(name.toUpperCase()));
}

function scoped(props: readonly BsddClassProperty[], scope: 'required' | 'all'): BsddClassProperty[] {
  return scope === 'required' ? props.filter((p) => p.isRequired === true) : [...props];
}

/** Plan the specifications for a dictionary selection. Pure. */
export function planDictionaryIds(input: DictionaryIdsInput): DictionaryIdsPlan {
  const { dictionary, classes, options, gate } = input;
  const versions = options.ifcVersions;
  const newId = input.newId ?? uuidv7;
  const notes: string[] = [];
  const snapshots: BsddClassSnapshot[] = [];
  for (const uri of new Set(input.selected)) {
    const cls = classes.get(uri);
    if (!cls) {
      notes.push(`${uri}: not loaded; skipped`);
      continue;
    }
    if (cls.dictionaryUri && cls.dictionaryUri !== dictionary.uri) {
      notes.push(`${cls.code}: belongs to another dictionary; skipped`);
      continue;
    }
    if (cls.status === 'inactive' && !options.includeInactive) {
      notes.push(`${cls.code}: inactive in bSDD; skipped`);
      continue;
    }
    const all = options.inheritProperties === false ? cls.properties : effectiveProperties(cls, classes);
    const snap = snapshotBsddClass(cls, { dictionaryName: dictionary.name, gate, versions, properties: scoped(all, options.propertyScope ?? 'all') });
    snap.properties = (snap.properties ?? []).filter((p) => {
      try {
        mapBsddProperty(p, options.fallbackPropertySet ? { fallbackPropertySet: options.fallbackPropertySet } : {});
        return true;
      } catch (err) {
        if (!(err instanceof BsddMappingError)) throw err;
        notes.push(`${cls.code}.${p.code}: ${err.message}; skipped`);
        return false;
      }
    });
    const known = (snap.relatedIfcEntities ?? []).filter((r) => entityKnown(gate, versions, r.entity));
    for (const r of snap.relatedIfcEntities ?? []) {
      if (!known.includes(r)) notes.push(`${cls.code}: related entity ${r.entity} does not exist in ${versions.join(', ')}; left out`);
    }
    snapshots.push({ ...snap, relatedIfcEntities: known });
  }
  const groups = options.grouping === 'perEntity' ? groupByEntity(snapshots, notes) : snapshots.map((s) => ({ key: s.code, classes: [s], entity: undefined }));
  const plan: DictionaryIdsPlan = { ops: [], specs: [], notes };
  for (const g of groups) {
    const specId = newId();
    const first = g.classes[0];
    const name = g.entity ? `${g.entity} (${dictionary.name})` : `${first.name} (${first.code})`;
    const propCodes = commonProperties(g.classes, notes);
    const entities = g.entity ? [g.entity] : [...new Set((first.relatedIfcEntities ?? []).map((r) => r.entity))];
    const op: BulkFromBsddClassOp = {
      kind: 'bulk.fromBsddClass',
      opId: newId(),
      payload: {
        classes: g.classes.map((c) => ({ ...c, properties: (c.properties ?? []).filter((p) => propCodes.includes(p.code)) })),
        target: {
          newSpec: {
            specId,
            name,
            ifcVersions: versions,
            cardinality: options.cardinality ?? 'optional',
            ...(g.classes.length === 1 ? { identifier: first.code } : {}),
            ...(g.classes.length === 1 && classes.get(first.uri)?.definition ? { description: classes.get(first.uri)?.definition } : {}),
          },
        },
        classification: { section: options.classificationSection ?? 'applicability' },
      },
    };
    if (entities.length) op.payload.entity = { section: 'applicability', entities };
    else notes.push(`${g.classes.map((c) => c.code).join(', ')}: no known related IFC entity; the specification applies by classification only`);
    if (propCodes.length) {
      op.payload.properties = { select: propCodes, ...(options.fallbackPropertySet ? { fallbackPropertySet: options.fallbackPropertySet } : {}) };
    }
    plan.ops.push(op);
    plan.specs.push({ specId, name, classCodes: g.classes.map((c) => c.code), entities, properties: propCodes });
  }
  return plan;
}

/** One group per related entity (a class's first related entity decides). */
function groupByEntity(snapshots: readonly BsddClassSnapshot[], notes: string[]): { key: string; classes: BsddClassSnapshot[]; entity?: string }[] {
  const groups = new Map<string, { key: string; classes: BsddClassSnapshot[]; entity?: string }>();
  for (const s of snapshots) {
    const entity = s.relatedIfcEntities?.[0]?.entity;
    if (!entity) {
      notes.push(`${s.code}: no known related IFC entity; generated as its own specification`);
      groups.set(`class:${s.code}`, { key: s.code, classes: [s] });
      continue;
    }
    if ((s.relatedIfcEntities ?? []).some((r) => r.entity !== entity)) notes.push(`${s.code}: grouped under ${entity}, its first related entity`);
    const g = groups.get(entity) ?? { key: entity, classes: [], entity };
    g.classes.push({ ...s, relatedIfcEntities: [{ entity }] });
    groups.set(entity, g);
  }
  return [...groups.values()];
}

/** Property codes defined (with the same set) on every class of a group. */
function commonProperties(classes: readonly BsddClassSnapshot[], notes: string[]): string[] {
  const [first, ...rest] = classes;
  const out: string[] = [];
  for (const p of first.properties ?? []) {
    if (out.includes(p.code)) continue;
    const everywhere = rest.every((c) => c.properties?.some((q) => q.code === p.code && q.propertySet === p.propertySet));
    if (everywhere) out.push(p.code);
    else notes.push(`${p.code}: not defined on every class of ${classes.map((c) => c.code).join(', ')}; left out of the shared specification`);
  }
  return out;
}

export interface DictionaryIdsPreview {
  specCount: number;
  applicabilityFacets: number;
  requirements: number;
  gate: GateResult;
  /** Lint findings of the document after the import, by severity and by code. */
  lint: Record<LintSeverity, number> & { byCode: Record<string, number> };
  /** The document the plan produces (when the gate accepts it). */
  result?: StudioDocument;
}

/** Dry-run the plan on `doc`: gate it, apply it to a copy, lint the result. */
export function previewDictionaryIds(doc: StudioDocument, plan: DictionaryIdsPlan, lint: LintContext): DictionaryIdsPreview {
  const gate = checkOps(plan.ops, doc, lint.gate);
  const byCode: Record<string, number> = {};
  const counts = { error: 0, warning: 0, info: 0, byCode };
  if (!gate.ok) return { specCount: plan.specs.length, applicabilityFacets: 0, requirements: 0, gate, lint: counts };
  const result = apply(doc, plan.ops).doc;
  const created = new Set(plan.specs.map((s) => s.specId));
  const specs = result.ids.specifications.filter((s) => created.has(s.id));
  for (const d of createLinter(lint).lint(result).diagnostics) {
    if (d.specId && !created.has(d.specId)) continue;
    counts[d.severity]++;
    counts.byCode[d.code] = (counts.byCode[d.code] ?? 0) + 1;
  }
  return {
    specCount: specs.length,
    applicabilityFacets: specs.reduce((n, s) => n + s.applicability.facets.length, 0),
    requirements: specs.reduce((n, s) => n + s.requirements.length, 0),
    gate,
    lint: counts,
    result,
  };
}
