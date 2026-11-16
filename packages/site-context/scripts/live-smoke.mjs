/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Opt-in smoke test of a site context against the LIVE Swiss services. Not
 * run in CI. Builds the site around the public Bundesplatz in Bern (the
 * point the geodata package's own smoke test uses), writes the GLB to the
 * system temp directory, decodes it again and reports requests, bytes and
 * timing.
 *
 *   pnpm --filter @ifc-lite/geodata-ch --filter @ifc-lite/site-context build
 *   pnpm --filter @ifc-lite/site-context smoke:live [radius]
 *
 * Default radius 100 m (0.5 m terrain): about ten requests at the client's
 * default 5 requests/second per host. Exits non-zero on a failed expectation.
 */

import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSwissGeodata } from '@ifc-lite/geodata-ch';
import { buildSiteContext, decodeSiteContextGlb, encodeSiteContextGlb, summarizeSiteContext } from '../dist/index.js';

const radius = Number(process.argv[2] ?? 100);
const centre = { x: 2_600_423, y: 1_199_521 };

let bytesIn = 0;
const countingFetch = async (input, init) => {
  const res = await fetch(input, init);
  const body = await res.arrayBuffer();
  bytesIn += body.byteLength;
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
};

const geodata = createSwissGeodata({ fetch: countingFetch });
const t0 = Date.now();
const doc = await buildSiteContext({
  centre,
  radius,
  layers: ['terrain', 'parcel'],
  geodata,
  onProgress: (p) => console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)} s] ${p.message}`),
});
const tBuild = Date.now() - t0;
const glb = encodeSiteContextGlb(doc);
const out = join(tmpdir(), `site-context-smoke-${radius}.glb`);
await writeFile(out, glb);
const back = decodeSiteContextGlb(glb);
const summary = summarizeSiteContext(doc);

function expect(cond, msg) {
  if (!cond) {
    console.error(`FAIL ${msg}`);
    process.exitCode = 1;
  }
}

const terrain = summary.layers.find((l) => l.kind === 'terrain');
const parcel = summary.layers.find((l) => l.kind === 'parcel');
expect(terrain && terrain.triangles > 0 && terrain.complete, `terrain incomplete: ${JSON.stringify(terrain?.issues)}`);
expect(doc.origin[2] > 450 && doc.origin[2] < 650, `implausible H0 ${doc.origin[2]}`);
expect(parcel && parcel.features > 0, `no parcel: ${JSON.stringify(parcel?.issues)}`);
expect(back.layers.length === doc.layers.length && back.origin.join() === doc.origin.join(), 'GLB round trip lost the frame');

console.log(JSON.stringify({
  centre,
  radius,
  origin: doc.origin,
  resolution: doc.layers[0].features[0]?.provenance.resolution,
  requests: geodata.requestCount,
  bytesDownloaded: bytesIn,
  glbBytes: glb.byteLength,
  buildSeconds: tBuild / 1000,
  output: out,
  layers: summary.layers.map((l) => ({ kind: l.kind, complete: l.complete, features: l.features, triangles: l.triangles, issues: l.issues.map((i) => `${i.code}: ${i.message}`) })),
  parcels: summary.parcels,
  terrainSources: doc.layers[0].features[0]?.provenance.sources,
}, null, 2));
