/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
export const defaultAssets = join(homedir(), '.cache/ifc-lite/gaussian-splat-spike');
export const captures = [
  { id: 'plant', bytes: 3636736, count: 113648, sha256: 'ce9d490b18f16d6730d832227bf541431b8b1a5d167c5a3fe89af4f324c0d8fd' },
  { id: 'textile_ball', bytes: 12306848, count: 384589, sha256: '30a84f6fd18e1e027ff0bb639353fa6301dc4c6a2da7cdda157b51ed58a5de05' },
];
const revision = 'c3e5ec0a8ddb3ab26f28a067a29d272fe1a23411';
export function verifyBytes(data, expected) {
  const sha256 = createHash('sha256').update(data).digest('hex');
  if (data.length !== expected.bytes || sha256 !== expected.sha256) throw new Error(`Fixture integrity failed: ${expected.id}`);
  return sha256;
}
async function fetchBytes(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(90000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return Buffer.from(await response.arrayBuffer());
}
async function prepare() {
  const root = resolve(process.argv[2] ?? defaultAssets);
  await mkdir(root, { recursive: true });
  const records = [];
  for (const item of captures) {
    const base = `https://raw.githubusercontent.com/marcelpadilla/splats/${revision}/data/${item.id}/`;
    const file = join(root, `${item.id}.splat`);
    let data;
    try { data = await readFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    data ??= await fetchBytes(`${base}${item.id}.splat`);
    verifyBytes(data, item);
    await writeFile(file, data);
    const metadata = await fetchBytes(`${base}meta.json`);
    await writeFile(join(root, `${item.id}.meta.json`), metadata);
    records.push({ ...item, url: `${base}${item.id}.splat`, license: 'CC-BY-4.0', author: 'Marcel Padilla', units: 'non-metric reconstruction scale', shDegree: 0 });
  }
  await writeFile(join(root, 'CAPTURE-LICENSE.txt'), await fetchBytes(`https://raw.githubusercontent.com/marcelpadilla/splats/${revision}/LICENSE`));
  const manifest = JSON.parse(await readFile(new URL('../../tests/models/manifest.json', import.meta.url), 'utf8'));
  const fixture = manifest.files.find(item => item.path === 'ara3d/AC20-FZK-Haus.ifc');
  const expected = { id: 'FZK', bytes: fixture.size, sha256: fixture.sha256 };
  const ifcPath = join(root, 'model.ifc');
  let ifc;
  try { ifc = await readFile(ifcPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  ifc ??= await fetchBytes(`${manifest.base_url}/${fixture.sha256}`);
  verifyBytes(ifc, expected);
  await writeFile(ifcPath, ifc);
  records.push({ ...expected, url: `${manifest.base_url}/${fixture.sha256}`, source: fixture.path });
  const wasmVersion = '10.6.1';
  const pkg = await fetchBytes(`https://registry.npmjs.org/@ifc-lite/wasm/-/wasm-${wasmVersion}.tgz`);
  const archive = join(root, 'wasm-package.tgz');
  await writeFile(archive, pkg);
  await mkdir(join(root, 'wasm'), { recursive: true });
  execFileSync('tar', ['xzf', archive, '--strip-components=2', '-C', join(root, 'wasm'), 'package/pkg/ifc-lite.js', 'package/pkg/ifc-lite_bg.wasm']);
  records.push({ id: 'wasm', version: wasmVersion, sha256: createHash('sha256').update(pkg).digest('hex') });
  await writeFile(join(root, 'fixtures.json'), JSON.stringify({ revision, records }, null, 2) + '\n');
  console.log(JSON.stringify({ root, records }, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepare();
