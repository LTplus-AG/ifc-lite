---
"@ifc-lite/parser": minor
---

Parsing no longer prints to the host console by default. Every `parseColumnar` call emitted ~16 unconditional `console.log` lines (`[parseLite] categorize …`, `[IfcParser] Fast scan …`), so the three-line snippet in the README produced fourteen lines of internal phase timings, and any CLI command writing JSON to stdout got them interleaved into its payload. These are telemetry, and the package already had two channels for them: the structured `onDiagnostic` callback, which is unchanged, and `@ifc-lite/data`'s `createLogger`, whose `debug` level is gated on `IFC_DEBUG` (`IFC_DEBUG=true` in Node, `localStorage.setItem('IFC_DEBUG', 'true')` in a browser). The timings are now routed through the latter, so `IFC_DEBUG=true` still prints exactly what it printed before.
