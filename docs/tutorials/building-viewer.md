# Building a Viewer

Step-by-step tutorial for building a complete IFC viewer.

## Overview

In this tutorial, you'll build a fully functional IFC viewer with:

- File loading
- 3D rendering
- Navigation controls
- Entity selection
- Property display

```mermaid
flowchart LR
    subgraph UI["User Interface"]
        Upload["File Upload"]
        Canvas["3D Canvas"]
        Props["Properties Panel"]
    end

    subgraph Core["Core Components"]
        Parser["IfcParser"]
        Renderer["Renderer"]
        Query["Query"]
    end

    Upload --> Parser
    Parser --> Renderer
    Renderer --> Canvas
    Canvas --> Query
    Query --> Props
```

## Project Setup

### 1. Create Project

```bash
# Create new project
mkdir my-ifc-viewer
cd my-ifc-viewer

# Initialize with Vite + TypeScript
npm create vite@latest . -- --template vanilla-ts

# Install dependencies
npm install @ifc-lite/parser @ifc-lite/geometry @ifc-lite/renderer @ifc-lite/query
```

### 2. Project Structure

```
my-ifc-viewer/
├── src/
│   ├── main.ts           # Entry point
│   ├── viewer.ts         # Viewer class
│   ├── ui.ts             # UI components
│   └── style.css         # Styles
├── index.html
├── vite.config.ts
└── package.json
```

The WASM binary ships inside the `@ifc-lite/wasm` package and is resolved by
the bundler; you do not need to copy it into `public/`.

### 3. Vite Configuration

The COOP/COEP headers enable `SharedArrayBuffer` for the geometry worker
pool, and the ES worker format matches the ES-module workers the packages
ship:

```typescript
// vite.config.ts
import { defineConfig } from 'vite';

export default defineConfig({
  worker: {
    format: 'es',
  },
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
```

### 4. HTML Setup

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>IFC Viewer</title>
  <link rel="stylesheet" href="/src/style.css">
</head>
<body>
  <div id="app">
    <header>
      <input type="file" id="file-input" accept=".ifc">
      <span id="status">Ready</span>
    </header>
    <main>
      <canvas id="viewer"></canvas>
      <aside id="properties"></aside>
    </main>
  </div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

### 5. Base Styles

```css
/* src/style.css */
* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: system-ui, sans-serif;
  background: #1a1a1a;
  color: #fff;
}

#app {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

header {
  padding: 1rem;
  background: #2a2a2a;
  display: flex;
  gap: 1rem;
  align-items: center;
}

main {
  flex: 1;
  display: flex;
  overflow: hidden;
}

#viewer {
  flex: 1;
}

#properties {
  width: 300px;
  background: #2a2a2a;
  padding: 1rem;
  overflow-y: auto;
}
```

## Building the Viewer

### Step 1: Viewer Class

Create the main viewer class:

