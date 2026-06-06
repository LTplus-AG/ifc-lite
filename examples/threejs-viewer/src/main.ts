/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC viewer: @ifc-lite/geometry + Three.js
 *
 * Loading strategy:
 *  1. Geometry streams progressively via @ifc-lite/geometry WASM.
 *     Each batch is vertex-color-batched and added to the scene immediately.
 *  2. On 'complete', the whole model is rebuilt as a single optimised mesh.
 *     Temporary batch groups are disposed one frame later (no visual pop).
 *  3. In parallel, @ifc-lite/parser builds a columnar data store for
 *     entity attributes, property sets, and the spatial hierarchy tree.
 *
 * Interaction model:
 *  • Hover  → raycaster updates cursor (crosshair → pointer, frame-throttled)
 *  • Orbit  → grabbing cursor via OrbitControls events
 *  • Click  → pick entity → highlight + open properties panel + reveal in tree
 *  • Escape → clear selection
 *  • Tree   → click spatial node to select / two-way sync with 3D selection
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GeometryProcessor, type MeshData } from '@ifc-lite/geometry';
import {
  batchWithVertexColors,
  findEntityByFace,
  type ExpressIdMap,
  type TriangleMaps,
} from './ifc-to-threejs.js';
import {
  buildDataStore,
  buildSpatialTreeFromStore,
  getEntityData,
  IfcTypeEnum,
  type IfcDataStore,
  type EntityData,
  type SpatialTreeNode,
} from './ifc-data.js';

// ── DOM refs ──────────────────────────────────────────────────────────
const canvas         = document.getElementById('viewer')         as HTMLCanvasElement;
const fileInput      = document.getElementById('file-input')     as HTMLInputElement;
const status         = document.getElementById('status')         as HTMLElement;
const selectionPanel = document.getElementById('selection-panel') as HTMLElement;
const entityTypeBadge = document.getElementById('entity-type-badge');
const entityIdEl     = document.getElementById('entity-id');
const panelBody      = document.getElementById('panel-body')     as HTMLElement;
const panelClose     = document.getElementById('panel-close')    as HTMLButtonElement;
const spatialTree    = document.getElementById('spatial-tree')   as HTMLElement;
const spatialSearch  = document.getElementById('spatial-search') as HTMLInputElement;
const spatialCount   = document.getElementById('spatial-entity-count') as HTMLElement;

if (!canvas || !fileInput || !status || !selectionPanel || !panelBody || !panelClose) {
  throw new Error('Required DOM elements missing — check index.html');
}

// ── Three.js setup ────────────────────────────────────────────────────
// `logarithmicDepthBuffer` spreads depth precision across the whole scene
// instead of crowding it near the camera. IFC models routinely stack
// near-coplanar surfaces (a roof slab resting on a gable wall, lined wall
// layers) far from the origin, where a linear depth buffer z-fights into
// stair-stepped seams. Logarithmic depth resolves those cleanly.
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene  = new THREE.Scene();
scene.background = new THREE.Color(0x0d1b2a);

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 10000);
camera.position.set(20, 15, 20);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = false; // sharp stop on release

// ── Lighting ──────────────────────────────────────────────────────────
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(50, 80, 50);
scene.add(dirLight);
const fillLight = new THREE.DirectionalLight(0xb0c4de, 0.3);
fillLight.position.set(-30, 10, -20);
scene.add(fillLight);

// ── State ─────────────────────────────────────────────────────────────
const geometry           = new GeometryProcessor();
const expressIdMap: ExpressIdMap = new Map();
const meshDataByExpressId = new Map<number, MeshData>();
let triangleMaps: TriangleMaps  = new Map();
let dataStore: IfcDataStore | null = null;
let spatialRoot: SpatialTreeNode | null = null;

let selectedExpressId: number | null = null;
let hoveredId: number | null = null;
let selectionHighlight: THREE.Mesh | null = null;
let modelRoot: THREE.Group | null = null;
let streamRoot: THREE.Group | null = null;

