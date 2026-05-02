/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Two-tab live demo of @ifc-lite/collab.
 *
 * Open this page in TWO browser tabs / windows pointing at the same
 * URL — both connect to the same room over the websocket server, and
 * every edit, cursor move, and selection change shows up live on the
 * other side.
 */

import {
  attachHistorySidecar,
  colorForUser,
  createCollabSession,
  createConflictUIBridge,
  createEntity,
  deleteEntity,
  entityToJSON,
  entitiesMap,
  iterEntities,
  MemoryHistorySidecar,
  mountPresenceInViewer,
  setAttribute,
  type CollabSession,
  type ConflictBucket,
  type HistoryEntry,
} from '@ifc-lite/collab';

const SERVER_URL = `ws://${location.hostname}:1234`;
const ROOM_ID = 'demo/board';

// Stable per-tab user id so cursors get distinct colors.
const userId =
  localStorage.getItem('collab-demo-user') ??
  (() => {
    const u = `user-${Math.floor(Math.random() * 1_000_000)}`;
    localStorage.setItem('collab-demo-user', u);
    return u;
  })();

const session = await createCollabSession({
  roomId: ROOM_ID,
  user: { id: userId, name: userId, color: colorForUser(userId) },
  provider: 'websocket',
  serverUrl: SERVER_URL,
  // disable BroadcastChannel so two tabs in the same browser actually
  // sync via the server (otherwise BC short-circuits and the server
  // never sees the writes — easy to confuse).
  WebSocketPolyfill: undefined,
});

// ── Status pill ────────────────────────────────────────────────────
const statusEl = document.getElementById('status')!;
session.onStatus((s) => {
  statusEl.textContent = s;
  statusEl.className = 'pill ' + (s === 'connected' ? 'green' : s === 'offline' ? 'red' : '');
});

// ── Me pill ────────────────────────────────────────────────────────
const meEl = document.getElementById('me')!;
meEl.textContent = `you: ${userId}`;
meEl.style.color = colorForUser(userId);

// ── Peers pill ─────────────────────────────────────────────────────
const peersEl = document.getElementById('peers')!;
session.presence.onUpdate((peers) => {
  const others = Object.keys(peers).filter((id) => Number(id) !== session.clientId);
  peersEl.textContent = `${others.length} peer${others.length === 1 ? '' : 's'}`;
});

// ── Presence overlay (cursors + labels) ────────────────────────────
const stage = document.getElementById('stage') as HTMLDivElement;
stage.style.position = 'relative';
mountPresenceInViewer({
  session,
  container: stage,
  viewport: 'plan',
});

// ── Entity rendering ───────────────────────────────────────────────
const entitiesPanel = document.getElementById('entities')!;
let selectedPath: string | null = null;

function entityBoxes(): { path: string; x: number; y: number; w: number; h: number; name: string }[] {
  const boxes: { path: string; x: number; y: number; w: number; h: number; name: string }[] = [];
  let i = 0;
  for (const [path, entity] of iterEntities(session.doc)) {
    const json = entityToJSON(entity);
    const name = (json.attributes.Name as string) ?? path.slice(0, 8);
    boxes.push({
      path,
      name,
      x: 80 + (i % 6) * 110,
      y: 80 + Math.floor(i / 6) * 90,
      w: 90,
      h: 60,
    });
    i++;
  }
  return boxes;
}

