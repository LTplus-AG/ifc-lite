---
"@ifc-lite/pointcloud": minor
---

Read COPC (cloud-optimized point cloud) files node by node (#6869). `HttpRangeSource` reads a remote file through HTTP Range requests (refusing servers that ignore `Range`, and working when CORS hides `Content-Range`); `openCopcWorkerReader` parses the LAS 1.4 header, the `copc`/`info` VLR and the hierarchy pages, and decodes individual octree nodes with laz-perf's `ChunkDecoder` in the decode worker through the existing LAS point-record decoder and origin-offset handling. The hierarchy page walk is iterative and bounded against malicious files.
