/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC-Lite Desktop / native-backend reference frontend.
 *
 * The same UI runs in two native-geometry modes, chosen at runtime:
 *
 * - **Tauri desktop** (`isTauri()`): `GeometryProcessor({ preferNative: true })`
 *   routes geometry through the `NativeBridge` → in-process Rust commands.
 * - **Plain web app**: connects to `ifc-lite-desktop-server` over WebSocket and
 *   streams packed shards from native Rust on localhost (see `ws-backend.ts`).
 *
 * Either way geometry is processed **natively** (no WASM) and arrives in WebGL
 * Y-up, ready for three.js.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { streamFromNativeBackend, type DecodedMesh } from './ws-backend.js';

const NATIVE_BACKEND_URL =
  (import.meta.env.VITE_NATIVE_BACKEND_URL as string | undefined) ?? 'ws://127.0.0.1:8082/geometry';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const statusEl = document.getElementById('status') as HTMLSpanElement;
const openBtn = document.getElementById('open') as HTMLButtonElement;
const canvas = document.getElementById('viewport') as HTMLCanvasElement;

const setStatus = (text: string): void => {
  statusEl.textContent = text;
};

// ── three.js scene ──
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1e1e22);

const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 100_000);
camera.position.set(20, 20, 20);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(1, 2, 1.5);
scene.add(sun);

const modelGroup = new THREE.Group();
scene.add(modelGroup);

function resize(): void {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== w || canvas.height !== h) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}

renderer.setAnimationLoop(() => {
  resize();
  controls.update();
  renderer.render(scene, camera);
});

function fitCameraToModel(): void {
  const box = new THREE.Box3().setFromObject(modelGroup);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) || 1;
  controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(1, 0.8, 1).multiplyScalar(radius * 1.6));
  camera.near = radius / 100;
  camera.far = radius * 100;
  camera.updateProjectionMatrix();
  controls.update();
}

function clearModel(): void {
  for (const child of [...modelGroup.children]) {
    modelGroup.remove(child);
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[];
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat?.dispose();
  }
}

function addMesh(mesh: DecodedMesh): void {
  if (mesh.positions.length === 0 || mesh.indices.length === 0) return;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  if (mesh.normals.length === mesh.positions.length) {
    geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
  } else {
    geometry.computeVertexNormals();
  }
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));

  const [r, g, b, a] = mesh.color;
  const material = new THREE.MeshLambertMaterial({
    color: new THREE.Color(r, g, b),
    transparent: a < 1,
    opacity: a,
    side: THREE.DoubleSide,
  });
  modelGroup.add(new THREE.Mesh(geometry, material));
}

// ── File picking (native dialog in Tauri, <input> on the web) ──
interface PickedFile {
  name: string;
  size: number;
  bytes: Uint8Array;
}

async function pickFile(): Promise<PickedFile | null> {
  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core');
    const { readFile } = await import('@tauri-apps/plugin-fs');
    const info = await invoke<{ path: string; name: string; size: number } | null>('open_ifc_file');
    if (!info) return null;
    const bytes = await readFile(info.path);
    return { name: info.name, size: info.size, bytes };
  }

  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.ifc,.ifczip,.ifcxml';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const bytes = new Uint8Array(await file.arrayBuffer());
      resolve({ name: file.name, size: file.size, bytes });
    };
    input.click();
  });
}

// ── Geometry processing (in-process native in Tauri, WS backend on the web) ──
async function processNatively(
  bytes: Uint8Array,
  onMesh: (mesh: DecodedMesh) => void,
  onProgress: (count: number) => void,
): Promise<void> {
  let count = 0;
  if (isTauri) {
    const { GeometryProcessor } = await import('@ifc-lite/geometry');
    const processor = new GeometryProcessor({ preferNative: true });
    await processor.init();
    for await (const event of processor.processStreaming(bytes)) {
      if (event.type === 'batch') {
        for (const mesh of event.meshes) {
          onMesh(mesh as unknown as DecodedMesh);
          count += 1;
        }
        onProgress(count);
      }
    }
    return;
  }

  await streamFromNativeBackend(NATIVE_BACKEND_URL, bytes, {
    onBatch: (batch) => {
      for (const mesh of batch.meshes) {
        onMesh(mesh);
        count += 1;
      }
      onProgress(count);
    },
  });
}

async function loadFile(file: PickedFile): Promise<void> {
  openBtn.disabled = true;
  clearModel();
  setStatus(`Loading ${file.name} (${(file.size / 1e6).toFixed(1)} MB) natively…`);

  try {
    const started = performance.now();
    await processNatively(
      file.bytes,
      addMesh,
      (count) => setStatus(`Streaming… ${count} meshes`),
    );
    fitCameraToModel();
    const seconds = ((performance.now() - started) / 1000).toFixed(2);
    const mode = isTauri ? 'native, in-process' : 'native, ws backend';
    setStatus(`${file.name} — ${modelGroup.children.length} meshes in ${seconds}s (${mode})`);
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    openBtn.disabled = false;
  }
}

openBtn.addEventListener('click', async () => {
  try {
    const file = await pickFile();
    if (file) await loadFile(file);
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
});

setStatus(isTauri ? 'Native engine ready (in-process).' : `Web mode — backend: ${NATIVE_BACKEND_URL}`);