// ── Resize ────────────────────────────────────────────────────────────
function resize() {
  const el = canvas.parentElement ?? document.body;
  renderer.setSize(el.clientWidth, el.clientHeight);
  camera.aspect = el.clientWidth / el.clientHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ── Render loop ───────────────────────────────────────────────────────
(function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
})();

// ── Raycasting helpers ────────────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const pointer   = new THREE.Vector2();

function pickAt(clientX: number, clientY: number): number | null {
  if (triangleMaps.size === 0) return null;
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((clientX - rect.left) / rect.width)  * 2 - 1;
  pointer.y = -((clientY - rect.top)  / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects([...triangleMaps.keys()], false);
  if (!hits.length || hits[0].faceIndex == null) return null;
  const ranges = triangleMaps.get(hits[0].object as THREE.Mesh);
  return ranges ? findEntityByFace(ranges, hits[0].faceIndex) : null;
}

// ── Pointer / cursor management ───────────────────────────────────────
//
// Strategy: track drag-vs-click ourselves so we can:
//   • only show `grabbing` cursor when the pointer actually moves (not on a mere click)
//   • skip the selection handler after a genuine drag/orbit
//
// OrbitControls 'start'/'end' fire on every pointerdown/up — even plain clicks —
// so we do NOT use those events for cursor control.

const DRAG_THRESHOLD_PX = 4;
let pointerDownX = 0;
let pointerDownY = 0;
let didDrag = false;

canvas.addEventListener('pointerdown', (e) => {
  pointerDownX = e.clientX;
  pointerDownY = e.clientY;
  didDrag = false;
});

// Hover cursor: rAF-throttled, skipped while a button is held.
let hoverRafPending = false;
canvas.addEventListener('pointermove', (e) => {
  if (e.buttons !== 0) {
    // Pointer button held — detect drag and switch to grabbing
    if (!didDrag) {
      const dist = Math.hypot(e.clientX - pointerDownX, e.clientY - pointerDownY);
      if (dist > DRAG_THRESHOLD_PX) {
        didDrag = true;
        canvas.classList.add('dragging');
        canvas.classList.remove('hovering');
      }
    }
    return; // no hover detection while dragging
  }

  // No button held — update hover cursor once per frame
  if (hoverRafPending) return;
  hoverRafPending = true;
  // Capture coords now so they're correct inside the rAF callback
  const cx = e.clientX;
  const cy = e.clientY;
  requestAnimationFrame(() => {
    hoverRafPending = false;
    const id = pickAt(cx, cy);
    hoveredId = id;
    canvas.classList.toggle('hovering', id != null);
  });
});

canvas.addEventListener('pointerup', () => {
  canvas.classList.remove('dragging');
});

canvas.addEventListener('mouseleave', () => {
  hoveredId = null;
  canvas.classList.remove('hovering', 'dragging');
});

// ── Click → pick (only on genuine clicks, not after a drag) ───────────
canvas.addEventListener('click', (e) => {
  if (didDrag) return; // orbit/pan completed — not a selection click

  const expressId = pickAt(e.clientX, e.clientY);
  if (expressId == null) {
    clearSelection();
    closePanel();
  } else {
    selectEntity(expressId);
  }
});

// ── Keyboard ──────────────────────────────────────────────────────────
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { clearSelection(); closePanel(); }
});

