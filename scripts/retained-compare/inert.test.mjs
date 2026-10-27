// SPDX-License-Identifier: MPL-2.0
// Real pkg-retained against E1's inert peer: protocol/report evidence only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFile, cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { collectRetained } from '../../packages/cli/dist/retained/run.js';
import { retainedArtifacts } from '../../packages/cli/dist/commands/export-retained.js';
import { retainedReport } from '../../packages/cli/dist/retained/report.js';
const fixtures = new URL('../lib/__fixtures__/retained-driver/', import.meta.url);
register(new URL('hooks.mjs', fixtures), { data: { peer: new URL('peer.mjs', fixtures).href, client: new URL('client.mjs', fixtures).href } });
const { peers, nextPeer } = await import(new URL('peer.mjs', fixtures));
const module = await import('../../packages/wasm/pkg-retained/ifc-lite.js');
await module.default({ module_or_path: await readFile(new URL('../../packages/wasm/pkg-retained/ifc-lite_bg.wasm', import.meta.url)) });
const engine = { sdk: 'inert peer; not SMLib', capabilities: null, manifestSha256: '0'.repeat(64) };
const source = await readFile(new URL('../../tests/fixtures/synthetic-retained/f-c-extrusion.ifc', import.meta.url), 'utf8');
const append = extra => new TextEncoder().encode(source.replace('ENDSEC;\nEND-ISO', `${extra}\nENDSEC;\nEND-ISO`));

test('#7955 actual retainedModel yields deterministic CLI report and no partial products', async () => {
  const api = new module.IfcAPI();
  try {
    const outcomes = await collectRetained(api, append(`#80=IFCBUILDINGELEMENTPROXY('p',$,$,$,$,#24,#26,$,.NOTDEFINED.);
#81=IFCMATERIALLAYER($,0.1,$);#85=IFCMATERIALLAYER($,0.2,$);#82=IFCMATERIALLAYERSET((#81,#85),'layers');
#83=IFCMATERIALLAYERSETUSAGE(#82,.AXIS2.,.POSITIVE.,0.);
#84=IFCRELASSOCIATESMATERIAL('m',$,$,$,(#80),#83);`));
    const { obj, report } = retainedArtifacts(engine, outcomes, () => null);
    assert.deepEqual(report.summary, { candidates: 2, published: 1, coverage: 0.5, byCode: { material_layer_strategy: 1 } });
    assert.equal(report.products[0].parts.length, 1);
    assert.deepEqual(report.products[0].obligationsUnmet, ['OpeningClosure', 'MaterialLayers', 'IfcAppearance', 'PersistentFaces']);
    assert.equal(report.products[1].code, 'material_layer_strategy');
    assert.ok(!('parts' in report.products[1]));
    assert.equal(obj.split('\n').filter(line => line === '# PresentationObligationsUnmet').length, 1);
    assert.ok(peers.every(peer => peer.retired));
    assert.deepEqual(await collectRetained(api, new TextEncoder().encode(source), new Uint32Array()), []);
    nextPeer().then(peer => { peer.failOpcode = 10; peer.failAtOccurrence = 2; peer.kernelStatus = 4; });
    const partial = await collectRetained(api, append(`#105=IFCEXTRUDEDAREASOLID(#18,#2,#3,4.);
#102=IFCSHAPEREPRESENTATION(#4,'Body','SweptSolid',(#19,#105));
#103=IFCPRODUCTDEFINITIONSHAPE($,$,(#102));
#100=IFCBUILDINGELEMENTPROXY('parts',$,$,$,$,#24,#103,$,.NOTDEFINED.);`), Uint32Array.of(100));
    const failure = retainedReport(engine, partial, () => null);
    assert.equal(failure.products[0].code, 'kernel_failure');
    assert.equal(failure.products[0].kernelStatus, 4);
    assert.ok(!('parts' in failure.products[0]));
    assert.throws(() => retainedArtifacts(engine, partial, () => null), /0 products/);
  } finally { api.free(); }
});

// This validly inventoried test engine contains the real Rust WASM and inert
// placeholders for unused SDK assets. Source refusal must never acquire an SDK.
test('#7955 real CLI zero-publication refusal writes neither OBJ nor report', async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'cli-inert-fatal-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const directory = join(scratch, 'engine');
  await mkdir(directory);
  await cp(new URL('../../packages/wasm/pkg-retained/', import.meta.url), join(directory, 'pkg-retained'), { recursive: true });
  const packagePath = join(directory, 'pkg-retained/package.json');
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
  await writeFile(packagePath, JSON.stringify({ ...pkg, type: 'module' }));
  for (const name of ['node/client.mjs', 'node/worker.mjs', 'worker.mjs', 'module.mjs', 'sweep.mjs',
    'sweep-contract.mjs', 'contract.mjs', 'ifclite_smlib_browser.mjs', 'ifclite_smlib_browser.wasm']) {
    const path = join(directory, 'smlib', name); await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'throw new Error("SMLib must not be acquired for a source refusal");');
  }
  await cp(new URL('../../native/smlib-adapter/node/hooks.mjs', import.meta.url), join(directory, 'smlib/node/hooks.mjs'));
  for (const name of ['SMLib/LICENSE', 'SMLib/THIRD_PARTY_NOTICES.md', 'ifc-lite/LICENSE']) {
    const path = join(directory, 'LICENSES', name); await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'Inert test inventory, never distributed as an engine.');
  }
  const assets = [];
  async function inventory(prefix = '') {
    for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await inventory(path);
      else {
        const bytes = await readFile(join(directory, path));
        assets.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      }
    }
  }
  await inventory();
  await writeFile(join(directory, 'engine-manifest.json'), JSON.stringify({ format: 'ifc-lite.retained-engine/1',
    sdk: { revision: '0'.repeat(40) }, capabilities: null, assets }));
  const cli = spawnSync(process.execPath, ['packages/cli/dist/index.js', 'export',
    'tests/fixtures/synthetic-retained/f-c-brep.ifc', '--format', 'obj', '--kernel', 'retained',
    '--retained-engine', directory, '--out', join(scratch, 'out.obj'), '--retained-report', join(scratch, 'report.json')],
  { encoding: 'utf8', timeout: 60000 });
  assert.equal(cli.status, 1, cli.stderr);
  assert.match(cli.stderr, /Retained export published 0 products; nothing written/);
  assert.equal(cli.stdout, '');
  assert.deepEqual(await readdir(scratch), ['engine']);
});
