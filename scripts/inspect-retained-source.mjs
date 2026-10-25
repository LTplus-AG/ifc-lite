#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
// Local diagnostic consumer; no geometry/runtime execution or published API.
import { readFileSync } from 'node:fs';
import { loadDevelopmentInspection } from './lib/development-inspection.mjs';

const [requestPath, sourcePath, product, optionsPath] = process.argv.slice(2);
if (!requestPath || !sourcePath || !product || !optionsPath || process.argv.length !== 6) {
  throw new Error('Usage: node scripts/inspect-retained-source.mjs ORIGINAL_FLEET_REQUEST.json MODEL.ifc PRODUCT_ID OPTIONS.json');
}
const request = JSON.parse(readFileSync(requestPath, 'utf8'));
if (typeof request.id !== 'string' || !Array.isArray(request.command)) throw new Error('Original fleet request required');
const inspect = await loadDevelopmentInspection(request.commit);
const report = inspect(readFileSync(sourcePath), Number(product), readFileSync(optionsPath, 'utf8'));
process.stdout.write(JSON.stringify({ requestId: request.id, report }) + '\n');
