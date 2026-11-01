---
"@ifc-lite/parser": minor
"@ifc-lite/cache": patch
"@ifc-lite/viewer": patch
---

The viewer keeps one copy of each model's IFC source instead of up to three, and stores it compressed once the load has finished (#2183).

- **Compressed source after load.** When a model has finished loading (fresh parse, federated add or cache hit), the viewer deflates its source into 64 KiB blocks in a short-lived worker and swaps the model's `IfcDataStore.source` to block storage in place (`compressSourceInPlace`). On a 343 MB model the resident source drops to about 67 MB. Property, attribute, search and export reads work as before through the source accessor. Whole-file operations (IFC export, remesh, clash, overlay parses) now inflate the source first, which adds a few milliseconds per MB to each run.
- **`COMPRESSION_MIN_BYTES` is now 32 MiB (was 150 MiB)**, so `shouldCompressSource` accepts typical federation members, not only very large single models.
- **No second copy for files streamed into a SharedArrayBuffer.** The loader no longer copies a file of 256 MB or more into an ArrayBuffer for the zip check and format detection. Only an `.ifczip`, IFCX or GLB source, which needs an `ArrayBuffer`, is copied. When a smaller file is copied into a SharedArrayBuffer for the parser worker, the original ArrayBuffer is no longer kept for the session.
- **The geometry cache no longer stores the raw source.** On a cache hit, a source stored in IndexedDB (up to 150 MB) used to be read back in addition to the freshly read file. New entries hydrate from the fresh file and are validated by the file's mtime and full-content hash, as entries for 150-400 MB files already were. Entries written by earlier versions still load.
- **Recent files store the `File` itself** in IndexedDB instead of reading up to five files of 150 MB or less into ArrayBuffers on the main thread. Records written by earlier versions still load.

`BinaryCacheWriter.write` now also accepts a `Uint8Array` for `sourceBuffer`, which it reads only when `omitSourceHash` is not set.
