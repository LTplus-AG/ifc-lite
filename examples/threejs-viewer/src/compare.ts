/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GeometryProcessor, type MeshData } from '@ifc-lite/geometry';
import { RelationshipType } from '@ifc-lite/data';
import { extractAllEntityAttributes, extractPropertiesOnDemand, extractQuantitiesOnDemand } from '@ifc-lite/parser';
import { batchWithVertexColors, findEntityByFace, type TriangleMaps } from './ifc-to-threejs.js';
import { buildDataStore, getEntityData, type IfcDataStore } from './ifc-data.js';
import { federationRegistry } from './federation-registry.js';

type ModelId = 'base' | 'next';
type DiffState = 'added' | 'changed' | 'deleted' | 'unchanged';

interface LoadedEntity {
  modelId: ModelId;
  fileName: string;
  localExpressId: number;
  globalExpressId: number;
  comparisonKey: string;
  ifcType: string;
  name: string;
  geometryFingerprint: string;
  dataFingerprint: string;
  meshSegments: MeshData[];
  store: IfcDataStore;
}

interface LoadedModel {
  modelId: ModelId;
  fileName: string;
  store: IfcDataStore;
  entitiesByKey: Map<string, LoadedEntity>;
}

interface DiffEntry {
  key: string;
  state: DiffState;
  renderEntity: LoadedEntity;
  baseEntity?: LoadedEntity;
  nextEntity?: LoadedEntity;
  changeKinds: string[];
}

interface ComparisonSession {
  baseFileName: string;
  nextFileName: string;
  entries: DiffEntry[];
  visibleEntries: Map<number, DiffEntry>;
  counts: Record<DiffState, number>;
}

const COLORS: Record<DiffState, [number, number, number, number]> = {
  added: [0.22, 0.78, 0.44, 1],
  changed: [1, 0.6, 0.18, 1],
  deleted: [1, 0.3, 0.3, 1],
  unchanged: [0.43, 0.51, 0.58, 0.16],
};

const canvas = document.getElementById('viewer') as HTMLCanvasElement;
const baseInput = document.getElementById('base-file') as HTMLInputElement;
const nextInput = document.getElementById('next-file') as HTMLInputElement;
const compareButton = document.getElementById('compare-button') as HTMLButtonElement;
const showUnchangedInput = document.getElementById('show-unchanged') as HTMLInputElement;
const statusEl = document.getElementById('status') as HTMLElement;
const selectionEmptyEl = document.getElementById('selection-empty') as HTMLElement;
const selectionContentEl = document.getElementById('selection-content') as HTMLElement;

const countEls: Record<DiffState, HTMLElement> = {
  added: document.getElementById('count-added') as HTMLElement,
  changed: document.getElementById('count-changed') as HTMLElement,
  deleted: document.getElementById('count-deleted') as HTMLElement,
  unchanged: document.getElementById('count-unchanged') as HTMLElement,
};

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x08131d);

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 10000);
camera.position.set(24, 18, 24);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

scene.add(new THREE.AmbientLight(0xffffff, 0.8));
const sun = new THREE.DirectionalLight(0xffffff, 1.0);
sun.position.set(80, 120, 30);
scene.add(sun);
const fill = new THREE.DirectionalLight(0x9ebeff, 0.32);
fill.position.set(-40, 20, -60);
scene.add(fill);

const grid = new THREE.GridHelper(200, 40, 0x294660, 0x203449);
grid.position.y = -0.01;
scene.add(grid);

const geometry = new GeometryProcessor();
let triangleMaps: TriangleMaps = new Map();
let modelRoot: THREE.Group | null = null;
let selectionHighlight: THREE.Group | null = null;
let currentSession: ComparisonSession | null = null;
let selectedGlobalId: number | null = null;

function resize(): void {
  const parent = canvas.parentElement ?? document.body;
  renderer.setSize(parent.clientWidth, parent.clientHeight);
  camera.aspect = parent.clientWidth / parent.clientHeight;
  camera.updateProjectionMatrix();
}

window.addEventListener('resize', resize);
resize();

function animate(): void {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

animate();

let pointerDown = { x: 0, y: 0 };
let didDrag = false;

canvas.addEventListener('pointerdown', (event) => {
  pointerDown = { x: event.clientX, y: event.clientY };
  didDrag = false;
});

canvas.addEventListener('pointermove', (event) => {
  if (event.buttons === 0) return;
  if (!didDrag) {
    const distance = Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y);
    if (distance > 4) {
      didDrag = true;
      canvas.classList.add('dragging');
    }
  }
});

window.addEventListener('pointerup', () => canvas.classList.remove('dragging'));