```typescript
// src/viewer.ts
import { IfcParser, type IfcDataStore, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { Renderer } from '@ifc-lite/renderer';

export class IfcViewer {
  private parser: IfcParser;
  private geometry: GeometryProcessor;
  private renderer: Renderer;
  private dataStore: IfcDataStore | null = null;
  private buffer: Uint8Array | null = null;
  private animationId: number | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.parser = new IfcParser();
    this.geometry = new GeometryProcessor();
    this.renderer = new Renderer(canvas);
  }

  async init(): Promise<void> {
    await this.renderer.init();
    await this.geometry.init();
    this.setupControls();
  }

  async loadFile(file: File): Promise<{ entityCount: number }> {
    const arrayBuffer = await file.arrayBuffer();
    this.buffer = new Uint8Array(arrayBuffer);

    // Parse data model (entities, properties, relationships)
    this.dataStore = await this.parser.parseColumnar(arrayBuffer, {
      onProgress: ({ phase, percent }) => {
        this.onProgress?.(`${phase}: ${percent}%`);
      }
    });

    // Process geometry. process() returns everything at once; for large
    // files, iterate this.geometry.processAdaptive(this.buffer) instead and
    // call this.renderer.addMeshes(event.meshes, true) per 'batch' event for
    // progressive display. When hand-rolling that loop, construct the
    // processor with new GeometryProcessor({ enableInstancing: false }) so
    // repeated elements stay in event.meshes on the parallel path.
    const geometryResult = await this.geometry.process(this.buffer);

    // Load into renderer
    this.renderer.loadGeometry(geometryResult);
    this.renderer.fitToView();
    
    // Start render loop
    this.startRenderLoop();

    return { entityCount: this.dataStore.entityCount };
  }

  private startRenderLoop(): void {
    const animate = () => {
      this.renderer.render();
      this.animationId = requestAnimationFrame(animate);
    };
    animate();
  }

  private setupControls(): void {
    // Click to select
    this.canvas.addEventListener('click', async (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // pick() resolves to a PickResult ({ expressId, ... }) or null
      const hit = await this.renderer.pick(x, y);
      if (hit) {
        this.onSelect?.(hit.expressId);
      } else {
        this.onSelect?.(null);
      }
    });
  }

  // Callbacks
  onProgress?: (message: string) => void;
  onSelect?: (expressId: number | null) => void;

  // Public methods
  getDataStore(): IfcDataStore | null {
    return this.dataStore;
  }

  getRenderer(): Renderer {
    return this.renderer;
  }

  getEntity(expressId: number): any | null {
    if (!this.dataStore) return null;
    const ref = this.dataStore.entityIndex.byId.get(expressId);
    if (!ref) return null;
    // EntityRef only carries {expressId,type,byteOffset,byteLength,lineNumber}.
    // Name and GlobalId come from the store accessors, as QueryResultEntity does.
    return {
      ...ref,
      name: this.dataStore.entities.getName(expressId),
      globalId: this.dataStore.entities.getGlobalId(expressId),
    };
  }

  getProperties(expressId: number) {
    if (!this.dataStore) return null;
    return extractPropertiesOnDemand(this.dataStore, expressId);
  }

  getModelBounds(): { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null {
    // Get bounds from renderer's scene
    const scene = this.renderer.getScene();
    return scene.getBounds();
  }

  dispose(): void {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
    }
  }
}
```

### Step 2: UI Components

```typescript
// src/ui.ts
export function updateStatus(message: string): void {
  const status = document.getElementById('status');
  if (status) status.textContent = message;
}

export function updateProgress(percent: number): void {
  updateStatus(`Loading: ${percent.toFixed(0)}%`);
}

export function renderProperties(
  container: HTMLElement,
  expressId: number,
  entity: any,
  propertySets: Array<{ name: string; properties: Array<{ name: string; value: any }> }>
): void {
  container.innerHTML = '';

  // Entity info
  const header = document.createElement('div');
  header.className = 'prop-section';
  header.innerHTML = `
    <h3>Entity #${expressId}</h3>
    <p><strong>Type:</strong> ${entity.type}</p>
    <p><strong>Name:</strong> ${entity.name || 'N/A'}</p>
    <p><strong>GlobalId:</strong> ${entity.globalId}</p>
  `;
  container.appendChild(header);

  // Property sets
  for (const pset of propertySets) {
    const section = document.createElement('div');
    section.className = 'prop-section';

    const title = document.createElement('h4');
    title.textContent = pset.name;
    section.appendChild(title);

    const table = document.createElement('table');
    for (const prop of pset.properties) {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>${prop.name}</td>
        <td>${formatValue(prop.value)}</td>
      `;
      table.appendChild(row);
    }
    section.appendChild(table);
    container.appendChild(section);
  }
}

function formatValue(value: any): string {
  if (value === null || value === undefined) return 'N/A';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return value.toFixed(2);
  return String(value);
}
```

### Step 3: Main Entry Point

<!-- docs-check: skip -->
```typescript
// src/main.ts
import { IfcViewer } from './viewer';
import { updateStatus, renderProperties } from './ui';
import './style.css';

