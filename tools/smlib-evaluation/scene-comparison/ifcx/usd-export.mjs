// SPDX-License-Identifier: MPL-2.0
// Exercise the actual public WASM STEP->USD consumer; IFCX JSON is not STEP.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const [entry, binary, root, output] = process.argv.slice(2);
if (!output) throw new Error('usage: node usd-export.mjs BINDINGS BINARY REPO OUTPUT');
const api = await import(pathToFileURL(resolve(entry)).href);
const bytes = await readFile(binary);
api.initSync({ module: bytes });
await mkdir(output, { recursive: true });
const sha256 = value => createHash('sha256').update(value).digest('hex');
const inputs = [
  ['hello-wall', 'apps/landing/samples/hello-wall.ifc'],
  ['mapped', 'rust/geometry/tests/fixtures/mapped_instances_synthetic.ifc'],
  ['georeferenced', 'rust/geometry/tests/fixtures/issue_098_wall_V5C.ifc'],
  ...['blob-texture', 'image-texture', 'pixel-texture', 'individual-colors'].map(kind =>
    [kind, `tests/models/buildingsmart/annex_e/tessellated-shape-with-style/tessellation-with-${kind}.ifc`]),
];
const results = [];
const bridge = new api.IfcAPI();
try {
  for (const [name, path] of inputs) {
    const content = await readFile(resolve(root, path));
    try {
      const exported = bridge.exportUsd(new Uint8Array(content));
      if (!(exported instanceof Uint8Array) || !exported.length) throw new Error('export returned no byte artifact');
      await writeFile(resolve(output, `${name}.usda`), exported);
      results.push({ name, path, sourceSha256: sha256(content), bytes: exported.length, sha256: sha256(exported), status: 'exported' });
    } catch (error) {
      results.push({ name, path, sourceSha256: sha256(content), status: 'refused', error: String(error) });
    }
  }
} finally { bridge.free(); }
await writeFile(resolve(output, 'manifest.json'), JSON.stringify({ wasmSha256: sha256(bytes),
  bindingsSha256: sha256(await readFile(entry)), results }, null, 2));
console.log(JSON.stringify(results, null, 2));
if (results.some(result => result.status !== 'exported')) process.exitCode = 1;
