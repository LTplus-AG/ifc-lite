---
"@ifc-lite/cache": patch
---

Validate the v13 geometry section's chunk directory before decoding instead of trusting each entry's declared byte range.

`openGeometryChunksV13`'s `readChunk` sliced a chunk's stored bytes out of the section buffer with `bytes.subarray(start, start + info.byteLength)`. `subarray` doesn't throw when a range runs past the buffer — it saturates — so a corrupt directory entry (disk corruption, a hand-crafted cache) could hand `decodeGeometryChunk` fewer bytes than declared. Worse, `decodeGeometryChunk`'s own `raw.byteLength !== info.uncompressedLength` check could be neutralised: a directory entry whose `byteLength`, `uncompressedLength`, and `meshCount` are corrupted consistently (matching the actual truncated/absorbed byte range) passes that check while silently decoding a NEIGHBOURING chunk's real, validly-encoded mesh records as if they belonged to this chunk — duplicating that geometry under two chunks with no error.

Two guards close this: `readChunk` now rejects a chunk range that exceeds the buffer before slicing, and `openGeometryChunksV13` now validates that consecutive chunks' declared ranges are contiguous (matching how the writer always lays them out) before any chunk is read. A well-formed cache is unaffected — chunk ranges are always contiguous and within bounds by construction.

This does not close every variant: a corrupted LAST chunk whose range reaches past its true end into whatever bytes happen to follow (trailing padding, or the next section in a multi-section cache file) isn't caught by the contiguity check, since there is no next chunk to cross-validate against. That residual case still relies on the buffer-bounds check plus `decodeGeometryChunk`'s existing length check.
