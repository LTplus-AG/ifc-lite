# Load error card browser witness (#5851)

Headless Chrome at 1440 × 900 opened the real authored `building-architecture.ifc` sample through `?model=/samples/building-architecture.ifc`. An init script made `navigator.gpu.requestAdapter()` return `null` to reproduce a browser without a usable GPU adapter. The [screenshot](webgpu-retry.png) shows the full model-load explanation, Retry and Dismiss in the shared alert card, and the browser support link above it.

The mounted page made one adapter request on open. Clicking Retry made exactly one more request and kept the source error visible. The browser made zero `.ifc` requests while the adapter was unavailable; the sample path was checked with a path-only request filter so the document URL's query string was not counted as a fetch. The mounted tests separately cover recovery and opening that original source.
