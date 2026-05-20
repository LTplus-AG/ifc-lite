/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getPackageVersion } from '../utils/config-fixers.js';

/**
 * Scaffold a Three.js IFC viewer project using @ifc-lite/geometry.
 * No WebGPU required — renders via Three.js WebGLRenderer.
 */
export function createThreejsTemplate(targetDir: string, projectName: string) {
  const geometryVersion = getPackageVersion('@ifc-lite/geometry');

  // package.json
  writeFileSync(join(targetDir, 'package.json'), JSON.stringify({
    name: projectName,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: {
      dev: 'vite',
      build: 'tsc && vite build',
      preview: 'vite preview',
      postinstall: 'node ./scripts/fix-ifc-lite-geometry-worker.mjs',
    },
    dependencies: {
      '@ifc-lite/geometry': geometryVersion,
      three: '^0.183.0',
    },
    devDependencies: {
      '@types/three': '^0.183.0',
      typescript: '^5.3.0',
      vite: '^7.0.0',
    },
  }, null, 2));

  // tsconfig.json
  writeFileSync(join(targetDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      outDir: 'dist',
    },
    include: ['src'],
  }, null, 2));

  // vite.config.ts
  writeFileSync(join(targetDir, 'vite.config.ts'), `import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    exclude: ['@ifc-lite/wasm'],
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
`);

  // index.html
  writeFileSync(join(targetDir, 'index.html'), `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${projectName}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; background: #1a1a2e; color: #fff; overflow: hidden; }
    #app { display: flex; flex-direction: column; height: 100vh; }
    header { padding: 0.75rem 1rem; background: #16213e; display: flex; gap: 1rem; align-items: center; }
    header h1 { font-size: 1rem; font-weight: 600; }
    #file-input { padding: 0.4rem 0.8rem; background: #0f3460; border: 1px solid #533483; border-radius: 4px; color: #fff; cursor: pointer; }
    #status { color: #888; font-size: 0.85rem; }
    #canvas-container { flex: 1; position: relative; }
    canvas { display: block; width: 100%; height: 100%; }
  </style>
</head>
<body>
  <div id="app">
    <header>
      <h1>${projectName}</h1>
      <input type="file" id="file-input" accept=".ifc" />
      <span id="status">Drop an IFC file to view</span>
    </header>
    <div id="canvas-container">
      <canvas id="viewer"></canvas>
    </div>
  </div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
`);

  // src/
  mkdirSync(join(targetDir, 'src'));
  mkdirSync(join(targetDir, 'scripts'));

  // scripts/fix-ifc-lite-geometry-worker.mjs
  writeFileSync(join(targetDir, 'scripts', 'fix-ifc-lite-geometry-worker.mjs'), `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const entryPath = path.join(process.cwd(), 'node_modules', '@ifc-lite', 'geometry', 'dist', 'index.js');

if (!existsSync(entryPath)) {
  process.exit(0);
}

const source = readFileSync(entryPath, 'utf8');
const patched = source.replace(/geometry\\.worker\\.ts/g, 'geometry.worker.js');

if (patched !== source) {
  writeFileSync(entryPath, patched);
}
`);

  // src/ifc-to-threejs.ts
  writeFileSync(join(targetDir, 'src', 'ifc-to-threejs.ts'), `import * as THREE from 'three';
import type { MeshData } from '@ifc-lite/geometry';

/**
 * Convert a single MeshData into a Three.js Mesh.
 */
export function meshDataToThree(mesh: MeshData): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));

  const [r, g, b, a] = mesh.color;
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(r, g, b),
    transparent: a < 1,
    opacity: a,
    side: a < 1 ? THREE.DoubleSide : THREE.FrontSide,
    depthWrite: a >= 1,
  });

  const threeMesh = new THREE.Mesh(geometry, material);
  threeMesh.userData.expressId = mesh.expressId;
  return threeMesh;
}
`);

  // src/main.ts
  writeFileSync(join(targetDir, 'src', 'main.ts'), `import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { meshDataToThree } from './ifc-to-threejs.js';

const canvas = document.getElementById('viewer') as HTMLCanvasElement;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const status = document.getElementById('status')!;
if (!canvas || !fileInput || !status) {
  throw new Error('Required DOM elements not found: viewer, file-input, or status');
}

// Three.js setup
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a2e);

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 10000);
camera.position.set(20, 15, 20);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = false;

// Lighting
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(50, 80, 50);
scene.add(dirLight);

// IFC-Lite geometry processor
const geometry = new GeometryProcessor();

// Resize
function resize() {
  const container = canvas.parentElement ?? document.body;
  renderer.setSize(container.clientWidth, container.clientHeight);
  camera.aspect = container.clientWidth / container.clientHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// Render loop
(function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
})();

// File loading
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;

  status.textContent = 'Loading ' + file.name + '...';

  try {
    await geometry.init();
    const buffer = new Uint8Array(await file.arrayBuffer());

    // Clear previous model and release GPU resources
    const toRemove = scene.children.filter(
      (c) => c instanceof THREE.Mesh || c instanceof THREE.Group
    );
    for (const obj of toRemove) {
      scene.remove(obj);
      obj.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          if (Array.isArray(child.material)) {
            child.material.forEach((m) => m.dispose());
          } else {
            child.material.dispose();
          }
        }
      });
    }

    // Stream geometry
    let count = 0;
    for await (const event of geometry.processStreaming(buffer)) {
      if (event.type === 'batch') {
        for (const mesh of event.meshes) {
          scene.add(meshDataToThree(mesh));
        }
        count += event.meshes.length;
        status.textContent = 'Loaded ' + count + ' meshes...';
      }
      if (event.type === 'complete') {
        // Fit camera
        const box = new THREE.Box3().setFromObject(scene);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const d = Math.max(size.x, size.y, size.z) * 1.5;
        camera.position.set(center.x + d * 0.5, center.y + d * 0.5, center.z + d * 0.5);
        controls.target.copy(center);
        controls.update();
        camera.near = Math.max(size.x, size.y, size.z) * 0.001;
        camera.far = Math.max(size.x, size.y, size.z) * 100;
        camera.updateProjectionMatrix();

        status.textContent = file.name + ' — ' + event.totalMeshes + ' meshes';
      }
    }
  } catch (err: any) {
    status.textContent = 'Error: ' + err.message;
    console.error(err);
  }
});
`);

  // README
  writeFileSync(join(targetDir, 'README.md'), `# ${projectName}

Three.js IFC viewer using [IFC-Lite](https://github.com/LTplus-AG/ifc-lite).

## Quick Start

\`\`\`bash
npm install
npm run dev
\`\`\`

Open http://localhost:5173 and drop an IFC file.

## Learn More

- [Three.js Integration Guide](https://ltplus-ag.github.io/ifc-lite/tutorials/threejs-integration/)
- [IFC-Lite Documentation](https://ltplus-ag.github.io/ifc-lite/)
`);
}
