---
"@ifc-lite/viewer": patch
---

Diagnose why WebGPU is unavailable instead of blaming the device for every case: distinguish an insecure origin (plain HTTP on a hostname/IP, where `navigator.gpu` is undefined regardless of hardware) from a browser that never exposes the API (embedded webview, enterprise policy, old version) from a genuine adapter/driver failure, and show only the troubleshooting steps that apply to each. Point the WebGPU-unavailable banner and the disabled empty-state card at the CLI and MCP server, which run on the CPU with no browser or GPU required.
