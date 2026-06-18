/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC-Lite Desktop reference frontend.
 *
 * The whole point of this file: it is an ordinary web app, yet geometry is
 * processed by NATIVE Rust. `GeometryProcessor({ preferNative: true })` detects
 * the Tauri host (`isTauri()`) and routes every parse through the `NativeBridge`
 * → the `get_geometry_streaming` Rust command (this repo's
 * `apps/desktop/src-tauri`) → `ifc-lite-desktop-engine`. No WASM is loaded; the
 * meshes arrive already in WebGL Y-up, so they drop straight into three.js.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { invoke } from '@tauri-apps/api/core';
import { readFile } from '@tauri-apps/plugin-fs';

interface FileInfo {
  path: string;
  name: string;
  size: number;
}

const statusEl = document.getElementById('status') as HTMLSpanElement;
const openBtn = document.getElementById('open') as HTMLButtonElement;
const canvas = document.getElementById('viewport') as HTMLCanvasElement;

function setStatus(text: string): void {
  statusEl.textContent = text;
}

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

// ── Native geometry engine ──
const processor = new GeometryProcessor({ preferNative: true });
let ready: Promise<void> | null = null;

function ensureReady(): Promise<void> {
  if (!ready) ready = processor.init();
  return ready;
}

function addMesh(mesh: {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  color: [number, number, number, number];
}): void {
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

async function loadFile(info: FileInfo): Promise<void> {
  openBtn.disabled = true;
  clearModel();
  setStatus(`Loading ${info.name} (${(info.size / 1e6).toFixed(1)} MB) natively…`);

  try {
    await ensureReady();
    const bytes = await readFile(info.path);

    let meshCount = 0;
    const started = performance.now();
    for await (const event of processor.processStreaming(bytes)) {
      if (event.type === 'batch') {
        for (const mesh of event.meshes) {
          addMesh(mesh);
          meshCount += 1;
        }
        setStatus(`Streaming… ${meshCount} meshes`);
      }
    }

    fitCameraToModel();
    const seconds = ((performance.now() - started) / 1000).toFixed(2);
    setStatus(`${info.name} — ${meshCount} meshes in ${seconds}s (native)`);
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    openBtn.disabled = false;
  }
}

openBtn.addEventListener('click', async () => {
  try {
    const info = await invoke<FileInfo | null>('open_ifc_file');
    if (info) await loadFile(info);
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
});
