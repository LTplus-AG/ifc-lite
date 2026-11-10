/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Attribution report; --expect-lazy is a structural CI gate, not a byte ceiling.
// Build with VITE_BUNDLE_ANALYSIS=1.
import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { eagerJsFiles, brotliSize } from './measure-bundle.mjs';
import { staticImports } from '../check-viewer-retained-free.mjs';

const args = process.argv.slice(2);
const dist = resolve(args.find(arg => !arg.startsWith('--')) ?? 'apps/viewer/dist');
const chunks = JSON.parse(readFileSync(resolve(dist, 'bundle-analysis.json'), 'utf8'));
const { files } = eagerJsFiles(dist, readFileSync(resolve(dist, 'index.html'), 'utf8'));
const closure = new Set(files.map(({ file }) => file));
// Include transitive static imports as well as the HTML preload list.
for (const file of closure) {
  for (const specifier of staticImports(readFileSync(file, 'utf8'))) {
    if (specifier.startsWith('.')) closure.add(resolve(file, '..', specifier));
  }
}
const totals = new Map();
const modules = new Map();
const rows = [...closure].map(file => {
  const bytes = readFileSync(file);
  const chunk = chunks.find(chunk => chunk.file === relative(dist, file));
  if (!chunk) throw new Error(`Missing attribution for ${file}`);
  for (const module of chunk.modules) {
    const id = module.id;
    const name = id.includes('/node_modules/')
      ? id.split('/node_modules/').at(-1).split('/').slice(0, id.split('/node_modules/').at(-1).startsWith('@') ? 2 : 1).join('/')
      : id.match(/\/(packages\/[^/]+|apps\/viewer)/)?.[1] ?? 'other';
    totals.set(name, (totals.get(name) ?? 0) + module.renderedLength);
    modules.set(id, (modules.get(id) ?? 0) + module.renderedLength);
  }
  return [relative(dist, file), bytes.length, brotliSize(bytes)];
}).sort((a, b) => b[1] - a[1]);
console.log(`# Viewer eager closure\n\nHTML list: ${files.length} files; complete static closure: ${closure.size} files.`);
console.log('\nChunk bytes are exact raw/Brotli-11; module/package lengths are bundler attribution before final minification (not additive raw-byte savings).');
console.log('\n| Chunk | Raw bytes | Brotli bytes |\n| --- | ---: | ---: |');
for (const row of rows) console.log(`| ${row.join(' | ')} |`);
console.log(`| **Total** | **${rows.reduce((n, r) => n + r[1], 0)}** | **${rows.reduce((n, r) => n + r[2], 0)}** |`);
for (const [label, values] of [['Package', totals], ['Module', modules]]) {
  console.log(`\n| ${label} | Rendered length |\n| --- | ---: |`);
  for (const [name, size] of [...values].sort((a, b) => b[1] - a[1])) console.log(`| ${name} | ${size} |`);
}

// Optional acceptance assertion for this diet: inspect emitted module ownership,
// not source text or chunk names. Also catches a shared module pulling a panel back.
if (args.includes('--expect-lazy')) {
  for (const suffix of [
    '/components/viewer/BCFPanel.tsx',
    '/components/viewer/validation/ValidationPanel.tsx',
    '/components/viewer/LensPanel.tsx',
    '/components/viewer/bcf/BCFDraftsDialog.tsx',
  ]) {
    if (![...chunks].some(chunk => chunk.modules.some(module => module.id.endsWith(suffix)))) {
      throw new Error(`Expected lazy feature missing from output: ${suffix}`);
    }
    if ([...modules.keys()].some(id => id.endsWith(suffix))) {
      throw new Error(`Feature leaked into the eager closure: ${suffix}`);
    }
    console.log(`Verified outside eager closure: ${suffix}`);
  }
}
