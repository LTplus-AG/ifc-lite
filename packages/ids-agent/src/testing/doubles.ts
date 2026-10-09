/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Test doubles for the host bridges. The model loop (P-05) and the bSDD
 * client (P-06) are built elsewhere; these answer from fixed data so the
 * agent's tools can be tested, and so an eval can run without a model or a
 * network.
 */

import type { IDSFacet } from '@ifc-lite/ids';
import type {
  BsddClassCard,
  BsddClient,
  BsddPropertyCard,
  BsddResolution,
  ClassCount,
  DistinctValues,
  FunnelCounts,
  InferenceResult,
  ModelBridge,
  ModelSummary,
} from '../bridges.js';

export interface FakeElement {
  /** PascalCase class. */
  entity: string;
  /** `Pset.Property` → value. */
  properties?: Record<string, string>;
}

function literal(constraint: unknown): string | undefined {
  const c = constraint as { type?: string; value?: unknown } | undefined;
  return c?.type === 'simpleValue' && typeof c.value === 'string' ? c.value : undefined;
}

/** A crude facet matcher over fake elements: entity names and literal property names only. */
function matches(element: FakeElement, facet: IDSFacet): boolean {
  if (facet.type === 'entity') return literal(facet.name)?.toUpperCase() === element.entity.toUpperCase();
  if (facet.type === 'property') {
    const key = `${literal(facet.propertySet)}.${literal(facet.baseName)}`;
    return element.properties?.[key] !== undefined;
  }
  return true;
}

/** A `ModelBridge` over a list of fake elements, recording every call. */
export function createFakeModelBridge(elements: readonly FakeElement[], schema = 'IFC4'): ModelBridge & { calls: string[] } {
  const calls: string[] = [];
  const classes = (): ClassCount[] => {
    const counts = new Map<string, number>();
    for (const e of elements) counts.set(e.entity, (counts.get(e.entity) ?? 0) + 1);
    return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  };
  return {
    calls,
    async stats(): Promise<ModelSummary[]> {
      calls.push('stats');
      return [{ id: 'model-1', schema, elementCount: elements.length, classes: classes(), lengthUnit: 'METRE' }];
    },
    async count(query): Promise<FunnelCounts> {
      calls.push('count');
      let set = [...elements];
      const stages = [{ facetIndex: -1, count: set.length }];
      query.applicability.forEach((f, i) => { set = set.filter((e) => matches(e, f)); stages.push({ facetIndex: i, count: set.length }); });
      const passing = query.requirements ? set.filter((e) => query.requirements?.every((f) => matches(e, f))).length : undefined;
      return { stages, applicable: set.length, ...(passing !== undefined ? { passing, failing: set.length - passing } : {}) };
    },
    async distinctValues(query): Promise<DistinctValues> {
      calls.push('distinctValues');
      const counts = new Map<string, number>();
      for (const e of elements) {
        if (query.entity && e.entity.toUpperCase() !== query.entity.toUpperCase()) continue;
        const v = e.properties?.[`${query.propertySet}.${query.property}`];
        if (v !== undefined) counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      const values = [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
      return { values: values.slice(0, query.limit), truncated: values.length > query.limit };
    },
    async infer(query): Promise<InferenceResult> {
      calls.push('infer');
      const examples = elements.filter((e) => !query.entity || e.entity.toUpperCase() === query.entity.toUpperCase());
      const keys = new Set(examples.flatMap((e) => Object.keys(e.properties ?? {})));
      return {
        sampled: false,
        candidates: [...keys].map((key) => {
          const [pset, prop] = key.split('.');
          const matched = examples.filter((e) => e.properties?.[key] !== undefined).length;
          return { section: 'requirements' as const, positives: { matched, total: examples.length },
            facet: { type: 'property' as const, propertySet: { type: 'simpleValue' as const, value: pset }, baseName: { type: 'simpleValue' as const, value: prop } } };
        }).filter((c) => c.positives.matched / Math.max(1, c.positives.total) >= query.threshold),
      };
    },
    async coverage(query): Promise<ClassCount[]> {
      calls.push('coverage');
      const governed = (e: FakeElement) => query.applicabilities.some((facets) => facets.length > 0 && facets.every((f) => matches(e, f)));
      const counts = new Map<string, number>();
      for (const e of elements) if (!governed(e)) counts.set(e.entity, (counts.get(e.entity) ?? 0) + 1);
      return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    },
  };
}

export interface FakeBsddRecord {
  card: BsddClassCard;
  properties: BsddPropertyCard[];
}

/** A `BsddClient` answering from recorded class records, recording every request. */
export function createFakeBsddClient(records: readonly FakeBsddRecord[]): BsddClient & { requests: string[] } {
  const requests: string[] = [];
  const byUri = new Map(records.map((r) => [r.card.uri, r]));
  return {
    requests,
    async search(query) {
      requests.push(`search:${query.text}`);
      const text = query.text.toLowerCase();
      return records
        .filter((r) => (r.card.name.toLowerCase().includes(text) || r.card.code.toLowerCase().includes(text))
          && (!query.dictionaryUri || r.card.dictionaryUri === query.dictionaryUri)
          && (!query.relatedIfcEntity || (r.card.relatedIfcEntities ?? []).includes(query.relatedIfcEntity)))
        .slice(0, query.limit)
        .map(({ card }) => ({ uri: card.uri, code: card.code, name: card.name, dictionaryUri: card.dictionaryUri,
          ...(card.relatedIfcEntities ? { relatedIfcEntities: card.relatedIfcEntities } : {}) }));
    },
    async getClass(uri) { requests.push(`class:${uri}`); return byUri.get(uri)?.card ?? null; },
    async classProperties(uri) { requests.push(`properties:${uri}`); return byUri.get(uri)?.properties ?? []; },
    async resolveUri(uri): Promise<BsddResolution> {
      requests.push(`resolve:${uri}`);
      const record = byUri.get(uri);
      return record ? { kind: 'class', card: record.card } : { kind: 'unknown', uri };
    },
  };
}
