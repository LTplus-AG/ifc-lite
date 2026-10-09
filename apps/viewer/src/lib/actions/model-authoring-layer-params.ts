/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { parseGlobalIdTarget, parseLength, record } from './model-authoring-fields';
import { parseSizeParams, sizeInMetres } from './model-authoring-size-params';
import type { AuthoringUnits, ExistingElement } from './model-authoring';
import type { NativeLayerExpected, NativeLayerPopulation, NativeMaterialRef } from './native-layer-evidence';

export interface ProposedLayer { LayerThickness: number; Material: NativeMaterialRef | { create: { Name: string } } | null }
export interface LayerFields { scope: 'element' | 'type'; expected: NativeLayerExpected; MaterialLayers: ProposedLayer[] }

function fields(value: unknown, names: readonly string[], at: string): Record<string, unknown> {
  if (!record(value)) throw new Error(`${at}: expected an object`);
  for (const key of Object.keys(value)) if (!names.includes(key)) throw new Error(`${at}: unsupported field ${key}`);
  return value;
}
function id(value: unknown, at: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${at}: needs a native expressId`);
  return value;
}
function Name(value: unknown, at: string): string {
  if (typeof value !== 'string' || value.length > 200) throw new Error(`${at}: needs the current native Name (empty when unnamed)`);
  return value;
}
function material(value: unknown, at: string): NativeMaterialRef {
  const row = fields(value, ['modelId', 'expressId', 'Name'], at);
  if (typeof row.modelId !== 'string' || !row.modelId || row.modelId.length > 200) throw new Error(`${at}: needs its loaded modelId`);
  return { modelId: row.modelId, expressId: id(row.expressId, at), Name: Name(row.Name, at) };
}
function proposed(value: unknown, units: AuthoringUnits, at: string): ProposedLayer {
  const row = fields(value, ['LayerThickness', 'Material'], at);
  const LayerThickness = parseLength(row.LayerThickness, units, { min: 0, max: 5 }, at);
  if (!(LayerThickness > 0)) throw new Error(`${at}: changed layers must have positive thickness`);
  if (row.Material === null) return { LayerThickness, Material: null };
  if (record(row.Material) && 'create' in row.Material) {
    const root = fields(row.Material, ['create'], `${at} Material`);
    const create = fields(root.create, ['Name'], `${at} Material.create`);
    const name = Name(create.Name, at);
    if (!name.trim() || /^\s*(?:\$|\*|#\d+)\s*$/.test(name)) throw new Error(`${at}: new material needs a literal Name, not a STEP token`);
    return { LayerThickness, Material: { create: { Name: name } } };
  }
  return { LayerThickness, Material: material(row.Material, `${at} Material`) };
}

/** Full existing population in declared units; no private inspector snapshots or inferred material GUIDs (#7275). */
export function parseLayerFields(value: Record<string, unknown>, units: AuthoringUnits, at: string,
  existing: (value: unknown, at: string) => ExistingElement): LayerFields {
  fields(value, ['op', 'target', 'scope', 'expected', 'MaterialLayers'], at);
  fields(value.target, ['globalId', 'modelId', 'ifcClass', 'name'], `${at} target`);
  if (value.scope !== 'element' && value.scope !== 'type') throw new Error(`${at}: state element or type scope`);
  const expected = fields(value.expected, ['assignments', 'layerSetId', 'via', 'MaterialLayers', 'type', 'typeStatus', 'peers', 'wall', 'typeLayers'], `${at} expected`);
  const population = parsePopulation(expected, units, at);
  if (!['element', 'type', 'none'].includes(String(expected.via))) throw new Error(`${at}: expected native assignment origin`);
  if (!['typed', 'untyped', 'unavailable'].includes(String(expected.typeStatus))) throw new Error(`${at}: expected explicit native type status`);
  let type: NativeLayerExpected['type'] = null;
  if (expected.type !== null) {
    const row = fields(expected.type, ['GlobalId', 'Name'], `${at} expected type`);
    type = { GlobalId: parseGlobalIdTarget({ globalId: row.GlobalId }, at).globalId, Name: Name(row.Name, at) };
  }
  if ((expected.typeStatus === 'typed') !== (type !== null)) throw new Error(`${at}: type status and native identity disagree`);
  if (expected.peers !== null && (!Array.isArray(expected.peers) || expected.peers.length > 200)) throw new Error(`${at}: expected all bounded type peers, or null when unavailable`);
  const peers = Array.isArray(expected.peers) ? expected.peers.map((peer, i) => existing(fields(peer, ['globalId', 'modelId', 'ifcClass', 'name'], `${at} expected peer ${i}`), `${at} expected peer ${i}`)) : null;
  const wall = expected.wall === null ? null : parseSizeParams(expected.wall, units, `${at} expected wall`, true);
  if (wall && wall.kind !== 'wall') throw new Error(`${at}: expected wall dimensions must describe a wall`);
  if (!Array.isArray(value.MaterialLayers) || value.MaterialLayers.length === 0 || value.MaterialLayers.length > 32) throw new Error(`${at}: propose 1–32 explicit layers`);
  return { scope: value.scope, expected: { ...population, typeLayers: expected.typeLayers === null ? null : parsePopulation(fields(expected.typeLayers, ['assignments', 'layerSetId', 'MaterialLayers'], at), units, at),
    via: expected.via as NativeLayerExpected['via'], type, typeStatus: expected.typeStatus as NativeLayerExpected['typeStatus'], peers, wall },
    MaterialLayers: value.MaterialLayers.map((layer, i) => proposed(layer, units, `${at} layer ${i}`)) };
}


function parsePopulation(expected: Record<string, unknown>, units: AuthoringUnits, at: string): NativeLayerPopulation {
  if (!Array.isArray(expected.assignments) || expected.assignments.length > 32) throw new Error(`${at}: expected all bounded native material assignments`);
  const assignments = expected.assignments.map((value, i) => {
    const row = fields(value, ['expressId', 'ifcClass'], `${at} assignment ${i}`);
    if (typeof row.ifcClass !== 'string' || !/^Ifc[A-Za-z0-9]+$/.test(row.ifcClass)) throw new Error(`${at}: expected exact material EXPRESS class`);
    return { expressId: id(row.expressId, at), ifcClass: row.ifcClass };
  });
  if (!Array.isArray(expected.MaterialLayers) || expected.MaterialLayers.length > 32) throw new Error(`${at}: expected all bounded native layers`);
  const MaterialLayers = expected.MaterialLayers.map((value, i) => {
    const row = fields(value, ['LayerThickness', 'Material'], `${at} expected layer ${i}`);
    return { LayerThickness: parseLength(row.LayerThickness, units, { min: 0, max: Number.MAX_VALUE }, at),
      Material: row.Material === null ? null : material(row.Material, at) };
  });
  return { assignments, layerSetId: expected.layerSetId === null ? null : id(expected.layerSetId, at), MaterialLayers };
}

export function layerExpectedInMetres(expected: NativeLayerExpected, units: AuthoringUnits): NativeLayerExpected {
  return { ...expected, MaterialLayers: expected.MaterialLayers.map(layer => ({ ...layer,
    LayerThickness: units === 'mm' ? layer.LayerThickness / 1000 : layer.LayerThickness })),
    typeLayers: expected.typeLayers ? { ...expected.typeLayers, MaterialLayers: expected.typeLayers.MaterialLayers.map(layer => ({ ...layer, LayerThickness: units === 'mm' ? layer.LayerThickness / 1000 : layer.LayerThickness })) } : null,
    wall: expected.wall ? sizeInMetres(expected.wall, units) : null };
}
