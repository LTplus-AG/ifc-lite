# Browser Requirements

IFClite uses modern web technologies that require recent browser versions.

## WebGPU Support

The renderer requires **WebGPU**, a next-generation graphics API.

### Supported Browsers

| Browser | Minimum Version | Status |
|---------|----------------|--------|
| Chrome | 113+ | :material-check-circle:{ .success } Stable |
| Edge | 113+ | :material-check-circle:{ .success } Stable |
| Firefox | 127+ | :material-check-circle:{ .success } Stable |
| Safari | 18+ | :material-check-circle:{ .success } Stable |

### Checking WebGPU Support

```typescript
async function checkWebGPU(): Promise<boolean> {
  if (!navigator.gpu) {
    console.error('WebGPU not supported');
    return false;
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    console.error('No WebGPU adapter found');
    return false;
  }

  const device = await adapter.requestDevice();
  console.log('WebGPU device:', device);
  return true;
}
```

## WebGPU Detection Flow

```mermaid
flowchart TD
    Start([Start]) --> CheckAPI{navigator.gpu<br/>exists?}
    CheckAPI -->|No| Fallback[Use WebGL fallback<br/>or show error]
    CheckAPI -->|Yes| RequestAdapter[Request Adapter]
    RequestAdapter --> AdapterFound{Adapter<br/>found?}
    AdapterFound -->|No| Fallback
    AdapterFound -->|Yes| RequestDevice[Request Device]
    RequestDevice --> DeviceReady{Device<br/>ready?}
    DeviceReady -->|No| Fallback
    DeviceReady -->|Yes| Ready([WebGPU Ready])

    style Ready fill:#16a34a,stroke:#14532d,color:#fff
    style Fallback fill:#dc2626,stroke:#7f1d1d,color:#fff
```

## WebAssembly Support

The parser uses WASM for high-performance parsing.

### Required Features

| Feature | Purpose | Support |
|---------|---------|---------|
| WebAssembly | Core WASM runtime | All modern browsers |
| WASM SIMD | Vectorized operations | Chrome 91+, Firefox 89+, Safari 16.4+ |
| Streaming Compilation | Fast module loading | All modern browsers |

### Checking WASM Support

```typescript
function checkWASM(): boolean {
  // Basic WASM support
  if (typeof WebAssembly === 'undefined') {
    return false;
  }

  // Check for streaming compilation
  if (!WebAssembly.instantiateStreaming) {
    console.warn('WASM streaming not supported, using fallback');
  }

  return true;
}
```

## JavaScript Requirements

IFClite requires ES2022+ features:

- `async`/`await`
- `for await...of`
- Private class fields
- `Object.hasOwn()`
- Top-level await (in modules)

## SharedArrayBuffer (Optional)

For multi-threaded parsing with Web Workers:

```typescript
// Check if SharedArrayBuffer is available
if (typeof SharedArrayBuffer === 'undefined') {
  console.warn('SharedArrayBuffer not available, using single-threaded mode');
}
```

!!! note "Cross-Origin Isolation"
    SharedArrayBuffer requires cross-origin isolation headers:
    ```
    Cross-Origin-Opener-Policy: same-origin
    Cross-Origin-Embedder-Policy: require-corp
    ```

## Feature Detection Example

```typescript
import { IfcParser, Renderer } from '@ifc-lite/parser';

interface BrowserCapabilities {
  webgpu: boolean;
  wasm: boolean;
  simd: boolean;
  sharedArrayBuffer: boolean;
}

async function detectCapabilities(): Promise<BrowserCapabilities> {
  // WebGPU
  let webgpu = false;
  if (navigator.gpu) {
    const adapter = await navigator.gpu.requestAdapter();
    webgpu = adapter !== null;
  }

  // WASM
  const wasm = typeof WebAssembly !== 'undefined';

  // SIMD (feature detection via compilation)
  let simd = false;
  try {
    // Try to compile a module with SIMD instructions
    const module = new WebAssembly.Module(
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])
    );
    simd = true;
  } catch {
    simd = false;
  }

  // SharedArrayBuffer
  const sharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined';

  return { webgpu, wasm, simd, sharedArrayBuffer };
}

// Usage
const caps = await detectCapabilities();
if (!caps.webgpu) {
  showFallbackUI();
} else {
  initializeViewer();
}
```

## Fallback Strategies

```mermaid
flowchart LR
    subgraph Primary["Primary Path"]
        WebGPU["WebGPU Renderer"]
        WASM["WASM Parser"]
    end

    subgraph Fallback["Fallback Path"]
        WebGL["WebGL2 Renderer"]
        JS["JavaScript Parser"]
    end

    Check{Browser<br/>Support?}
    Check -->|Full| Primary
    Check -->|Partial| Fallback
    Check -->|None| Error[Show Error]

    style Primary fill:#16a34a,stroke:#14532d,color:#fff
    style Fallback fill:#f59e0b,stroke:#7c2d12,color:#fff
    style Error fill:#dc2626,stroke:#7f1d1d,color:#fff
```

### WebGL Fallback

```typescript
import { Renderer, WebGLFallbackRenderer } from '@ifc-lite/renderer';

async function createRenderer(canvas: HTMLCanvasElement) {
  if (navigator.gpu) {
    const adapter = await navigator.gpu.requestAdapter();
    if (adapter) {
      return new Renderer(canvas); // WebGPU
    }
  }

  // Fallback to WebGL2
  console.warn('WebGPU not available, using WebGL2 fallback');
  return new WebGLFallbackRenderer(canvas);
}
```

## Mobile Support

| Platform | Browser | Status |
|----------|---------|--------|
| iOS | Safari 18+ | :material-check-circle:{ .success } |
| Android | Chrome 113+ | :material-check-circle:{ .success } |
| Android | Firefox 127+ | :material-check-circle:{ .success } |

!!! tip "Mobile Performance"
    For mobile devices, keep parsing columnar and stream geometry in batches:
    ```typescript
    const store = await parser.parseColumnar(buffer);
    for await (const event of geometry.processAdaptive(new Uint8Array(buffer))) {
      if (event.type === 'batch') renderer.addMeshes(event.meshes);
    }
    ```

## Next Steps

- [Installation](installation.md) - Install IFClite
- [Quick Start](quickstart.md) - Get started quickly
