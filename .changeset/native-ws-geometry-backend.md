---
"@ifc-lite/geometry": minor
"@ifc-lite/viewer": minor
---

Add a native WebSocket geometry backend (the "local helper" path): the viewer
can offload IFC parsing/meshing to a localhost `ifc-lite-desktop-server` over a
WebSocket for native-speed geometry (real threads, native SIMD, no wasm32 4 GB
cap), with automatic fallback to the in-browser WASM pipeline when the helper is
absent. `@ifc-lite/geometry` gains a `nativeBackendUrl` option on
`GeometryProcessor` and an exported `WebSocketBridge`; the viewer wires it via
`VITE_NATIVE_BACKEND_URL`.
