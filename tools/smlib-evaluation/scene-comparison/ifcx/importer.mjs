// SPDX-License-Identifier: MPL-2.0
// Standalone real-consumer qualification; no alternative loader or mesh logic.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [entry, root, destination] = process.argv.slice(2);
if (!entry || !root || !destination) throw new Error('usage: node --import tsx importer.mjs ENTRY.ts REPO OUTPUT');
const api = await import(pathToFileURL(resolve(entry)).href);
const { composeFederated } = await import(new URL('./federated-composition.ts', pathToFileURL(resolve(entry))));
await mkdir(destination, { recursive: true });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const files = [
  'ifc5/Hello_Wall_hello-wall.ifcx',
  'ifc5/Hello_Wall_hello-wall-add-fire-rating-30.ifcx',
  'ifc5/Domestic_Hot_Water_domestic-hot-water.ifcx',
  'ifc5/Domestic_Hot_Water_domestic-hot-water-add-pbr.ifcx',
  'ifc5/Georeferencing_georeferenced-bridge-deck.ifcx',
  'ifc5/PCERT-Sample-Scene_Building-Architecture.ifcx',
  'ifc5/Point_Cloud_point-cloud.ifcx',
];
const buffers = new Map();
const metadata = [];
const sourceDocuments = new Map();
for (const name of files) {
  const bytes = await readFile(resolve(root, 'tests/models', name));
  const file = JSON.parse(bytes.toString('utf8'));
  sourceDocuments.set(name, file);
  buffers.set(name, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  metadata.push({ name, bytes: bytes.length, sha256: digest(bytes), header: file.header,
    declaredImports: file.imports ?? [], declaredSchemas: Object.keys(file.schemas ?? {}),
    provenance: 'fixture manifest mirror; upstream URL and redistribution license not recorded',
    importResolution: 'existing parser composes supplied data; it does not fetch remote schema imports' });
}
// Preserve typed buffer layout and every float bit; retain sequence/map order.
// Functions are accessors, represented by actual getter outputs below.
function owned(value) {
  if (typeof value === 'function') return undefined;
  if (typeof value === 'number') {
    const bytes = Buffer.alloc(8); bytes.writeDoubleLE(value);
    return { float64le: bytes.toString('hex') };
  }
  if (value === undefined) return { absent: true };
  if (value === null || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value)) return { type: value.constructor.name,
    length: value.length, bytes: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex') };
  if (value instanceof Map) return { map: [...value].map(([key, item]) => [owned(key), owned(item)]) };
  if (value instanceof Set) return { set: [...value].map(owned) };
  if (Array.isArray(value)) return value.map(owned);
  return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item !== 'function')
    .map(([key, item]) => [key, owned(item)]));
}
function scene(result) {
  const keys = ['entities', 'properties', 'quantities', 'relationships', 'spatialHierarchy',
    'meshes', 'pointClouds', 'pathToId', 'idToPath', 'schemaVersion', 'fileSize', 'entityCount', 'georeferencing'];
  const value = Object.fromEntries(keys.map(key => [key, result[key]]));
  value.strings = result.strings.getAll();
  value.propertySets = [...result.entities.expressId].map(id => [id, result.properties.getForEntity(id)]);
  value.quantitySets = [...result.entities.expressId].map(id => [id, result.quantities.getForEntity(id)]);
  if (result.layerStack) {
    const names = new Map(result.layerStack.getLayers().map(layer => [layer.id, layer.name]));
    value.pathToLayers = [...result.pathToLayers].map(([path, ids]) => [path, ids.map(id => names.get(id))]);
    value.compositionStats = result.compositionStats;
    value.composed = [...composeFederated(result.layerStack).composed].map(([path, node]) => ({
      path, attributes: node.attributes, children: [...node.children].map(([key, child]) => [key, child.path]),
      attributeSources: [...node.attributeSources].map(([key, source]) => [key, source.layerName]),
      contributingLayers: [...node.contributingLayers].map(id => names.get(id)),
    }));
  }
  return value;
}
function witnesses(result) {
  return { entities: result.entityCount, meshes: result.meshes.length,
    vertices: result.meshes.reduce((sum, mesh) => sum + mesh.positions.length / 3, 0),
    triangles: result.meshes.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0),
    uvMeshes: result.meshes.filter(mesh => mesh.uvs?.length).length,
    uvCoordinates: result.meshes.reduce((sum, mesh) => sum + (mesh.uvs?.length ?? 0), 0),
    texturedMeshes: result.meshes.filter(mesh => mesh.texture).length,
    pointClouds: result.pointClouds.length,
    points: result.pointClouds.reduce((sum, cloud) => sum + cloud.pointCount, 0),
    properties: result.properties.count, quantities: result.quantities.count,
    georeferencing: result.georeferencing ?? null };
}
const summaries = [];
async function retain(name, result, extra = {}, composed) {
  const captured = scene(result);
  if (composed) captured.composed = [...composed].map(([path, node]) => ({ path,
    attributes: node.attributes, children: [...node.children].map(([key, child]) => [key, child.path]) }));
  const snapshot = JSON.stringify(owned(captured));
  await writeFile(resolve(destination, `${name}.json`), snapshot + '\n');
  summaries.push({ name, sha256: digest(snapshot), witnesses: witnesses(result), ...extra });
}
for (const name of [files[0], files[2], files[4], files[5], files[6]]) {
  const result = await api.parseIfcx(buffers.get(name));
  assert(result.meshes.length || result.pointClouds.length, `${name}: real scene output required`);
  if (name === files[6]) assert(result.pointClouds.reduce((sum, cloud) => sum + cloud.pointCount, 0) > 0);
  await retain(name.split('/').at(-1), result, {}, api.composeIfcx(sourceDocuments.get(name)));
}
for (const [label, baseName, overlayName, attribute] of [
  ['fire-rating', files[0], files[1], 'bsi::ifc::prop::FireRating'],
  ['pbr', files[2], files[3], 'gltf::material'],
]) {
  const base = await api.parseFederatedIfcx([{ buffer: buffers.get(baseName), name: baseName }]);
  const basePropertyDigest = digest(JSON.stringify(owned(scene(base).propertySets)));
  const result = await api.addIfcxOverlay(base, buffers.get(overlayName), overlayName);
  const nodes = composeFederated(result.layerStack).composed;
  const opinions = [...nodes.values()].filter(node => node.attributes.has(attribute));
  assert(opinions.length > 0, `${label}: overlay must affect actual composed attributes`);
  const outputOpinions = opinions.map(node => ({ path: node.path, value: node.attributes.get(attribute) }));
  assert(result.meshes.length > 0, `${label}: overlays must remain attached to a real base scene`);
  if (label === 'fire-rating') {
    assert(outputOpinions.some(opinion => opinion.value === 'R30'));
    assert.notEqual(digest(JSON.stringify(owned(scene(result).propertySets))), basePropertyDigest,
      'fire-rating overlay must change actual property-table output');
  }
  await retain(label, result, { overlayAttribute: attribute, opinionCount: opinions.length,
    composedOpinions: outputOpinions,
    changedMeshColors: result.meshes.filter((mesh, i) => JSON.stringify(mesh.color) !== JSON.stringify(base.meshes[i]?.color)).length });
  const federated = await api.parseFederatedIfcx([{ buffer: buffers.get(baseName), name: baseName },
    { buffer: buffers.get(overlayName), name: overlayName }]);
  assert.deepEqual(owned(scene(federated)), owned(scene(result)), `${label}: full and incremental real composition must agree`);
}
await writeFile(resolve(destination, 'summary.json'), JSON.stringify({ metadata, summaries,
  excludedFromEquality: ['parseTime', 'ephemeral layer UUIDs replaced only with actual supplied filenames'],
  scope: 'existing IFCX importer/composition output; no Rust numerical call and no viewer loadFile activation' }, null, 2));
console.log(JSON.stringify(summaries.map(({ name, witnesses, opinionCount }) => ({ name, ...witnesses, opinionCount })), null, 2));