// ── File loading ──────────────────────────────────────────────────────
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;

  status.textContent = `Loading ${file.name}…`;
  clearSelection();
  closePanel();
  resetSpatialPanel();

  // ── Timing ── start the clock before EVERYTHING (WASM init + file read + streaming + parser)
  const totalStartTime = performance.now();

  try {
    await geometry.init();

    // ── File read ─────────────────────────────────────────────────
    const fileReadStart = performance.now();
    const rawBuffer     = await file.arrayBuffer();
    const fileReadMs    = performance.now() - fileReadStart;
    const fileSizeMB    = rawBuffer.byteLength / (1024 * 1024);
    console.log(`[ThreeJS] File: ${file.name}, size: ${fileSizeMB.toFixed(2)} MB, read in ${fileReadMs.toFixed(0)} ms`);

    const buffer = new Uint8Array(rawBuffer);

    clearScene();

    const allMeshes: MeshData[] = [];
    const batchGroups: THREE.Group[] = [];
    streamRoot = new THREE.Group();
    streamRoot.name = 'stream-root';
    scene.add(streamRoot);

    // Per-batch timing
    let batchCount      = 0;
    let firstBatchMs    = 0;
    let geometryMs      = 0; // set at 'complete'
    let finalMeshCount  = 0;
    const STREAM_FIT_BATCH_INTERVAL = 26;
    let streamMinX = Infinity, streamMinY = Infinity, streamMinZ = Infinity;
    let streamMaxX = -Infinity, streamMaxY = -Infinity, streamMaxZ = -Infinity;
    let hasStreamBounds = false;

    function expandStreamBoundsFromMeshes(meshes: MeshData[]) {
      for (const m of meshes) {
        const p = m.positions;
        for (let i = 0; i < p.length; i += 3) {
          const x = p[i];
          const y = p[i + 1];
          const z = p[i + 2];
          if (x < streamMinX) streamMinX = x;
          if (y < streamMinY) streamMinY = y;
          if (z < streamMinZ) streamMinZ = z;
          if (x > streamMaxX) streamMaxX = x;
          if (y > streamMaxY) streamMaxY = y;
          if (z > streamMaxZ) streamMaxZ = z;
        }
      }
      hasStreamBounds = true;
    }

    function getStreamBounds(): { center: THREE.Vector3; maxDim: number } | null {
      if (!hasStreamBounds) return null;
      const center = new THREE.Vector3(
        (streamMinX + streamMaxX) / 2,
        (streamMinY + streamMaxY) / 2,
        (streamMinZ + streamMaxZ) / 2,
      );
      const sizeX = streamMaxX - streamMinX;
      const sizeY = streamMaxY - streamMinY;
      const sizeZ = streamMaxZ - streamMinZ;
      const maxDim = Math.max(sizeX, sizeY, sizeZ);
      if (maxDim <= 0 || !isFinite(maxDim)) return null;
      return { center, maxDim };
    }

    function fitIfDue() {
      const bounds = getStreamBounds();
      if (!bounds) return;
      applyCameraFit(bounds.center, bounds.maxDim, false);
    }

    for await (const event of geometry.processStreaming(buffer)) {
      switch (event.type) {
        case 'batch': {
          allMeshes.push(...event.meshes);
          expandStreamBoundsFromMeshes(event.meshes);
          const { group } = batchWithVertexColors(event.meshes);
          streamRoot.add(group);
          batchGroups.push(group);

          batchCount++;
          if (batchCount === 1) {
            firstBatchMs = performance.now() - totalStartTime;
            console.log(`[ThreeJS] Batch #1: ${event.meshes.length} meshes, wait: ${firstBatchMs.toFixed(0)} ms`);
          }

          status.textContent = `Streaming… ${allMeshes.length} meshes`;
          if (batchCount === 1 || batchCount % STREAM_FIT_BATCH_INTERVAL === 0) {
            fitIfDue();
          }
          break;
        }

        case 'complete': {
          geometryMs     = performance.now() - totalStartTime;
          finalMeshCount = event.totalMeshes;

          const totalVertices = allMeshes.reduce((sum, m) => sum + m.positions.length / 3, 0);
          console.log(
            `[ThreeJS] Geometry streaming complete: ${batchCount} batches, ` +
            `${finalMeshCount} meshes, ${(totalVertices / 1000).toFixed(0)}k vertices in ${geometryMs.toFixed(0)} ms`
          );

          const { group: finalGroup, expressIdMap: newMap, triangleMaps: newMaps } =
            batchWithVertexColors(allMeshes);

          modelRoot = finalGroup;
          scene.add(modelRoot);
          for (const [id, mesh] of newMap) expressIdMap.set(id, mesh);
          triangleMaps = newMaps;

          meshDataByExpressId.clear();
          for (const m of allMeshes) meshDataByExpressId.set(m.expressId, m);

          fitCameraToScene();

          requestAnimationFrame(() => {
            for (const g of batchGroups) { scene.remove(g); disposeGroup(g); }
            batchGroups.length = 0;
            if (streamRoot) {
              scene.remove(streamRoot);
              streamRoot = null;
            }
            renderer.render(scene, camera);
            const calls = renderer.info.render.calls;
            status.textContent = `${file.name} — ${finalMeshCount} meshes · ${calls} draw calls`;
          });

          // Build property + spatial data store (last async phase — defines TOTAL end time)
          dataStore   = null;
          spatialRoot = null;
          buildDataStore(rawBuffer)
            .then((store) => {
              const totalMs     = performance.now() - totalStartTime;
              const parserMs    = totalMs - geometryMs;
              const totalVerts  = allMeshes.reduce((sum, m) => sum + m.positions.length / 3, 0);

              dataStore   = store;
              spatialRoot = buildSpatialTreeFromStore(store);
              renderSpatialPanel(spatialRoot, store);

              // Refresh panel if something is already selected
              if (selectedExpressId !== null) {
                const md = meshDataByExpressId.get(selectedExpressId);
                if (md) renderPanel(getEntityData(store, selectedExpressId, md.ifcType ?? 'IfcProduct'));
              }

              // ── Final summary — matches main viewer style ──────────────
              console.log(
                `[ThreeJS] ✓ ${file.name} (${fileSizeMB.toFixed(1)} MB) → ` +
                `${finalMeshCount} meshes, ${(totalVerts / 1000).toFixed(0)}k vertices | ` +
                `file: ${fileReadMs.toFixed(0)} ms, ` +
                `first batch: ${firstBatchMs.toFixed(0)} ms, ` +
                `geometry: ${geometryMs.toFixed(0)} ms, ` +
                `parser: ${parserMs.toFixed(0)} ms`
              );
              console.log(`[ThreeJS] TOTAL LOAD TIME: ${totalMs.toFixed(0)} ms (${(totalMs / 1000).toFixed(1)} s)`);
            })
            .catch((err) => console.warn('[ThreeJS] buildDataStore failed:', err));

          break;
        }
      }
    }
  } catch (err) {
    console.error(err);
    status.textContent = `Error: ${(err as Error).message}`;
  }
});