function render(): void {
  // Entities sidebar.
  entitiesPanel.innerHTML = '';
  for (const e of entityBoxes()) {
    const div = document.createElement('div');
    div.className = 'entity' + (e.path === selectedPath ? ' selected' : '');
    div.innerHTML = `<span>${e.name}</span><span class="meta">${e.path.slice(0, 8)}</span>`;
    div.addEventListener('click', () => {
      selectedPath = e.path;
      session.presence.setSelection([e.path]);
      render();
    });
    entitiesPanel.appendChild(div);
  }

  // Stage canvas — draw boxes.
  let canvas = stage.querySelector<HTMLCanvasElement>('.stage-canvas');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.className = 'stage-canvas';
    canvas.style.position = 'absolute';
    canvas.style.inset = '0';
    canvas.style.zIndex = '1';
    stage.insertBefore(canvas, stage.firstChild);
  }
  const dpr = window.devicePixelRatio || 1;
  const r = stage.getBoundingClientRect();
  canvas.width = r.width * dpr;
  canvas.height = r.height * dpr;
  canvas.style.width = `${r.width}px`;
  canvas.style.height = `${r.height}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  for (const e of entityBoxes()) {
    const isSelected = selectedPath === e.path;
    ctx.fillStyle = isSelected ? '#1f6feb' : '#21262d';
    ctx.strokeStyle = '#30363d';
    ctx.lineWidth = 1;
    ctx.fillRect(e.x, e.y, e.w, e.h);
    ctx.strokeRect(e.x, e.y, e.w, e.h);
    ctx.fillStyle = '#e6edf3';
    ctx.font = '12px sans-serif';
    ctx.fillText(e.name, e.x + 8, e.y + 24);
  }
}

// Click on stage → select entity if hit, else clear.
stage.addEventListener('click', (event) => {
  const rect = stage.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const hit = entityBoxes().find((e) => x >= e.x && x <= e.x + e.w && y >= e.y && y <= e.y + e.h);
  selectedPath = hit?.path ?? null;
  session.presence.setSelection(hit ? [hit.path] : []);
  render();
});

// Re-render whenever the Y.Doc changes.
entitiesMap(session.doc).observeDeep(() => render());
session.presence.onUpdate(() => render());

// ── Add wall button ───────────────────────────────────────────────
document.getElementById('add-wall')!.addEventListener('click', () => {
  const id = crypto.randomUUID();
  session.transact(() => {
    createEntity(session.doc, id, {
      ifcClass: 'IfcWall',
      attributes: { Name: `Wall ${Math.floor(Math.random() * 1000)}` },
    });
  });
  selectedPath = id;
  render();
});

// ── Undo / redo ───────────────────────────────────────────────────
document.getElementById('undo')!.addEventListener('click', () => session.undo());
document.getElementById('redo')!.addEventListener('click', () => session.redo());

// ── Force conflict button ─────────────────────────────────────────
document.getElementById('conflict')!.addEventListener('click', () => {
  const last = entityBoxes().pop();
  if (!last) return;
  session.transact(() => {
    setAttribute(session.doc, last.path, 'Name', `${userId}-${Date.now() % 1000}`);
  });
});

// ── Conflicts panel ───────────────────────────────────────────────
const bridge = createConflictUIBridge(session.conflicts, { closeAfterMs: 8_000 });
bridge.onKeepMine('attribute', ({ bucket }) => {
  // Demo behaviour: re-stamp our own Name so we win the next round.
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
  for (const b of buckets) renderBucket(b);
}
function renderBucket(b: ConflictBucket): void {
  const div = document.createElement('div');
  div.className = 'conflict';
  div.innerHTML = `
    <div><strong>${b.kind}</strong> · ${b.path}${b.field ? '/' + b.field : ''}</div>
    <div class="meta">contributors: ${[...b.contributors].join(', ')}</div>
  `;
  const keep = document.createElement('button');
  keep.textContent = 'keep mine';
  keep.addEventListener('click', () => bridge.keepMine(b.key));
  const accept = document.createElement('button');
  accept.textContent = 'accept theirs';
  accept.addEventListener('click', () => bridge.acceptTheirs(b.key));
  div.append(keep, accept);
  conflictsPanel.appendChild(div);
}
bridge.on(() => renderConflicts());
setInterval(() => renderConflicts(), 1000);

// ── History sidecar ───────────────────────────────────────────────
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

// First render so the empty board shows up.
await session.whenSynced;
render();

// Expose for ad-hoc poking from the DevTools console.
declare global {
  interface Window {
    session: CollabSession;
    sidecar: MemoryHistorySidecar;
    bridge: ReturnType<typeof createConflictUIBridge>;
  }
}
window.session = session;
window.sidecar = sidecar;
window.bridge = bridge;
