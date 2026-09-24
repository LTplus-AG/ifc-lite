/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getPackageVersion } from '../utils/config-fixers.js';
import { writeGitignore } from '../utils/gitignore.js';

/**
 * Scaffold a Babylon.js IFC viewer project using @ifc-lite/geometry.
 * No WebGPU required — renders via Babylon.js WebGL Engine.
 */
export function createBabylonjsTemplate(targetDir: string, projectName: string) {
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
      typecheck: 'tsc --noEmit',
    },
    dependencies: {
      '@ifc-lite/geometry': geometryVersion,
      '@babylonjs/core': '^7.0.0',
    },
    devDependencies: {
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
      noEmit: true,
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
    canvas { display: block; width: 100%; height: 100%; outline: none; }
  </style>
</head>
<body>
  <div id="app">
    <header>
      <h1>${projectName}</h1>
      <input type="file" id="file-input" accept=".ifc" />
      <span id="status">Choose an IFC file to view</span>
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

  // src/ifc-to-babylon.ts
  writeFileSync(join(targetDir, 'src', 'ifc-to-babylon.ts'), `import {
  Mesh, VertexData, StandardMaterial, Color3,
} from '@babylonjs/core';
import type { Scene } from '@babylonjs/core';
import type { MeshData } from '@ifc-lite/geometry';

/**
 * Convert a single MeshData into a Babylon.js Mesh.
 */
export function meshDataToBabylon(meshData: MeshData, scene: Scene): Mesh {
  const mesh = new Mesh('entity-' + meshData.expressId, scene);

  const vertexData = new VertexData();
  vertexData.positions = meshData.positions;
  vertexData.normals = meshData.normals;
  vertexData.indices = meshData.indices;
  vertexData.applyToMesh(mesh);

  // Fold the per-element local frame: \`positions\` are relative to \`origin\`,
  // so the world position of vertex i is origin + positions[3i..3i+3]. Most
  // elements carry one (it is what keeps building-scale coordinates inside f32
  // precision); dropping it scatters every element to its local offset.
  if (meshData.origin) {
    mesh.position.set(meshData.origin[0], meshData.origin[1], meshData.origin[2]);
  }

  const [r, g, b, a] = meshData.color;
  const material = new StandardMaterial('mat-' + meshData.expressId, scene);
  material.diffuseColor = new Color3(r, g, b);
  material.specularColor = new Color3(0.15, 0.15, 0.15);
  // Double-sided even when opaque: IFC triangle winding isn't reliably outward,
  // so culling back faces punches holes in walls and slabs.
  material.backFaceCulling = false;
  if (a < 1) {
    material.alpha = a;
  }

  mesh.material = material;
  mesh.metadata = { expressId: meshData.expressId };
  return mesh;
}
`);

  // src/main.ts
  writeFileSync(join(targetDir, 'src', 'main.ts'), `import {
  Engine, Scene, ArcRotateCamera, HemisphericLight, DirectionalLight,
  Vector3, Color3, Color4,
} from '@babylonjs/core';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { meshDataToBabylon } from './ifc-to-babylon.js';

const canvas = document.getElementById('viewer') as HTMLCanvasElement;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const status = document.getElementById('status')!;
if (!canvas || !fileInput || !status) {
  throw new Error('Required DOM elements not found: viewer, file-input, or status');
}

// Babylon.js setup
const engine = new Engine(canvas, true);
const scene = new Scene(engine);
scene.clearColor = new Color4(0.1, 0.1, 0.18, 1);

const camera = new ArcRotateCamera('camera', -Math.PI / 4, Math.PI / 3, 50, Vector3.Zero(), scene);
camera.attachControl(canvas, true);
camera.minZ = 0.1;
camera.maxZ = 10000;

// Lighting
const hemiLight = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
hemiLight.intensity = 0.6;
const dirLight = new DirectionalLight('dir', new Vector3(-1, -2, -1).normalize(), scene);
dirLight.intensity = 0.8;
dirLight.position = new Vector3(50, 80, 50);

// IFC-Lite geometry processor
const geometry = new GeometryProcessor();

// Resize
window.addEventListener('resize', () => engine.resize());

// Render loop
engine.runRenderLoop(() => scene.render());

// File loading
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;

  status.textContent = 'Loading ' + file.name + '...';

  try {
    await geometry.init();
    const buffer = new Uint8Array(await file.arrayBuffer());

    // Clear previous model
    const toDispose = scene.meshes.slice();
    for (const mesh of toDispose) {
      if (mesh.material) mesh.material.dispose();
      mesh.dispose();
    }

    // Stream geometry
    let count = 0;
    for await (const event of geometry.processStreaming(buffer)) {
      if (event.type === 'batch') {
        for (const mesh of event.meshes) {
          meshDataToBabylon(mesh, scene);
        }
        count += event.meshes.length;
        status.textContent = 'Loaded ' + count + ' meshes...';
      }
      if (event.type === 'complete') {
        // Fit camera
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (const mesh of scene.meshes) {
          mesh.computeWorldMatrix(true);
          const bounds = mesh.getBoundingInfo().boundingBox;
          const bMin = bounds.minimumWorld;
          const bMax = bounds.maximumWorld;
          if (bMin.x < minX) minX = bMin.x;
          if (bMin.y < minY) minY = bMin.y;
          if (bMin.z < minZ) minZ = bMin.z;
          if (bMax.x > maxX) maxX = bMax.x;
          if (bMax.y > maxY) maxY = bMax.y;
          if (bMax.z > maxZ) maxZ = bMax.z;
        }
        const center = new Vector3((minX+maxX)/2, (minY+maxY)/2, (minZ+maxZ)/2);
        const maxDim = Math.max(maxX-minX, maxY-minY, maxZ-minZ);
        camera.target = center;
        camera.radius = maxDim * 1.5;
        camera.minZ = maxDim * 0.001;
        camera.maxZ = maxDim * 100;

        status.textContent = file.name + ' — ' + event.totalMeshes + ' meshes';
      }
    }
  } catch (err) {
    status.textContent = 'Error: ' + (err instanceof Error ? err.message : String(err));
    console.error(err);
  }
});
`);

  writeGitignore(targetDir);

  // README
  writeFileSync(join(targetDir, 'README.md'), `# ${projectName}

Babylon.js IFC viewer using [IFC-Lite](https://github.com/LTplus-AG/ifc-lite).

## Quick Start

\`\`\`bash
npm install
npm run dev
\`\`\`

Open the URL Vite prints (http://localhost:5173 by default) and pick an IFC file.

No IFC file handy? [AC20-FZK-Haus.ifc](https://github.com/LTplus-AG/ifc-lite/releases/download/fixtures-v1/ea6f04eaf92fac4d7ad0038bc3d2dfea4c094dd3f516ecc33c50bf1835ca108d) is a small public test model.

## Learn More

- [IFClite Documentation](https://ifclite.dev/docs/)
- [Babylon.js Integration Guide](https://ifclite.dev/docs/tutorials/babylonjs-integration/)
`);
}
