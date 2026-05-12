/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Three.js + @ifc-lite/collab — two-tab live 3D walls.
 *
 * Each entity is rendered as a real 3D box on a floor grid. Position,
 * size, rotation and color are CRDT attributes — drag a wall in tab A
 * and the same wall slides in tab B over the websocket server. Peer
 * selections are outlined in each user's color.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  attachHistorySidecar,
  colorForUser,
  createCollabSession,
  createConflictUIBridge,
  createEntity,
  deleteEntity,
  entitiesMap,
  entityToJSON,
  iterEntities,
  MemoryHistorySidecar,
  mountPresenceInViewer,
  setAttribute,
  type CollabSession,
  type ConflictBucket,
  type HistoryEntry,
} from '@ifc-lite/collab';

// ── Session ───────────────────────────────────────────────────────────
const SERVER_URL = `ws://${location.hostname}:1234`;
const ROOM_ID = 'demo/three-walls';

const userId =
  localStorage.getItem('collab-3d-user') ??
  (() => {
    const u = `user-${Math.floor(Math.random() * 1_000_000)}`;
    localStorage.setItem('collab-3d-user', u);
    return u;
  })();
const userColor = colorForUser(userId);

const session = await createCollabSession({
  roomId: ROOM_ID,
  user: { id: userId, name: userId, color: userColor },
  provider: 'websocket',
  serverUrl: SERVER_URL,
  WebSocketPolyfill: undefined,
});

// ── Toolbar pills & buttons ──────────────────────────────────────────
const statusEl = document.getElementById('status')!;
const meEl = document.getElementById('me')!;
const peersEl = document.getElementById('peers')!;
meEl.textContent = `you: ${userId}`;
meEl.style.color = userColor;
session.onStatus((s) => {
  statusEl.textContent = s;
  statusEl.className = 'pill ' + (s === 'connected' ? 'green' : s === 'offline' ? 'red' : '');
});
session.presence.onUpdate((peers) => {
  const others = Object.keys(peers).filter((id) => Number(id) !== session.clientId);
  peersEl.textContent = `${others.length} peer${others.length === 1 ? '' : 's'}`;
});

// ── Three.js scene ───────────────────────────────────────────────────
const stage = document.getElementById('stage') as HTMLDivElement;
const canvas = document.getElementById('viewer') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a1422);
scene.fog = new THREE.Fog(0x0a1422, 30, 80);

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
camera.position.set(10, 8, 12);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 1, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.mouseButtons = {
  LEFT: null as unknown as THREE.MOUSE,
  MIDDLE: THREE.MOUSE.DOLLY,
  RIGHT: THREE.MOUSE.ROTATE,
};
controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };

scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const sun = new THREE.DirectionalLight(0xffffff, 0.85);
sun.position.set(15, 25, 10);
scene.add(sun);
scene.add(new THREE.HemisphereLight(0x9bbcff, 0x0a1422, 0.4));

const grid = new THREE.GridHelper(40, 40, 0x30363d, 0x1c2632);
(grid.material as THREE.LineBasicMaterial).transparent = true;
(grid.material as THREE.LineBasicMaterial).opacity = 0.6;
scene.add(grid);
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40),
  new THREE.MeshStandardMaterial({ color: 0x0d1828, roughness: 1 }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

function resize() {
  const r = stage.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / Math.max(r.height, 1);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

(function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
})();

// ── Wall meshes mirror CRDT entities ─────────────────────────────────
interface WallView {
  group: THREE.Group;
  body: THREE.Mesh;
  outline: THREE.LineSegments;
  label: HTMLDivElement;
}
const walls = new Map<string, WallView>();

const labelLayer = document.createElement('div');
labelLayer.style.cssText = 'position:absolute; inset:0; pointer-events:none; z-index:3;';
stage.appendChild(labelLayer);

function attrNum(o: Record<string, unknown>, k: string, d: number): number {
  const v = o[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}
function attrStr(o: Record<string, unknown>, k: string, d: string): string {
  const v = o[k];
  return typeof v === 'string' ? v : d;
}

function createWallView(path: string, attrs: Record<string, unknown>): WallView {
  const colorHex = attrStr(attrs, 'color', '#a3b6ff');
  const baseColor = new THREE.Color(colorHex);
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: baseColor, roughness: 0.7, metalness: 0.05 }),
  );
  body.castShadow = true;
  const edges = new THREE.EdgesGeometry(body.geometry);
  const outline = new THREE.LineSegments(
    edges,
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 }),
  );
  const group = new THREE.Group();
  group.add(body);
  group.add(outline);
  group.userData.path = path;
  scene.add(group);

  const label = document.createElement('div');
  label.style.cssText =
    'position:absolute; transform:translate(-50%,-100%); padding:2px 6px;' +
    'background:#161b22cc; border:1px solid #30363d; border-radius:4px;' +
    'font:11px ui-sans-serif,system-ui; color:#e6edf3; white-space:nowrap;';
  labelLayer.appendChild(label);

  return { group, body, outline, label };
}