// ── Selection ─────────────────────────────────────────────────────────
function selectEntity(expressId: number) {
  selectedExpressId = expressId;

  const md = meshDataByExpressId.get(expressId);
  if (!md) return;

  const ifcType = md.ifcType ?? 'IfcProduct';
  openPanel(ifcType, expressId);
  applyHighlight(md);

  if (dataStore) {
    renderPanel(getEntityData(dataStore, expressId, ifcType));
  } else {
    panelBody.innerHTML = `<p class="loading-data">Loading property data…</p>`;
  }

  revealInTree(expressId);
}

function clearSelection() {
  selectedExpressId = null;
  removeHighlight();
  // De-highlight tree row
  for (const row of spatialTree.querySelectorAll('.tree-row.selected')) {
    row.classList.remove('selected');
  }
}

// ── Selection highlight ───────────────────────────────────────────────
function applyHighlight(md: MeshData) {
  removeHighlight();

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(md.positions, 3));
  geo.setAttribute('normal',   new THREE.BufferAttribute(md.normals,   3));
  geo.setIndex(new THREE.BufferAttribute(md.indices, 1));
  geo.computeBoundingSphere();

  const mat = new THREE.MeshStandardMaterial({
    color: 0x4f46e5,
    emissive: 0x4f46e5,
    emissiveIntensity: 0.45,
    transparent: true,
    opacity: 0.72,
    side: THREE.DoubleSide,
    depthTest: true,
  });

  selectionHighlight = new THREE.Mesh(geo, mat);
  selectionHighlight.renderOrder = 1;
  scene.add(selectionHighlight);
}

function removeHighlight() {
  if (!selectionHighlight) return;
  scene.remove(selectionHighlight);
  selectionHighlight.geometry.dispose();
  (selectionHighlight.material as THREE.Material).dispose();
  selectionHighlight = null;
}

