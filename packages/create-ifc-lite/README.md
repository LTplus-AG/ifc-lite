# create-ifc-lite

Scaffolds an IFClite project in seconds. One command, working code.

## Usage

```bash
npx create-ifc-lite <project-name> [--template <type>]
```

That's it — no install step. The scaffolder picks `basic` if you don't pass a template.

## Templates

```bash
# Minimal TypeScript project — parse an IFC file from a script
npx create-ifc-lite my-app
cd my-app && npm install && npm run parse ./model.ifc

# WebGPU 3D viewer (React + Vite + drag-and-drop)
npx create-ifc-lite my-viewer --template react
cd my-viewer && npm install && npm run dev

# Three.js (WebGL) viewer
npx create-ifc-lite my-viewer --template threejs

# Babylon.js (WebGL) viewer
npx create-ifc-lite my-viewer --template babylonjs

# Backend server (Rust binary, runs in Docker)
npx create-ifc-lite my-backend --template server

# Backend server (native binary, no Docker)
npx create-ifc-lite my-backend --template server-native
```

| Template | What you get | Stack |
|---|---|---|
| `basic` (default) | Minimal CLI parser | TypeScript + `@ifc-lite/parser` |
| `react` | WebGPU 3D viewer with drag-and-drop, hierarchy, properties | React + Vite + WebGPU |
| `threejs` | Three.js (WebGL) viewer | Three.js + Vite |
| `babylonjs` | Babylon.js (WebGL) viewer | Babylon.js + Vite |
| `server` | IFC parsing server (Docker) | Rust + Docker Compose |
| `server-native` | IFC parsing server (no Docker) | Rust binary via `@ifc-lite/server-bin` |

Each template ships with a `README.md` documenting what it does and how to extend it.

## Options

| Flag | Description |
|------|-------------|
| `--template <type>` | One of `basic`, `react`, `threejs`, `babylonjs`, `server`, `server-native` |
| `--help` | Show help |

## Learn more

- [IFClite docs](https://louistrue.github.io/ifc-lite/)
- [GitHub repo](https://github.com/louistrue/ifc-lite)
- [Quick Start guide](https://github.com/louistrue/ifc-lite/blob/main/docs/guide/quickstart.md)