function applyAttrs(view: WallView, attrs: Record<string, unknown>): void {
  const length = Math.max(0.1, attrNum(attrs, 'length', 3));
  const height = Math.max(0.1, attrNum(attrs, 'height', 2.7));
  const thickness = Math.max(0.05, attrNum(attrs, 'thickness', 0.2));
  const x = attrNum(attrs, 'x', 0);
  const z = attrNum(attrs, 'z', 0);
  const angle = attrNum(attrs, 'angle', 0);
  view.group.position.set(x, height / 2, z);
  view.group.rotation.y = angle;
  view.body.scale.set(length, height, thickness);
  view.outline.scale.set(length, height, thickness);
  const colorHex = attrStr(attrs, 'color', '#a3b6ff');
  (view.body.material as THREE.MeshStandardMaterial).color.set(colorHex);
  view.label.textContent = attrStr(attrs, 'Name', 'Wall');
}

function disposeWall(view: WallView): void {
  scene.remove(view.group);
  view.body.geometry.dispose();
  (view.body.material as THREE.Material).dispose();
  view.outline.geometry.dispose();
  (view.outline.material as THREE.Material).dispose();
  view.label.remove();
}

function syncFromDoc(): void {
  const seen = new Set<string>();
  for (const [path, entity] of iterEntities(session.doc)) {
    seen.add(path);
    const json = entityToJSON(entity);
    let view = walls.get(path);
    if (!view) {
      view = createWallView(path, json.attributes);
      walls.set(path, view);
    }
    applyAttrs(view, json.attributes);
  }
  for (const [path, view] of walls) {
    if (!seen.has(path)) {
      disposeWall(view);
      walls.delete(path);
    }
  }
  refreshOutlines();
  renderEntitiesPanel();
}

entitiesMap(session.doc).observeDeep(() => syncFromDoc());

// ── Selection + peer outlines ─────────────────────────────────────────
let selectedPath: string | null = null;
function refreshOutlines(): void {
  const peers = session.presence.getPeers();
  const selectionByPath = new Map<string, string>();
  for (const [clientId, p] of Object.entries(peers)) {
    if (Number(clientId) === session.clientId) continue;
    const sel = p.selection?.[0];
    if (sel) selectionByPath.set(sel, p.user.color);
  }
  for (const [path, view] of walls) {
    const mat = view.outline.material as THREE.LineBasicMaterial;
    if (path === selectedPath) {
      mat.color.set(userColor);
      mat.opacity = 1;
    } else if (selectionByPath.has(path)) {
      mat.color.set(selectionByPath.get(path)!);
      mat.opacity = 0.9;
    } else {
      mat.opacity = 0;
    }
  }
}
session.presence.onUpdate(() => {
  refreshOutlines();
  renderEntitiesPanel();
});

// ── Picking + drag-on-floor ──────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const dragHit = new THREE.Vector3();
let dragOffset: THREE.Vector3 | null = null;
let dragPath: string | null = null;
let lastDragSent = 0;

