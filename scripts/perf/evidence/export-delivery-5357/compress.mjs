// #5357 observation reproducer; fetch the pinned WASM URL with each encoding first.
// Run in the directory containing identity.wasm, br.wasm and gzip.wasm.
import { readFileSync, writeFileSync } from 'node:fs';
import { brotliCompressSync, brotliDecompressSync, gunzipSync, constants } from 'node:zlib';
import { createHash } from 'node:crypto';
const raw = readFileSync('identity.wasm');
const br = readFileSync('br.wasm');
const gzip = readFileSync('gzip.wasm');
const q11 = brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
if (!raw.equals(brotliDecompressSync(br)) || !raw.equals(gunzipSync(gzip))) {
  throw new Error('The served encodings do not decode to the identical WASM');
}
writeFileSync('q11.br', q11);
console.log(JSON.stringify({ decoded_bytes: raw.length, served_br_bytes: br.length,
  served_gzip_bytes: gzip.length, local_q11_bytes: q11.length,
  br_identity: true, gzip_identity: true,
  sha256: createHash('sha256').update(raw).digest('hex'),
  caveat: 'Local recompression only; no changed deployment or end-to-end cold-load claim.' }, null, 2));
