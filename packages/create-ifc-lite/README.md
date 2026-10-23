# create-ifc-lite

Scaffolds an IFClite project with runnable code and a resolved dependency lock.

## Usage

```bash
npx create-ifc-lite <project-name> [--template <type>]
```

The scaffolder picks `basic` by default. It pins inspected IFClite releases, skips releases whose required worker files are missing, and checks their transitive IFClite dependencies. It resolves the complete dependency set with npm, checks peer constraints, and writes `package-lock.json` without running dependency install scripts. Run `npm ci` in the generated project to install that exact set; commit the lockfile so teammates and CI use the same versions.

## Templates

```bash
# Minimal TypeScript project — parse an IFC file from a script
npx create-ifc-lite my-app
cd my-app && npm ci && npm run parse ./model.ifc

# WebGPU 3D viewer (React + Vite + drag-and-drop)
npx create-ifc-lite my-viewer --template react
cd my-viewer && npm ci && npm run dev

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

- [IFClite docs](https://ifclite.dev/docs/)
- [GitHub repo](https://github.com/LTplus-AG/ifc-lite)
- [Quick Start guide](https://ifclite.dev/docs/guide/quickstart/)