canvas.addEventListener('click', (event) => {
  if (didDrag) return;
  const globalId = pickAt(event.clientX, event.clientY);
  if (globalId == null) {
    clearSelection();
    return;
  }
  selectEntity(globalId);
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    clearSelection();
  }
});

compareButton.addEventListener('click', () => {
  void runComparison();
});

showUnchangedInput.addEventListener('change', () => {
  if (!currentSession) return;
  renderComparison(currentSession);
});

async function runComparison(): Promise<void> {
  const baseFile = baseInput.files?.[0];
  const nextFile = nextInput.files?.[0];

  if (!baseFile || !nextFile) {
    setStatus('Select both a base IFC and a revised IFC.');
    return;
  }

  compareButton.disabled = true;
  currentSession = null;
  resetDiffCounts();
  selectionContentEl.innerHTML = '';
  selectionEmptyEl.textContent = 'Nothing selected.';
  clearSelection();
  clearModel();
  federationRegistry.clear();
  setStatus(`Loading ${baseFile.name} and ${nextFile.name}...`);

  try {
    await geometry.init();

    const baseModel = await loadModel(baseFile, 'base');
    const nextModel = await loadModel(nextFile, 'next');

    currentSession = buildComparison(baseModel, nextModel);
    renderComparison(currentSession);
    fitCameraToObject(modelRoot);

    setStatus(
      `Compared ${baseFile.name} -> ${nextFile.name}. ` +
      `${currentSession.counts.added} added, ${currentSession.counts.changed} changed, ${currentSession.counts.deleted} deleted.`,
    );
  } catch (error) {
    console.error(error);
    setStatus(`Error: ${(error as Error).message}`);
  } finally {
    compareButton.disabled = false;
  }
}

async function loadModel(file: File, modelId: ModelId): Promise<LoadedModel> {
  const buffer = await file.arrayBuffer();
  const store = await buildDataStore(buffer);
  const geometryResult = await geometry.process(new Uint8Array(buffer));

  const meshesByExpressId = new Map<number, MeshData[]>();
  let maxExpressId = 1;

  for (const mesh of geometryResult.meshes) {
    maxExpressId = Math.max(maxExpressId, mesh.expressId);
    const existing = meshesByExpressId.get(mesh.expressId);
    if (existing) existing.push(mesh);
    else meshesByExpressId.set(mesh.expressId, [mesh]);
  }

  federationRegistry.registerModel(modelId, maxExpressId);

  const entitiesByKey = new Map<string, LoadedEntity>();
  for (const [localExpressId, meshSegments] of meshesByExpressId) {
    const comparisonKey = store.entities.getGlobalId(localExpressId) || `missing:${modelId}:${localExpressId}`;
    const globalExpressId = federationRegistry.toGlobalId(modelId, localExpressId);
    const ifcType = store.entities.getTypeName(localExpressId) || 'IfcProduct';
    const name = store.entities.getName(localExpressId) || '';

    entitiesByKey.set(comparisonKey, {
      modelId,
      fileName: file.name,
      localExpressId,
      globalExpressId,
      comparisonKey,
      ifcType,
      name,
      geometryFingerprint: buildGeometryFingerprint(meshSegments),
      dataFingerprint: buildDataFingerprint(store, localExpressId, ifcType, name),
      meshSegments,
      store,
    });
  }

  return { modelId, fileName: file.name, store, entitiesByKey };
}

function buildComparison(baseModel: LoadedModel, nextModel: LoadedModel): ComparisonSession {
  const allKeys = new Set([
    ...baseModel.entitiesByKey.keys(),
    ...nextModel.entitiesByKey.keys(),
  ]);

  const entries: DiffEntry[] = [];
  const counts: Record<DiffState, number> = {
    added: 0,
    changed: 0,
    deleted: 0,
    unchanged: 0,
  };

  for (const key of allKeys) {
    const baseEntity = baseModel.entitiesByKey.get(key);
    const nextEntity = nextModel.entitiesByKey.get(key);

    if (!baseEntity && nextEntity) {
      entries.push({
        key,
        state: 'added',
        renderEntity: nextEntity,
        nextEntity,
        changeKinds: ['New entity'],
      });
      counts.added++;
      continue;
    }

    if (baseEntity && !nextEntity) {
      entries.push({
        key,
        state: 'deleted',
        renderEntity: baseEntity,
        baseEntity,
        changeKinds: ['Deleted from revised version'],
      });
      counts.deleted++;
      continue;
    }

    if (!baseEntity || !nextEntity) continue;

    const changeKinds: string[] = [];
    if (baseEntity.ifcType !== nextEntity.ifcType) changeKinds.push('Type');
    if (baseEntity.dataFingerprint !== nextEntity.dataFingerprint) changeKinds.push('Data');
    if (baseEntity.geometryFingerprint !== nextEntity.geometryFingerprint) changeKinds.push('Geometry');

    const state: DiffState = changeKinds.length > 0 ? 'changed' : 'unchanged';
    counts[state]++;

    entries.push({
      key,
      state,
      renderEntity: nextEntity,
      baseEntity,
      nextEntity,
      changeKinds: changeKinds.length > 0 ? changeKinds : ['No change'],
    });
  }

  return {
    baseFileName: baseModel.fileName,
    nextFileName: nextModel.fileName,
    entries,
    visibleEntries: new Map(),
    counts,
  };
}

