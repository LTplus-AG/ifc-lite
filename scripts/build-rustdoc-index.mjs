#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const escapeHtml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

export function buildRustdocIndex(rustdocDir, outputFile) {
  if (!existsSync(rustdocDir)) throw new Error(`rustdoc directory is missing: ${rustdocDir}`);
  const crates = readdirSync(rustdocDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(rustdocDir, entry.name, 'index.html')))
    .map((entry) => entry.name).sort();
  if (crates.length === 0) throw new Error(`rustdoc produced no crate entry points under ${rustdocDir}`);
  const links = crates.map((name) => `      <li><a href="./${escapeHtml(name)}/">${escapeHtml(name.replaceAll('_', '-'))}</a></li>`).join('\n');
  const html = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ifc-lite Rust API</title></head>\n<body><main><h1>ifc-lite Rust API</h1><ul>\n${links}\n</ul></main></body></html>\n`;
  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, html);
  return crates;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [rustdocDir, outputFile] = process.argv.slice(2);
  if (!rustdocDir || !outputFile) throw new Error('usage: build-rustdoc-index.mjs <target/doc> <output.html>');
  const crates = buildRustdocIndex(resolve(rustdocDir), resolve(outputFile));
  console.log(`Rustdoc landing page links ${crates.length} crate(s).`);
}
