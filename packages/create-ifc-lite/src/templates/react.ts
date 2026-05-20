/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getPackageVersion } from '../utils/config-fixers.js';

const LICENSE_HEADER = `/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

`;

function writeSourceFile(targetDir: string, relativePath: string, content: string) {
  writeFileSync(join(targetDir, relativePath), `${LICENSE_HEADER}${content}`);
}

/**
 * Scaffold a standalone React + Vite WebGPU viewer.
 */
export function createReactTemplate(targetDir: string, projectName: string) {
  const geometryVersion = getPackageVersion('@ifc-lite/geometry');
  const rendererVersion = getPackageVersion('@ifc-lite/renderer');

  writeFileSync(join(targetDir, 'package.json'), JSON.stringify({
    name: projectName,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: {
      dev: 'vite',
      build: 'tsc && vite build',
      typecheck: 'tsc --noEmit',
      preview: 'vite preview',
    },
    dependencies: {
      '@ifc-lite/geometry': geometryVersion,
      '@ifc-lite/renderer': rendererVersion,
      react: '^18.2.0',
      'react-dom': '^18.2.0',
    },
    devDependencies: {
      '@types/react': '^18.2.0',
      '@types/react-dom': '^18.2.0',
      '@vitejs/plugin-react': '^4.2.0',
      typescript: '^5.3.0',
      vite: '^5.0.0',
    },
  }, null, 2));

  writeFileSync(join(targetDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      useDefineForClassFields: true,
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      module: 'ESNext',
      skipLibCheck: true,
      moduleResolution: 'bundler',
      allowImportingTsExtensions: false,
      resolveJsonModule: true,
      isolatedModules: true,
      noEmit: true,
      jsx: 'react-jsx',
      strict: true,
      esModuleInterop: true,
    },
    include: ['src'],
  }, null, 2));

  writeSourceFile(targetDir, 'vite.config.ts', `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ['@ifc-lite/wasm'],
  },
  server: {
    headers: isolationHeaders,
  },
  preview: {
    headers: isolationHeaders,
  },
});
`);

  writeFileSync(join(targetDir, 'index.html'), `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${projectName}</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>
`);

  mkdirSync(join(targetDir, 'src'));

  writeSourceFile(targetDir, 'src/main.tsx', `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.js';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
`);

  writeSourceFile(targetDir, 'src/App.tsx', `import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { Renderer } from '@ifc-lite/renderer';

type ViewerSession = {
  renderer: Renderer;
  destroy: () => void;
};

function setupCameraControls(canvas: HTMLCanvasElement, renderer: Renderer): () => void {
  const camera = renderer.getCamera();
  let isDragging = false;
  let isPanning = false;
  let lastX = 0;
  let lastY = 0;

  const onMouseDown = (event: MouseEvent) => {
    isDragging = true;
    isPanning = event.button === 1 || event.button === 2 || event.shiftKey;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.style.cursor = isPanning ? 'move' : 'grabbing';
  };

  const onMouseMove = (event: MouseEvent) => {
    if (!isDragging) return;
    const deltaX = event.clientX - lastX;
    const deltaY = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;

    if (isPanning) {
      camera.pan(deltaX, deltaY);
    } else {
      camera.orbit(deltaX, deltaY);
    }
  };

  const stopDrag = () => {
    isDragging = false;
    isPanning = false;
    canvas.style.cursor = 'grab';
  };

  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    camera.zoom(event.deltaY);
  };

  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
  };

  canvas.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', stopDrag);
  canvas.addEventListener('mouseleave', stopDrag);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContextMenu);
  canvas.style.cursor = 'grab';

  return () => {
    canvas.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', stopDrag);
    canvas.removeEventListener('mouseleave', stopDrag);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('contextmenu', onContextMenu);
  };
}

async function createViewer(canvas: HTMLCanvasElement): Promise<ViewerSession> {
  const renderer = new Renderer(canvas);
  await renderer.init();

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    renderer.resize(width, height);
  };

  resize();
  window.addEventListener('resize', resize);
  const cleanupControls = setupCameraControls(canvas, renderer);

  let destroyed = false;
  let frameId = 0;
  const loop = () => {
    if (destroyed) return;
    renderer.render();
    frameId = requestAnimationFrame(loop);
  };
  loop();

  return {
    renderer,
    destroy: () => {
      destroyed = true;
      cancelAnimationFrame(frameId);
      cleanupControls();
      window.removeEventListener('resize', resize);
      renderer.destroy();
    },
  };
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const processorRef = useRef<GeometryProcessor | null>(null);
  const viewerRef = useRef<ViewerSession | null>(null);
  const loadIdRef = useRef(0);
  const [status, setStatus] = useState('Initializing WebGPU viewer...');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const initId = ++loadIdRef.current;

    const init = async () => {
      if (!canvasRef.current) return;
      if (!('gpu' in navigator)) {
        setStatus('WebGPU is not available in this browser. Try a recent Chromium-based browser.');
        setBusy(false);
        return;
      }

      try {
        const processor = new GeometryProcessor();
        await processor.init();
        if (cancelled || initId !== loadIdRef.current) return;

        processorRef.current = processor;
        const viewer = await createViewer(canvasRef.current);
        if (cancelled || initId !== loadIdRef.current) {
          viewer.destroy();
          return;
        }

        viewerRef.current = viewer;
        setReady(true);
        setBusy(false);
        setStatus('Drop an IFC file or choose one to start rendering.');
      } catch (error) {
        console.error(error);
        setBusy(false);
        setStatus(error instanceof Error ? error.message : 'Failed to initialize viewer.');
      }
    };

    void init();

    return () => {
      cancelled = true;
      loadIdRef.current += 1;
      viewerRef.current?.destroy();
      viewerRef.current = null;
    };
  }, []);

  const loadFile = useCallback(async (file: File) => {
    if (!canvasRef.current || !processorRef.current || !ready || busy) return;
    const loadId = ++loadIdRef.current;

    setBusy(true);
    setStatus('Preparing renderer...');

    try {
      const previousViewer = viewerRef.current;
      const viewer = await createViewer(canvasRef.current);
      if (loadId !== loadIdRef.current) {
        viewer.destroy();
        return;
      }

      previousViewer?.destroy();
      viewerRef.current = viewer;
      const renderer = viewer.renderer;
      const processor = processorRef.current;
      if (!processor) {
        throw new Error('Geometry processor is no longer available.');
      }

      const bytes = new Uint8Array(await file.arrayBuffer());

      let loadedMeshes = 0;
      setStatus('Streaming geometry...');

      for await (const event of processor.processStreaming(bytes)) {
        if (loadId !== loadIdRef.current) return;

        if (event.type === 'batch') {
          renderer.addMeshes(event.meshes, true);
          loadedMeshes = event.totalSoFar;
          setStatus('Loaded ' + loadedMeshes + ' meshes...');
        }

        if (event.type === 'complete') {
          renderer.fitToView();
          setStatus(file.name + ' loaded with ' + event.totalMeshes + ' meshes.');
        }
      }
    } catch (error) {
      console.error(error);
      if (loadId === loadIdRef.current) {
        setStatus(error instanceof Error ? error.message : 'Failed to load IFC file.');
      }
    } finally {
      if (loadId === loadIdRef.current) {
        setBusy(false);
      }
    }
  }, [busy, ready]);

  const onFileChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    await loadFile(file);
    event.target.value = '';
  }, [loadFile]);

  const onDrop = useCallback(async (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    if (!ready || busy) return;
    const file = event.dataTransfer.files?.[0];
    if (file) {
      await loadFile(file);
    }
  }, [busy, loadFile, ready]);

  const openFilePicker = useCallback(() => {
    if (!ready || busy) return;
    fileInputRef.current?.click();
  }, [busy, ready]);

  return (
    <div className="app">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">IFC-Lite</p>
          <h1>${projectName}</h1>
          <p className="muted">
            Standalone React + Vite viewer powered by IFC-Lite geometry streaming and WebGPU rendering.
          </p>
        </div>

        <input
          ref={fileInputRef}
          className="visuallyHiddenInput"
          type="file"
          accept=".ifc"
          disabled={!ready || busy}
          aria-label="Choose IFC file"
          onChange={(event) => void onFileChange(event)}
        />
        <button
          type="button"
          className="uploadButton"
          disabled={!ready || busy}
          aria-disabled={!ready || busy}
          onClick={openFilePicker}
        >
          {busy ? 'Working…' : 'Choose IFC File'}
        </button>

        <div className="panel">
          <p className="label">Status</p>
          <p>{status}</p>
        </div>

        <div className="panel">
          <p className="label">Controls</p>
          <ul>
            <li>Left drag: orbit</li>
            <li>Shift / middle / right drag: pan</li>
            <li>Wheel: zoom</li>
            <li>Drop an IFC anywhere on the viewport</li>
          </ul>
        </div>
      </aside>

      <main className="viewportShell" onDragOver={(event) => event.preventDefault()} onDrop={(event) => void onDrop(event)}>
        <canvas ref={canvasRef} className="viewport" />
      </main>
    </div>
  );
}
`);

  writeSourceFile(targetDir, 'src/styles.css', `:root {
  color-scheme: dark;
  font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: #0b1220;
  color: #e5eefc;
}

* {
  box-sizing: border-box;
}

html,
body,
#root {
  margin: 0;
  min-height: 100%;
  height: 100%;
}

body {
  background:
    radial-gradient(circle at top, rgba(59, 130, 246, 0.18), transparent 30%),
    #0b1220;
}

.app {
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  min-height: 100vh;
}

.sidebar {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.5rem;
  border-right: 1px solid rgba(148, 163, 184, 0.18);
  background: rgba(15, 23, 42, 0.92);
  backdrop-filter: blur(16px);
}

.eyebrow,
.label {
  margin: 0 0 0.5rem;
  color: #93c5fd;
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.sidebar h1 {
  margin: 0 0 0.75rem;
  font-size: 1.8rem;
}

.muted {
  margin: 0;
  color: #94a3b8;
  line-height: 1.5;
}

.uploadButton {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 3rem;
  padding: 0.9rem 1rem;
  border-radius: 0.9rem;
  background: linear-gradient(135deg, #2563eb, #0ea5e9);
  color: white;
  font-weight: 700;
  cursor: pointer;
  transition: transform 0.15s ease, opacity 0.15s ease;
  border: none;
}

.uploadButton:hover:not(:disabled) {
  transform: translateY(-1px);
}

.uploadButton:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.visuallyHiddenInput {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.panel {
  padding: 1rem;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 1rem;
  background: rgba(15, 23, 42, 0.7);
}

.panel p {
  margin: 0;
  line-height: 1.5;
}

.panel ul {
  margin: 0;
  padding-left: 1.1rem;
  color: #cbd5e1;
  line-height: 1.6;
}

.viewportShell {
  position: relative;
  min-width: 0;
  min-height: 100vh;
  padding: 1rem;
}

.viewport {
  display: block;
  width: 100%;
  height: calc(100vh - 2rem);
  border-radius: 1rem;
  border: 1px solid rgba(148, 163, 184, 0.16);
  background: linear-gradient(180deg, #020617, #0f172a);
  outline: none;
}

@media (max-width: 960px) {
  .app {
    grid-template-columns: 1fr;
  }

  .sidebar {
    border-right: none;
    border-bottom: 1px solid rgba(148, 163, 184, 0.18);
  }

  .viewportShell {
    min-height: 60vh;
  }

  .viewport {
    height: 60vh;
  }
}
`);

  writeFileSync(join(targetDir, 'README.md'), `# ${projectName}

React + Vite IFC viewer using [IFC-Lite](https://github.com/LTplus-AG/ifc-lite).

## Quick Start

\`\`\`bash
npm install
npm run dev
\`\`\`

Open the app in your browser and drop an IFC file onto the viewport.

## Features

- React + Vite developer experience
- IFC-Lite geometry streaming for progressive loading
- WebGPU rendering via \`@ifc-lite/renderer\`
- Drag-and-drop or file picker loading
- Orbit, pan, and zoom camera controls

## Learn More

- [IFC-Lite Documentation](https://ltplus-ag.github.io/ifc-lite/)
- [Rendering Guide](https://ltplus-ag.github.io/ifc-lite/guide/rendering/)
- [Geometry Guide](https://ltplus-ag.github.io/ifc-lite/guide/geometry/)
`);
}
