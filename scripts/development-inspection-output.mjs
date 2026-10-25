// SPDX-License-Identifier: MPL-2.0
// Called only after the canonical build script successfully regenerates WASM.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const implementationCommit = process.env.IFC_RETAINED_BUILD_COMMIT;
if (!/^[a-f0-9]{40}$/u.test(implementationCommit ?? '')) throw new Error('Missing trusted build input');
const files = Object.fromEntries(readdirSync('.retained-dev/wasm', { recursive: true })
  .filter(name => /\.(?:js|wasm|ts)$/u.test(name)).sort().map(name =>
  [name, createHash('sha256').update(readFileSync(`.retained-dev/wasm/${name}`)).digest('hex')]));
writeFileSync('.retained-dev/build.json', JSON.stringify({ implementationCommit, files,
  provenance: 'build_input_only_match_original_request_and_receipt_before_qualification' }, null, 2) + '\n');
// Explicit private resolution only; release tsconfigs never extend this file.
writeFileSync('.retained-dev/tsconfig.json', JSON.stringify({ compilerOptions: {
  target: 'ESNext', module: 'ESNext', moduleResolution: 'Bundler', strict: true,
  noEmit: true, skipLibCheck: false, types: [],
  paths: { '@ifc-lite/development-inspection': ['./wasm/ifc-lite.d.ts'] },
}, files: ['../scripts/consumer/development-inspection-types.mts'] }, null, 2) + '\n');