async function main() {
  // Get elements
  const canvas = document.getElementById('viewer') as HTMLCanvasElement;
  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  const propertiesPanel = document.getElementById('properties') as HTMLElement;

  // Create viewer
  const viewer = new IfcViewer(canvas);

  // Set up callbacks
  viewer.onProgress = updateStatus; // onProgress delivers a "phase: percent%" string
  viewer.onSelect = (expressId) => {
    if (expressId) {
      const entity = viewer.getEntity(expressId);
      const props = viewer.getProperties(expressId);
      if (entity) {
        renderProperties(propertiesPanel, expressId, entity, props || []);
      }
    } else {
      propertiesPanel.innerHTML = '<p>Click an element to view properties</p>';
    }
  };

  // Initialize
  try {
    await viewer.init();
    updateStatus('Ready - Drop an IFC file');
  } catch (error) {
    updateStatus('WebGPU not supported');
    console.error(error);
    return;
  }

  // File input handler
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;

    updateStatus(`Loading ${file.name}...`);

    try {
      const result = await viewer.loadFile(file);
      updateStatus(`Loaded ${result.entityCount} entities`);
    } catch (error) {
      updateStatus('Error loading file');
      console.error(error);
    }
  });
}

main();
```

### Step 4: Additional Styles

```css
/* Add to style.css */
.prop-section {
  margin-bottom: 1rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid #444;
}

.prop-section h3 {
  color: #4f46e5;
  margin-bottom: 0.5rem;
}

.prop-section h4 {
  color: #888;
  font-size: 0.9rem;
  margin-bottom: 0.5rem;
}

.prop-section p {
  margin: 0.25rem 0;
  font-size: 0.9rem;
}

.prop-section table {
  width: 100%;
  font-size: 0.85rem;
}

.prop-section td {
  padding: 0.25rem 0;
}

.prop-section td:first-child {
  color: #888;
  width: 40%;
}

#file-input {
  padding: 0.5rem;
  background: #4f46e5;
  border: none;
  border-radius: 4px;
  color: white;
  cursor: pointer;
}

#status {
  color: #888;
}
```

## Adding Features

### Keyboard Shortcuts

<!-- docs-check: skip -->
```typescript
// Add to viewer.ts
private selectedId: number | null = null;
private hiddenIds = new Set<number>();
private isolatedIds: Set<number> | null = null;
private selectedIds = new Set<number>();

private setupKeyboardShortcuts(): void {
  document.addEventListener('keydown', (e) => {
    switch (e.key) {
      case 'f':
        this.renderer.fitToView();
        break;
      case 'h':
        if (this.selectedId) {
          this.hiddenIds.add(this.selectedId);
          this.render();
        }
        break;
      case 'i':
        if (this.selectedId) {
          this.isolatedIds = new Set([this.selectedId]);
          this.render();
        }
        break;
      case 'Escape':
        this.isolatedIds = null;
        this.selectedIds.clear();
        this.render();
        break;
    }
  });
}

private render(): void {
  this.renderer.render({
    hiddenIds: this.hiddenIds,
    isolatedIds: this.isolatedIds,
    selectedIds: this.selectedIds
  });
}
```

### View Presets

<!-- docs-check: skip -->
```typescript
// Add toolbar buttons
const presets = ['front', 'back', 'left', 'right', 'top'] as const;

presets.forEach(preset => {
  const button = document.createElement('button');
  button.textContent = preset;
  button.onclick = () => {
    const camera = viewer.getRenderer().getCamera();
    camera.setPresetView(preset, viewer.getModelBounds() ?? undefined);
  };
  toolbar.appendChild(button);
});
```

### Query Integration

```typescript
import { IfcQuery } from '@ifc-lite/query';

// After loading, build a query over the parsed data store
const dataStore = viewer.getDataStore();
if (dataStore) {
  const query = new IfcQuery(dataStore);

  // Find all walls
  const walls = query.walls().execute();
  console.log(`Found ${walls.length} walls`);

  // Isolate external walls (show only these)
  const externalWalls = query
    .walls()
    .whereProperty('Pset_WallCommon', 'IsExternal', '=', true)
    .execute();

  const isolatedIds = new Set(externalWalls.map(w => w.expressId));
  viewer.getRenderer().render({ isolatedIds });
}
```

## Running the Viewer

```bash
# Start development server
npm run dev

# Build for production
npm run build
```

## Next Steps

- [Custom Queries](custom-queries.md) - Advanced querying
- [Extending the Parser](extending-parser.md) - Custom processing
- [API Reference](../api/typescript.md) - Full API docs
