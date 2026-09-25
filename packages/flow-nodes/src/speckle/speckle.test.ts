/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The pure halves of `speckle.receive` (#5634): URL parsing, unit tables,
 * and mapping refusals the corpus replay does not reach.
 */

import { describe, expect, it } from 'vitest';
import { corpusObjects, type CorpusObject } from '../__tests__/speckle-server.js';
import type { SpeckleObject } from './client.js';
import { mapSpeckleGraph } from './mapping.js';
import { psetRows, type SpeckleParameter } from './parameters.js';
import { lengthScale, parameterScale } from './units.js';
import { parseSpeckleUrl } from './url.js';

describe('parseSpeckleUrl', () => {
  it('reads the model, pinned-version, legacy commit and legacy object forms', () => {
    expect(parseSpeckleUrl('https://app.speckle.systems/projects/abc123/models/def456')).toEqual({
      kind: 'version', server: 'https://app.speckle.systems', projectId: 'abc123', modelId: 'def456', versionId: undefined,
    });
    expect(parseSpeckleUrl('app.speckle.systems/projects/abc123/models/def456@789fed?x=1')).toEqual({
      kind: 'version', server: 'https://app.speckle.systems', projectId: 'abc123', modelId: 'def456', versionId: '789fed',
    });
    expect(parseSpeckleUrl('https://speckle.xyz/streams/s1/commits/c1')).toEqual({ kind: 'version', server: 'https://speckle.xyz', projectId: 's1', versionId: 'c1' });
    expect(parseSpeckleUrl('https://speckle.xyz/streams/s1/objects/o1')).toEqual({ kind: 'object', server: 'https://speckle.xyz', projectId: 's1', objectId: 'o1' });
  });

  it('keeps an explicit non-https scheme so the network gate refuses it by name', () => {
    expect(parseSpeckleUrl('http://speckle.local/streams/s1/objects/o1').server).toBe('http://speckle.local');
  });

  it('refuses federated views and URLs that address nothing', () => {
    expect(() => parseSpeckleUrl('https://app.speckle.systems/projects/p/models/a,b')).toThrow(/several models/);
    expect(() => parseSpeckleUrl('https://app.speckle.systems/projects/p')).toThrow(/not a Speckle model, version, commit or object URL/);
    expect(() => parseSpeckleUrl('https://app.speckle.systems/projects/p/models/')).toThrow(/no usable model id/);
    expect(() => parseSpeckleUrl('')).toThrow(/"url" is required/);
  });
});

describe('units', () => {
  it('scales Speckle length units and Revit parameter units to SI', () => {
    expect(lengthScale('mm')).toBe(0.001);
    expect(lengthScale('Feet')).toBe(0.3048);
    expect(lengthScale('none')).toBeUndefined();
    expect(parameterScale('Centimeters')).toEqual({ quantity: 'length', factor: 0.01 });
    expect(parameterScale('Square feet')?.factor).toBeCloseTo(0.09290304, 10);
    expect(parameterScale('m³')).toEqual({ quantity: 'volume', factor: 1 });
    expect(parameterScale('Currency')).toBeUndefined();
  });
});

/** The corpus with one object replaced by `edit(original)`. */
function graphWith(appSuffix: string, edit: (o: CorpusObject) => CorpusObject): { objects: Map<string, SpeckleObject>; rootId: string } {
  const objects = new Map<string, SpeckleObject>(corpusObjects().map((o) => [o.id, o.applicationId === `0d3c1f2a-5e6b-4c7d-8e9f-a0b1c2d3e4f5-${appSuffix}` ? edit(o) : o]));
  return { objects, rootId: corpusObjects()[0].id };
}

/** Element refusals (display-geometry and property-entry counts aside) for a graph. */
function elementRefusals(graph: { objects: Map<string, SpeckleObject>; rootId: string }): string[] {
  return mapSpeckleGraph(graph.objects, graph.rootId).refusals.list()
    .filter((r) => r.reason !== 'display-meshes' && r.reason !== 'non-parameter-entries')
    .map((r) => r.message);
}

/** The refusals an edit ADDS to the unedited corpus's own. */
function refusalFor(appSuffix: string, edit: (o: CorpusObject) => CorpusObject): string[] {
  const baseline = new Set(elementRefusals(graphWith('', (o) => o)));
  return elementRefusals(graphWith(appSuffix, edit)).filter((m) => !baseline.has(m));
}

describe('mapping refusals', () => {
  it('refuses a slanted column and a rotated one', () => {
    const slanted = (o: CorpusObject) => ({ ...o, baseLine: { ...(o.baseLine as object), end: { x: 3500, y: 2000, z: 3000, units: 'mm', speckle_type: 'Objects.Geometry.Point' } } });
    expect(refusalFor('300301', slanted)).toEqual(['1 RevitColumn object not written: is slanted; v1 writes vertical columns only.']);
    expect(refusalFor('300301', (o) => ({ ...o, rotation: 0.5 }))).toEqual(['1 RevitColumn object not written: is rotated about its axis, which the column writer cannot express.']);
  });

  it('refuses a wall without a width parameter, and an element without length units', () => {
    expect(refusalFor('300101', (o) => ({ ...o, properties: null }))).toEqual(['1 RevitWall object not written: no positive WALL_ATTR_WIDTH_PARAM parameter (Width).']);
    expect(refusalFor('300102', (o) => ({ ...o, units: 'none' }))).toEqual(['1 RevitWall object not written: units "none" is not a length unit.']);
  });

  it('refuses a sloped floor and an outline with a gap', () => {
    expect(refusalFor('300201', (o) => ({ ...o, slope: 2 }))).toEqual(['1 RevitFloor object not written: is sloped; v1 writes flat slabs and roofs only.']);
    const gapped = (o: CorpusObject) => {
      const outline = o.outline as { segments: Array<Record<string, unknown>> };
      const segments = [...outline.segments];
      segments[1] = { ...segments[1], start: { x: 6100, y: 0, z: 0, units: 'mm', speckle_type: 'Objects.Geometry.Point' } };
      return { ...o, outline: { ...outline, segments } };
    };
    expect(refusalFor('300201', gapped)).toEqual(['1 RevitFloor object not written: has an outline with a gap between segments.']);
  });

  it('refuses a dimension whose unit label is not a supported length unit, never reading it as metres (#5925 review)', () => {
    for (const units of ['Feet and fractional inches', 'Meters and centimeters', 'Fractional inches']) {
      const width = (o: CorpusObject) => {
        const props = structuredClone(o.properties) as Record<string, Record<string, Record<string, Record<string, unknown>>>>;
        props['Type Parameters'].Construction.Width.units = units;
        return { ...o, properties: props };
      };
      expect(refusalFor('300101', width)).toEqual([
        `1 RevitWall object not written: WALL_ATTR_WIDTH_PARAM has unit "${units}", which is not a supported length unit (Width).`,
      ]);
    }
    const unitless = (o: CorpusObject) => {
      const props = structuredClone(o.properties) as Record<string, Record<string, Record<string, Record<string, unknown>>>>;
      delete props['Type Parameters'].Construction.Width.units;
      return { ...o, properties: props };
    };
    expect(refusalFor('300101', unitless)).toEqual(['1 RevitWall object not written: WALL_ATTR_WIDTH_PARAM has unit "(none)", which is not a supported length unit (Width).']);
  });
});

describe('display geometry and property rows (#5925 review)', () => {
  it('counts display meshes under every display key the client skips', () => {
    const ref = (id: string) => ({ speckle_type: 'reference', referencedId: id });
    const { objects, rootId } = graphWith('300101', (o) => {
      const { displayValue, ...rest } = o;
      void displayValue;
      return { ...rest, '@displayValue': [ref('a'), ref('b')], displayMesh: ref('c'), '@displayMesh': [ref('d')] } as CorpusObject;
    });
    const wall = mapSpeckleGraph(objects, rootId).planned.find((p) => p.key.endsWith('300101'));
    expect(wall?.displayMeshes).toBe(4);
  });

  it('keeps parameters named after Object.prototype members as ordinary rows', () => {
    const params: SpeckleParameter[] = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'].map((name) => ({ scope: 'instance', name, value: `v-${name}` }));
    const rows = psetRows(params, 'instance');
    expect(Object.entries(rows)).toEqual([['__proto__', 'v-__proto__'], ['constructor', 'v-constructor'], ['toString', 'v-toString'], ['hasOwnProperty', 'v-hasOwnProperty']]);
  });
});