function pickWall(ev: PointerEvent): string | null {
  const rect = canvas.getBoundingClientRect();
  ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  const meshes = [...walls.values()].map((w) => w.body);
  const hits = raycaster.intersectObjects(meshes, false);
  if (!hits.length) return null;
  return (hits[0].object.parent?.userData.path as string) ?? null;
}

function projectToFloor(ev: PointerEvent, out: THREE.Vector3): boolean {
  const rect = canvas.getBoundingClientRect();
  ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  return raycaster.ray.intersectPlane(dragPlane, out) != null;
}

canvas.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  const path = pickWall(ev);
  if (path) {
    selectedPath = path;
    session.presence.setSelection([path]);
    refreshOutlines();
    renderEntitiesPanel();
    if (projectToFloor(ev, dragHit)) {
      const view = walls.get(path)!;
      dragOffset = dragHit.clone().sub(view.group.position).setY(0);
      dragPath = path;
      canvas.setPointerCapture(ev.pointerId);
    }
  } else {
    selectedPath = null;
    session.presence.setSelection([]);
    refreshOutlines();
    renderEntitiesPanel();
  }
});
canvas.addEventListener('pointermove', (ev) => {
  if (!dragPath || !dragOffset) return;
  if (!projectToFloor(ev, dragHit)) return;
  const target = dragHit.clone().sub(dragOffset);
  const now = performance.now();
  if (now - lastDragSent < 33) return;
  lastDragSent = now;
  session.transact(() => {
    setAttribute(session.doc, dragPath!, 'x', target.x);
    setAttribute(session.doc, dragPath!, 'z', target.z);
  });
});
canvas.addEventListener('pointerup', (ev) => {
  if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
  dragPath = null;
  dragOffset = null;
});
window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    selectedPath = null;
    session.presence.setSelection([]);
    refreshOutlines();
    renderEntitiesPanel();
  }
});

// ── Project labels each frame ────────────────────────────────────────
const labelVec = new THREE.Vector3();
(function projectLabels() {
  requestAnimationFrame(projectLabels);
  const rect = stage.getBoundingClientRect();
  for (const view of walls.values()) {
    labelVec.copy(view.group.position);
    labelVec.y += (view.group.scale.y || 1) * 0.5 + view.body.scale.y * 0.5 + 0.3;
    labelVec.project(camera);
    const x = (labelVec.x * 0.5 + 0.5) * rect.width;
    const y = (-labelVec.y * 0.5 + 0.5) * rect.height;
    const visible = labelVec.z > -1 && labelVec.z < 1;
    view.label.style.opacity = visible ? '1' : '0';
    view.label.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
  }
})();

// ── Toolbar wiring ───────────────────────────────────────────────────
function randomFloorPos(): { x: number; z: number } {
  return { x: (Math.random() - 0.5) * 10, z: (Math.random() - 0.5) * 10 };
}

document.getElementById('add-wall')!.addEventListener('click', () => {
  const id = crypto.randomUUID();
  const pos = randomFloorPos();
  session.transact(() => {
    createEntity(session.doc, id, {
      ifcClass: 'IfcWall',
      attributes: {
        Name: `Wall ${Math.floor(Math.random() * 1000)}`,
        x: pos.x,
        z: pos.z,
        length: 3,
        height: 2.7,
        thickness: 0.2,
        angle: Math.random() * Math.PI,
        color: userColor,
      },
    });
  });
  selectedPath = id;
  session.presence.setSelection([id]);
});
document.getElementById('undo')!.addEventListener('click', () => session.undo());
document.getElementById('redo')!.addEventListener('click', () => session.redo());
document.getElementById('delete')!.addEventListener('click', () => {
  if (!selectedPath) return;
  session.transact(() => deleteEntity(session.doc, selectedPath!));
  selectedPath = null;
  session.presence.setSelection([]);
});
document.getElementById('conflict')!.addEventListener('click', () => {
  const last = [...walls.keys()].pop();
  if (!last) return;
  session.transact(() => {
    setAttribute(session.doc, last, 'Name', `${userId}-${Date.now() % 1000}`);
  });
});
window.addEventListener('keydown', (ev) => {
  const meta = ev.metaKey || ev.ctrlKey;
  if (meta && ev.key.toLowerCase() === 'z') {
    ev.preventDefault();
    if (ev.shiftKey) session.redo();
    else session.undo();
  }
});

