#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
// #7779 G3: the charter's copied spelling, not a semantic leaf-reader proof.
// No grandfathering or auto-baseline mode. Residuals remain failing debt.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { lex, isTestPath, cfgTestRanges } from './lib/rust-source-text-detect.mjs';
import { isMainEntry } from './lib/is-main-entry.mjs';

const canonical = 'rust/core/src/decoder/leaf_read.rs';
const spelling = /\b(?:coords|ratios)\s*\.\s*(?:first\s*\(\s*\)|get\s*\(\s*\d\s*\))\s*\.\s*and_then\s*\(\s*\|\s*v\s*\|\s*v\s*\.\s*as_float\s*\(\s*\)\s*\)\s*\.\s*unwrap_or\s*\(/g;

export function scanSource(text, path) {
  if (path === canonical || isTestPath(path)) return [];
  const { masked } = lex(text);
  const tests = cfgTestRanges(masked);
  return [...masked.matchAll(spelling)]
    .filter(match => !tests.some(([start, end]) => match.index >= start && match.index <= end))
    .map(match => ({ path, line: text.slice(0, match.index).split('\n').length,
      offset: match.index, spelling: text.slice(match.index, match.index + match[0].length) }));
}

function rustFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...rustFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.rs')) files.push(path);
  }
  return files;
}

export function runCheck(root) {
  const crates = readdirSync(join(root, 'rust'), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => join(root, 'rust', entry.name, 'src'))
    .filter(path => { try { return statSync(path).isDirectory(); } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    } });
  if (!crates.length) throw new Error('No rust/*/src roots found');
  const roots = [...crates, join(root, 'apps/server/src')];
  const findings = [];
  let scanned = 0;
  for (const sourceRoot of roots) {
    const files = rustFiles(sourceRoot);
    if (!files.length) throw new Error(`Empty Rust source root: ${sourceRoot}`);
    scanned += files.length;
    for (const file of files.sort()) {
      findings.push(...scanSource(readFileSync(file, 'utf8'), relative(root, file).split('\\').join('/')));
    }
  }
  return { scanned, findings, ok: findings.length === 0 };
}

if (isMainEntry(import.meta.url)) {
  try {
    const result = runCheck(process.cwd());
    for (const hit of result.findings) console.error(`${hit.path}:${hit.line}: copied coordinate/ratio default`);
    console.log(`G3 leaf spelling: ${result.scanned} Rust files, ${result.findings.length} forbidden occurrences`);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error(`G3 leaf spelling: ${error.message}`);
    process.exitCode = 1;
  }
}