// ── Properties panel ──────────────────────────────────────────────────
function openPanel(ifcType: string, expressId: number) {
  if (entityTypeBadge) entityTypeBadge.textContent = ifcType;
  if (entityIdEl)      entityIdEl.textContent      = `#${expressId}`;
  selectionPanel.classList.add('open');
}

function closePanel() {
  selectionPanel.classList.remove('open');
  clearSelection();
}

panelClose.addEventListener('click', closePanel);

function renderPanel(data: EntityData) {
  const attrs: Array<[string, string]> = [
    ['GlobalId',    data.globalId    || '—'],
    ['Name',        data.name        || '—'],
    ['Description', data.description || '—'],
    ['ObjectType',  data.objectType  || '—'],
    ['Tag',         data.tag         || '—'],
  ];

  const attrsHtml = attrs.map(([label, value]) => {
    const empty = value === '—';
    return `<div class="attr-row">
      <span class="attr-label">${esc(label)}</span>
      <span class="attr-value${empty ? ' empty' : ''}">${esc(value)}</span>
    </div>`;
  }).join('');

  panelBody.innerHTML = `
    <div class="attr-section">
      <h3>Attributes</h3>${attrsHtml}
    </div>
    <div class="attr-section">
      <h3>Property Sets</h3>
      ${renderSets(data.propertySets.map(ps => ({
        name: ps.name,
        rows: ps.properties.map(p => [p.name, p.value] as [string, string]),
      })), 'No property sets')}
    </div>
    <div class="attr-section">
      <h3>Quantity Sets</h3>
      ${renderSets(data.quantitySets.map(qs => ({
        name: qs.name,
        rows: qs.quantities.map(q => [q.name, q.value] as [string, string]),
      })), 'No quantity sets')}
    </div>`;

  for (const btn of panelBody.querySelectorAll('.pset-toggle')) {
    btn.addEventListener('click', () => {
      btn.classList.toggle('open');
      btn.nextElementSibling?.classList.toggle('open');
    });
  }
}

function renderSets(sets: Array<{ name: string; rows: Array<[string, string]> }>, emptyMsg: string) {
  if (!sets.length) return `<p class="no-data">${emptyMsg}</p>`;
  return sets.map(({ name, rows }) => `
    <div class="pset-section">
      <button class="pset-toggle" type="button">
        <span>${esc(name)}</span><span class="pset-chevron">▶</span>
      </button>
      <div class="pset-body">
        ${rows.map(([n, v]) => `<div class="pset-prop">
          <span class="pset-prop-name">${esc(n)}</span>
          <span class="pset-prop-value">${esc(v)}</span>
        </div>`).join('')}
      </div>
    </div>`).join('');
}

// ── Spatial panel ─────────────────────────────────────────────────────

/** Render the full spatial tree into #spatial-tree */
function renderSpatialPanel(root: SpatialTreeNode | null, store: IfcDataStore) {
  if (!root) {
    spatialTree.innerHTML = `<p class="spatial-placeholder">No spatial structure found.</p>`;
    return;
  }

  const total = root.totalElements;
  spatialCount.textContent = `${total}`;
  spatialCount.style.display = '';

  spatialTree.innerHTML = buildNodeHtml(root, 0, store);

  // Event delegation — one listener handles all tree clicks
  spatialTree.onclick = handleTreeClick;

  // Wire up search
  spatialSearch.oninput = () => filterTree(spatialSearch.value.trim().toLowerCase(), store);
}

/** Reset panel to placeholder state */
function resetSpatialPanel() {
  spatialTree.innerHTML = `<p class="spatial-placeholder">Open an IFC file to explore its structure.</p>`;
  spatialTree.onclick = null;
  spatialSearch.value = '';
  spatialSearch.oninput = null;
  spatialCount.style.display = 'none';
}

