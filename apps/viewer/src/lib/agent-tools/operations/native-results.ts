/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { internal } from './refusals';

/** Wire schemas for the original native operation slice. Feature codecs own rich nested records. */
const number = { type: 'number' }, string = { type: 'string' }, boolean = { type: 'boolean' };
const object = (properties: Record<string, unknown>, required = Object.keys(properties), extra = false) => ({ type: 'object', properties, required, additionalProperties: extra });
const array = (items: Record<string, unknown>) => ({ type: 'array', items });
const point = object({ x: number, y: number, z: number });
const pick = object({ x: number, y: number, z: number, screenX: number, screenY: number });
const vector = { type: 'array', items: number, minItems: 3, maxItems: 3 };
const ref = object({ modelId: string, expressId: { type: 'integer', minimum: 1 } });
const section = object({ axis: { type: 'string', enum: ['x', 'y', 'z'] }, position: number, enabled: boolean, flipped: boolean, id: string, name: string }, ['axis', 'position', 'enabled', 'flipped']);
const distance = object({ id: string, start: pick, end: pick, distance: number });
const polyline = object({ id: string, points: array(pick), closed: boolean, length: number });
const measurement = object({ distances: array(distance), polylines: array(polyline), angles: array({ type: 'object' }), radii: array({ type: 'object' }), referencePoint: { anyOf: [point, { type: 'null' }] }, mode: string, snapEnabled: boolean, geoReadoutEnabled: boolean });
const environment = object({ preset: string, skyEnabled: boolean, exposure: number, hardness: number, softness: number, shadowsEnabled: boolean, sunAngle: number, shadowResolution: number, sunTimeEnabled: boolean, sunTime: number });
const pointCloud = object({ colorMode: string, sizeMode: string, pointSize: number, worldRadius: number, roundShape: boolean, edlEnabled: boolean, edlStrength: number,
  classMask: array({ type: 'integer', minimum: 0, maximum: 4294967295 }), classCounts: { type: 'object', additionalProperties: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } } },
  deviationComputed: boolean, deviationStatistics: { anyOf: [{ type: 'object' }, { type: 'null' }] }, deviationRevision: { type: 'integer', minimum: 0 } });
const simple: Record<string, Record<string, unknown>> = {
  'selection.read': array(ref), 'selection.replace': array(ref), 'selection.clear': array(ref),
  'visibility.hide': object({ applied: array(ref) }), 'visibility.show': object({ applied: array(ref) }), 'visibility.isolate': object({ applied: array(ref) }), 'visibility.reset': object({ applied: boolean }),
  'camera.frame': object({ dispatched: boolean }), 'camera.read': object({ mode: string, position: vector, target: vector, up: vector }, ['mode']), 'camera.set': object({ mode: string, position: vector, target: vector, up: vector }, ['mode']),
  'section.read': array(section), 'section.replace': array(section), 'section.add': object({ id: { anyOf: [string, { type: 'null' }] }, planes: array(section) }), 'section.remove': object({ removed: boolean }),
  'appearance.colorize': object({ applied: array(ref), color: string }), 'appearance.resetEntities': object({ applied: array(ref) }), 'appearance.resetAll': object({ applied: boolean }),
  'measurements.distance': distance, 'measurements.polyline': polyline, 'measurements.deleteDistance': object({ removed: string }),
  'validation.ids': object({ source: { type: 'object' }, modelInfo: array(object({ modelId: string, schemaVersion: string, entityCount: { type: 'integer', minimum: 0 } })), timestamp: string,
    summary: { type: 'object' }, specificationResults: array({ type: 'object' }) }, ['source', 'modelInfo', 'timestamp', 'summary', 'specificationResults'], true),
  'clash.analyze': object({ result: { type: 'object' }, groups: { anyOf: [{ type: 'array', items: { type: 'object' } }, { type: 'object' }] }, model_id: string }),
};
const cost = object({ ref, GlobalId: string, Name: string, Description: string }, ['ref'], true);
const task = object({ expressId: { type: 'integer' }, globalId: string, name: string, isMilestone: boolean,
  childGlobalIds: array(string), productExpressIds: array({ type: 'integer' }), productGlobalIds: array(string), controllingScheduleGlobalIds: array(string) }, ['expressId', 'globalId', 'name', 'isMilestone', 'childGlobalIds', 'productExpressIds', 'productGlobalIds', 'controllingScheduleGlobalIds'], true);
const schedule = object({ expressId: { type: 'integer' }, globalId: string, kind: string, name: string, taskGlobalIds: array(string) }, ['expressId', 'globalId', 'kind', 'name', 'taskGlobalIds'], true);
const sequence = object({ globalId: string, relatingTaskGlobalId: string, relatedTaskGlobalId: string, sequenceType: string }, ['globalId', 'relatingTaskGlobalId', 'relatedTaskGlobalId', 'sequenceType'], true);
export function nativeResultSchema(id: string): Record<string, unknown> {
  if (simple[id]) return simple[id];
  if (id.startsWith('environment.')) return environment;
  if (id.startsWith('pointclouds.')) return pointCloud;
  if (['measurements.read', 'measurements.clear', 'measurements.reference', 'measurements.clearReference'].includes(id)) return measurement;
  if (id === 'schedule.tasks') return array(task);
  if (id === 'schedule.containers') return array(schedule);
  if (id === 'schedule.sequences') return array(sequence);
  if (id.startsWith('cost.')) return array(cost);
  if (id.startsWith('structural.')) return array(object({ expressId: { type: 'integer', minimum: 1 } }, ['expressId'], true));
  if (id === 'lens.presets' || id === 'clash.presets') return array(object({ id: string, name: string }, ['id', 'name'], true));
  throw internal(`Missing output schema for ${id}`);
}