// ── Entities panel ───────────────────────────────────────────────────
const entitiesPanel = document.getElementById('entities')!;
function renderEntitiesPanel(): void {
  entitiesPanel.innerHTML = '';
  for (const [path, entity] of iterEntities(session.doc)) {
    const json = entityToJSON(entity);
    const div = document.createElement('div');
    div.className = 'entity' + (path === selectedPath ? ' selected' : '');
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = attrStr(json.attributes, 'color', '#a3b6ff');
    const name = document.createElement('span');
    name.textContent = attrStr(json.attributes, 'Name', path.slice(0, 8));
    const left = document.createElement('span');
    left.style.cssText = 'display:flex; gap:8px; align-items:center; min-width:0;';
    left.append(swatch, name);
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = path.slice(0, 8);
    div.append(left, meta);
    div.addEventListener('click', () => {
      selectedPath = path;
      session.presence.setSelection([path]);
      const view = walls.get(path);
      if (view) {
        const targ = view.group.position.clone();
        controls.target.copy(targ);
      }
      refreshOutlines();
      renderEntitiesPanel();
    });
    entitiesPanel.appendChild(div);
  }
}

// ── Conflict bridge UI ───────────────────────────────────────────────
const bridge = createConflictUIBridge(session.conflicts, { closeAfterMs: 8_000 });
bridge.onKeepMine('attribute', ({ bucket }) => {
  session.transact(() => {
    setAttribute(session.doc, bucket.path, bucket.field!, `${userId}-keep-mine`);
  });
});
const conflictsPanel = document.getElementById('conflicts')!;
function renderConflicts(): void {
  const buckets = bridge.active();
  if (buckets.length === 0) {
    conflictsPanel.innerHTML = '<div class="meta">none</div>';
    return;
  }
  conflictsPanel.innerHTML = '';
  for (const b of buckets) {
    const div = document.createElement('div');
    div.className = 'conflict';
    div.innerHTML =
      `<div><strong>${b.kind}</strong> · ${b.path}${b.field ? '/' + b.field : ''}</div>` +
      `<div class="meta">contributors: ${[...b.contributors].join(', ')}</div>`;
    const keep = document.createElement('button');
    keep.textContent = 'keep mine';
    keep.addEventListener('click', () => bridge.keepMine(b.key));
    const accept = document.createElement('button');
    accept.textContent = 'accept theirs';
    accept.addEventListener('click', () => bridge.acceptTheirs(b.key));
    div.append(keep, accept);
    conflictsPanel.appendChild(div);
  }
}
bridge.on(() => renderConflicts());
setInterval(() => renderConflicts(), 1000);

// ── History sidecar ──────────────────────────────────────────────────
const historyEl = document.getElementById('history')!;
const sidecar = new MemoryHistorySidecar();
const history = attachHistorySidecar(session, sidecar, { intervalMs: 30_000 });
document.getElementById('snapshot')!.addEventListener('click', async () => {
  const entry = await history.capture(`manual ${new Date().toLocaleTimeString()}`);
  appendHistory(entry);
});
function appendHistory(entry: HistoryEntry): void {
  const div = document.createElement('div');
  div.className = 'meta';
  div.textContent = `${entry.at.slice(11, 19)} · ${entry.label ?? entry.entryId}`;
  historyEl.prepend(div);
}

// ── Presence overlay (screen-space cursors) ──────────────────────────
mountPresenceInViewer({ session, container: stage, viewport: '3d' });

// ── Initial render ───────────────────────────────────────────────────
await session.whenSynced;
syncFromDoc();
renderConflicts();

declare global {
  interface Window {
    session: CollabSession;
    sidecar: MemoryHistorySidecar;
    bridge: ReturnType<typeof createConflictUIBridge>;
    THREE: typeof THREE;
  }
}
window.session = session;
window.sidecar = sidecar;
window.bridge = bridge;
window.THREE = THREE;