/** Build the HTML for a spatial node and all its descendants. */
function buildNodeHtml(node: SpatialTreeNode, depth: number, store: IfcDataStore): string {
  const isSpatialContainer = depth < 4; // Project/Site/Building/Storey level
  const hasChildren = node.children.length > 0 || node.elementGroups.length > 0;
  const { icon, abbr } = spatialNodeMeta(node.type);
  const nameText = node.name || store.entities.getName(node.expressId) || `#${node.expressId}`;
  const subLabel = node.elevation != null ? ` ${node.elevation.toFixed(1)}m` : '';

  let childrenHtml = '';
  for (const child of node.children) {
    childrenHtml += buildNodeHtml(child, depth + 1, store);
  }
  for (const { typeName, ids } of node.elementGroups) {
    childrenHtml += buildTypeGroupHtml(typeName, ids, depth + 1);
  }

  // Auto-expand top 2 levels (Project, Site)
  const autoOpen = depth < 2;

  return `
<div class="tree-node" id="sn-${node.expressId}">
  <div class="tree-row${autoOpen ? '' : ''}"
       data-express-id="${node.expressId}"
       data-spatial="1"
       style="--tree-depth:${depth}">
    <span class="tree-toggle${hasChildren ? (autoOpen ? ' expanded' : '') : ' leaf'}"
          data-toggle-id="${node.expressId}">▶</span>
    <span class="tree-icon ${icon}">${abbr}</span>
    <span class="tree-label">${esc(nameText)}</span>
    ${subLabel ? `<span class="tree-sublabel">${esc(subLabel)}</span>` : ''}
    ${node.totalElements > 0 ? `<span class="tree-count">${node.totalElements}</span>` : ''}
  </div>
  <div class="tree-children${autoOpen ? ' open' : ''}" id="sc-${node.expressId}">
    ${childrenHtml}
  </div>
</div>`;
}

/** Build a type-group row (e.g. "IfcWall  ×12") and its element children. */
function buildTypeGroupHtml(typeName: string, ids: number[], depth: number): string {
  const color = typeColor(typeName);
  let elemRows = ids.map((id) => `
  <div class="tree-row"
       data-express-id="${id}"
       data-element="1"
       id="en-${id}"
       style="--tree-depth:${depth + 1}">
    <span class="tree-toggle leaf">▶</span>
    <span class="tree-icon icon-element" style="background:${color}"></span>
    <span class="tree-label dim">#${id}</span>
  </div>`).join('');

  return `
<div class="tree-node">
  <div class="tree-row"
       data-type-group="${esc(typeName)}"
       style="--tree-depth:${depth}">
    <span class="tree-toggle${ids.length ? '' : ' leaf'}" data-toggle-type="${esc(typeName)}-${depth}">▶</span>
    <span class="tree-icon icon-type" style="font-size:8px">${esc(typeName.replace('Ifc', '').substring(0,3).toUpperCase())}</span>
    <span class="tree-label">${esc(typeName.replace('Ifc', ''))}</span>
    <span class="tree-count">${ids.length}</span>
  </div>
  <div class="tree-children" id="tg-${esc(typeName)}-${depth}">
    ${elemRows}
  </div>
</div>`;
}

/** Click delegation handler for the spatial tree. */
function handleTreeClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  const row = target.closest<HTMLElement>('.tree-row');
  if (!row) return;

  // Expand/collapse toggle
  const toggleId = (target.closest('[data-toggle-id]') as HTMLElement | null)?.dataset.toggleId;
  const toggleType = (target.closest('[data-toggle-type]') as HTMLElement | null)?.dataset.toggleType;
  const toggleTarget = toggleId ?? toggleType;
  if (toggleTarget) {
    const toggle = row.querySelector('.tree-toggle') ?? target.closest('.tree-toggle');
    const childrenId = toggleId ? `sc-${toggleId}` : `tg-${toggleType}`;
    const children = document.getElementById(childrenId);
    if (children) {
      const nowOpen = children.classList.toggle('open');
      toggle?.classList.toggle('expanded', nowOpen);
    }
    e.stopPropagation();
    return;
  }

  // Spatial container row click — just expand/collapse
  if (row.dataset.spatial) {
    const id = row.dataset.expressId;
    if (!id) return;
    const children = document.getElementById(`sc-${id}`);
    const toggle   = row.querySelector<HTMLElement>('.tree-toggle');
    if (children && toggle && !toggle.classList.contains('leaf')) {
      const nowOpen = children.classList.toggle('open');
      toggle.classList.toggle('expanded', nowOpen);
    }
    return;
  }

  // Element row click — select entity
  if (row.dataset.element) {
    const id = parseInt(row.dataset.expressId ?? '', 10);
    if (!isNaN(id)) selectEntity(id);
    return;
  }
}