function renderComparison(session: ComparisonSession): void {
  clearModel();

  const showUnchanged = showUnchangedInput.checked;
  const visibleEntries = new Map<number, DiffEntry>();
  const meshes: MeshData[] = [];

  for (const entry of session.entries) {
    if (entry.state === 'unchanged' && !showUnchanged) continue;

    for (const mesh of entry.renderEntity.meshSegments) {
      meshes.push({
        ...mesh,
        expressId: entry.renderEntity.globalExpressId,
        color: COLORS[entry.state],
      });
    }

    visibleEntries.set(entry.renderEntity.globalExpressId, entry);
  }

  session.visibleEntries = visibleEntries;

  if (meshes.length > 0) {
    const { group, triangleMaps: nextTriangleMaps } = batchWithVertexColors(meshes);
    modelRoot = group;
    triangleMaps = nextTriangleMaps;
    scene.add(modelRoot);
  } else {
    triangleMaps = new Map();
  }

  for (const state of Object.keys(countEls) as DiffState[]) {
    countEls[state].textContent = session.counts[state].toLocaleString();
  }

  if (selectedGlobalId != null) {
    if (session.visibleEntries.has(selectedGlobalId)) {
      selectEntity(selectedGlobalId);
    } else {
      clearSelection();
    }
  }
}

function pickAt(clientX: number, clientY: number): number | null {
  if (triangleMaps.size === 0) return null;

  const pointer = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  const hits = raycaster.intersectObjects([...triangleMaps.keys()], false);
  if (!hits.length || hits[0].faceIndex == null) return null;

  const ranges = triangleMaps.get(hits[0].object as THREE.Mesh);
  return ranges ? findEntityByFace(ranges, hits[0].faceIndex) : null;
}

function selectEntity(globalExpressId: number): void {
  if (!currentSession) return;

  const entry = currentSession.visibleEntries.get(globalExpressId);
  if (!entry) return;

  selectedGlobalId = globalExpressId;
  applyHighlight(entry.renderEntity.meshSegments);
  renderSelection(entry);
}

function clearSelection(): void {
  selectedGlobalId = null;
  selectionEmptyEl.textContent = 'Nothing selected.';
  selectionContentEl.innerHTML = '';
  removeHighlight();
}

function resetDiffCounts(): void {
  for (const state of Object.keys(countEls) as DiffState[]) {
    countEls[state].textContent = '0';
  }
}

function applyHighlight(meshSegments: MeshData[]): void {
  removeHighlight();

  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    color: 0x7fb6ff,
    emissive: 0x3b82f6,
    emissiveIntensity: 0.3,
    transparent: true,
    opacity: 0.42,
    side: THREE.DoubleSide,
    depthTest: true,
  });

  for (const mesh of meshSegments) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    group.add(new THREE.Mesh(geometry, material.clone()));
  }

  selectionHighlight = group;
  scene.add(group);
}

function removeHighlight(): void {
  if (!selectionHighlight) return;

  scene.remove(selectionHighlight);
  selectionHighlight.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    if (Array.isArray(child.material)) {
      for (const material of child.material) material.dispose();
    } else {
      child.material.dispose();
    }
  });
  selectionHighlight = null;
}

function renderSelection(entry: DiffEntry): void {
  selectionEmptyEl.textContent = '';

  const entity = entry.renderEntity;
  const details = getEntityData(entity.store, entity.localExpressId, entity.ifcType);
  const sourceLabel = entry.state === 'deleted' ? 'Base version' : 'Revised version';
  const federationLookup = federationRegistry.fromGlobalId(entity.globalExpressId);
  const modelRef = federationLookup
    ? `${federationLookup.modelId} / #${federationLookup.expressId}`
    : `#${entity.localExpressId}`;

  selectionContentEl.innerHTML = `
    <div class="card">
      <div class="row">
        <div>
          <h1>${esc(entity.name || entity.ifcType)}</h1>
          <p class="muted">${esc(entity.ifcType)}</p>
        </div>
        <span class="badge ${entry.state}">${entry.state}</span>
      </div>
      <div class="detail-grid">
        <div class="detail-row">
          <span class="detail-label">Source</span>
          <strong>${esc(sourceLabel)}</strong>
        </div>
        <div class="detail-row">
          <span class="detail-label">File</span>
          <strong>${esc(entity.fileName)}</strong>
        </div>
        <div class="detail-row">
          <span class="detail-label">Federated Id</span>
          <strong class="mono">${esc(String(entity.globalExpressId))}</strong>
        </div>
        <div class="detail-row">
          <span class="detail-label">Entity Ref</span>
          <strong class="mono">${esc(modelRef)}</strong>
        </div>
        <div class="detail-row">
          <span class="detail-label">GlobalId</span>
          <strong class="mono">${esc(details.globalId || '—')}</strong>
        </div>
        <div class="detail-row">
          <span class="detail-label">Change</span>
          <strong>${esc(entry.changeKinds.join(', '))}</strong>
        </div>
      </div>
    </div>
  `;
}

function clearModel(): void {
  removeHighlight();
  triangleMaps.clear();

  if (!modelRoot) return;
  scene.remove(modelRoot);
  disposeObject(modelRoot);
  modelRoot = null;
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    if (Array.isArray(child.material)) {
      for (const material of child.material) material.dispose();
    } else {
      child.material.dispose();
    }
  });
}

function fitCameraToObject(object: THREE.Object3D | null): void {
  if (!object) return;

  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1);
  const distance = maxDim * 1.5;
  const elevation = THREE.MathUtils.degToRad(26);
  const planar = Math.cos(elevation);

  controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(
    planar * distance * Math.SQRT1_2,
    Math.sin(elevation) * distance,
    -planar * distance * Math.SQRT1_2,
  ));
  camera.near = Math.max(0.05, maxDim * 0.001);
  camera.far = maxDim * 100;
  camera.updateProjectionMatrix();
  controls.update();
}

function buildDataFingerprint(store: IfcDataStore, expressId: number, ifcType: string, name: string): string {
  const namedAttributes = extractAllEntityAttributes(store, expressId);
  const predefinedType = namedAttributes.find((attribute) => attribute.name === 'PredefinedType')?.value ?? '';

  const propertySets = extractPropertiesOnDemand(store, expressId)
    .map((set) => ({
      name: set.name,
      properties: [...set.properties]
        .map((property) => ({ name: property.name, value: normalizeValue(property.value) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const quantitySets = extractQuantitiesOnDemand(store, expressId)
    .map((set) => ({
      name: set.name,
      quantities: [...set.quantities]
        .map((quantity) => ({ name: quantity.name, value: normalizeValue(quantity.value) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const typeAssignments = store.relationships
    .getRelated(expressId, RelationshipType.DefinesByType, 'inverse')
    .map((typeId) => ({
      expressId: typeId,
      globalId: store.entities.getGlobalId(typeId) || '',
      name: store.entities.getName(typeId) || '',
      type: store.entities.getTypeName(typeId) || '',
    }))
    .sort((a, b) =>
      a.type.localeCompare(b.type)
      || a.name.localeCompare(b.name)
      || a.globalId.localeCompare(b.globalId)
      || a.expressId - b.expressId
    );

  return stableHash(JSON.stringify({
    Type: ifcType,
    Name: name,
    Description: store.entities.getDescription(expressId) || '',
    ObjectType: store.entities.getObjectType(expressId) || '',
    PredefinedType: predefinedType,
    TypeAssignments: typeAssignments,
    PropertySets: propertySets,
    QuantitySets: quantitySets,
  }));
}

function buildGeometryFingerprint(meshes: MeshData[]): string {
  let hash = 2166136261;

  for (const mesh of meshes) {
    hash = fnvUpdate(hash, mesh.positions.length);
    hash = fnvUpdate(hash, mesh.indices.length);
    hash = sampleArrayHash(hash, mesh.positions);
    hash = sampleArrayHash(hash, mesh.indices);
  }

  return (hash >>> 0).toString(16);
}

function sampleArrayHash(hash: number, values: ArrayLike<number>): number {
  const stride = Math.max(1, Math.floor(values.length / 256));
  for (let index = 0; index < values.length; index += stride) {
    hash = fnvUpdate(hash, Math.round(Number(values[index]) * 1000));
  }
  return hash;
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function fnvUpdate(hash: number, value: number): number {
  hash ^= value;
  return Math.imul(hash, 16777619);
}

function normalizeValue(value: unknown): string | number | boolean | null {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch (error) {
    console.warn('[compare] normalizeValue: failed to stringify value', error);
    return String(value);
  }
}

function setStatus(message: string): void {
  statusEl.textContent = message;
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