/** Reveal and highlight the tree row for the given expressId. */
function revealInTree(expressId: number) {
  // Clear previous selection in tree
  for (const row of spatialTree.querySelectorAll('.tree-row.selected')) {
    row.classList.remove('selected');
  }

  const row = document.getElementById(`en-${expressId}`)?.querySelector('.tree-row') ??
              document.getElementById(`en-${expressId}`);
  if (!row) {
    // Try to expand the containing storey so the row appears
    if (dataStore?.spatialHierarchy) {
      const storeyId = dataStore.spatialHierarchy.elementToStorey.get(expressId);
      if (storeyId != null) {
        expandSpatialNode(storeyId);
        // Try again after DOM update
        requestAnimationFrame(() => revealInTree(expressId));
      }
    }
    return;
  }

  row.classList.add('selected');
  row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/** Expand the tree path down to the node with the given expressId. */
function expandSpatialNode(expressId: number) {
  const children = document.getElementById(`sc-${expressId}`);
  if (!children) return;
  if (!children.classList.contains('open')) {
    children.classList.add('open');
    const toggle = document.querySelector(`[data-toggle-id="${expressId}"]`);
    toggle?.classList.add('expanded');
  }
}

/** Filter tree to show only nodes/types matching the query. */
function filterTree(query: string, store: IfcDataStore) {
  if (!spatialRoot) return;
  if (!query) {
    // Restore full tree
    spatialTree.innerHTML = buildNodeHtml(spatialRoot, 0, store);
    spatialTree.onclick = handleTreeClick;
    return;
  }

  // Collect matching element rows only
  const matches: Array<{ id: number; typeName: string; name: string }> = [];
  collectMatchingElements(spatialRoot, query, store, matches);

  if (!matches.length) {
    spatialTree.innerHTML = `<p class="spatial-placeholder">No results for "${esc(query)}"</p>`;
    spatialTree.onclick = null;
    return;
  }

  const rows = matches.map(({ id, typeName, name }) => {
    const color = typeColor(typeName);
    return `<div class="tree-row" data-express-id="${id}" data-element="1"
                 id="en-${id}" style="--tree-depth:0">
      <span class="tree-toggle leaf">▶</span>
      <span class="tree-icon icon-element" style="background:${color}"></span>
      <span class="tree-label">${esc(name || `#${id}`)}</span>
      <span class="tree-sublabel">${esc(typeName.replace('Ifc', ''))}</span>
    </div>`;
  }).join('');

  spatialTree.innerHTML = `
    <div class="tree-node">
      <div class="tree-children open">${rows}</div>
    </div>`;
  spatialTree.onclick = handleTreeClick;
}

function collectMatchingElements(
  node: SpatialTreeNode,
  query: string,
  store: IfcDataStore,
  out: Array<{ id: number; typeName: string; name: string }>,
) {
  for (const { typeName, ids } of node.elementGroups) {
    for (const id of ids) {
      const name = store.entities.getName(id) || '';
      const typeMatch  = typeName.toLowerCase().includes(query);
      const nameMatch  = name.toLowerCase().includes(query);
      const idMatch    = String(id).includes(query);
      if (typeMatch || nameMatch || idMatch) {
        out.push({ id, typeName, name });
      }
    }
  }
  for (const child of node.children) {
    collectMatchingElements(child, query, store, out);
  }
}

// ── Spatial node metadata ─────────────────────────────────────────────
function spatialNodeMeta(type: IfcTypeEnum): { icon: string; abbr: string } {
  switch (type) {
    case IfcTypeEnum.IfcProject:        return { icon: 'icon-project',  abbr: 'PRJ' };
    case IfcTypeEnum.IfcSite:           return { icon: 'icon-site',     abbr: 'SIT' };
    case IfcTypeEnum.IfcBuilding:       return { icon: 'icon-building', abbr: 'BLD' };
    case IfcTypeEnum.IfcFacility:
    case IfcTypeEnum.IfcBridge:
    case IfcTypeEnum.IfcRoad:
    case IfcTypeEnum.IfcRailway:
    case IfcTypeEnum.IfcMarineFacility: return { icon: 'icon-building', abbr: 'FAC' };
    case IfcTypeEnum.IfcBuildingStorey: return { icon: 'icon-storey',   abbr: 'STR' };
    case IfcTypeEnum.IfcFacilityPart:
    case IfcTypeEnum.IfcBridgePart:
    case IfcTypeEnum.IfcRoadPart:
    case IfcTypeEnum.IfcRailwayPart:    return { icon: 'icon-storey',   abbr: 'PRT' };
    case IfcTypeEnum.IfcSpace:          return { icon: 'icon-space',    abbr: 'SPC' };
    default:                            return { icon: 'icon-type',     abbr: '?' };
  }
}

/** Deterministic hue from a type name string. */
function typeColor(typeName: string): string {
  let h = 0;
  for (let i = 0; i < typeName.length; i++) h = (h * 31 + typeName.charCodeAt(i)) & 0xffff;
  return `hsl(${h % 360},55%,52%)`;
}

// ── Scene helpers ─────────────────────────────────────────────────────
function clearScene() {
  clearSelection();
  triangleMaps.clear();
  expressIdMap.clear();
  meshDataByExpressId.clear();
  dataStore   = null;
  spatialRoot = null;
  modelRoot = null;
  if (streamRoot) {
    scene.remove(streamRoot);
    disposeGroup(streamRoot);
    streamRoot = null;
  }

  const toRemove = scene.children.filter(
    (o) => o instanceof THREE.Mesh || o instanceof THREE.Group,
  );
  for (const o of toRemove) { scene.remove(o); disposeGroup(o); }
}

function disposeGroup(obj: THREE.Object3D) {
  obj.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      if (Array.isArray(child.material)) {
        (child.material as THREE.Material[]).forEach((m) => m.dispose());
      } else {
        (child.material as THREE.Material).dispose();
      }
    }
  });
}

function fitCameraToScene() {
  const fitObject = modelRoot ?? streamRoot;
  if (!fitObject) return;
  const bounds = getBoundsForObject(fitObject);
  if (!bounds) return;
  applyCameraFit(bounds.center, bounds.maxDim, true);
}

function getBoundsForObject(root: THREE.Object3D | null): { center: THREE.Vector3; maxDim: number } | null {
  if (!root) return null;
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) return null;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim <= 0 || !isFinite(maxDim)) return null;
  return { center, maxDim };
}

function applyCameraFit(center: THREE.Vector3, maxDim: number, immediate: boolean) {
  const distance = maxDim * 1.5;
  const near = maxDim * 0.001;
  const far = maxDim * 100;

  if (immediate) {
    // Final home view: south-west, ~25deg elevation.
    const elevRad = THREE.MathUtils.degToRad(25);
    const planar = Math.cos(elevRad);
    const offset = new THREE.Vector3(
      planar * distance * Math.SQRT1_2,
      Math.sin(elevRad) * distance,
      -planar * distance * Math.SQRT1_2,
    );
    controls.target.copy(center);
    camera.position.copy(center).add(offset);
    controls.update();
    camera.near = near;
    camera.far = far;
    camera.updateProjectionMatrix();
    return;
  }

  // Stream updates: keep current orbit orientation and only reframe distance/target.
  const dir = camera.position.clone().sub(controls.target);
  if (dir.lengthSq() < 1e-8) {
    dir.set(1, 1, -1).normalize();
  } else {
    dir.normalize();
  }
  controls.target.copy(center);
  camera.position.copy(center).add(dir.multiplyScalar(distance));
  camera.near = near;
  camera.far = far;
  camera.updateProjectionMatrix();
  controls.update();
}

// ── Misc ──────────────────────────────────────────────────────────────
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
