#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Generate the machine-derived regions of the docs so they cannot drift
 * from the source of truth. Each region is delimited in its doc by
 *   <!-- BEGIN GENERATED: <name> -->
 *   ...generated content...
 *   <!-- END GENERATED: <name> -->
 * and only the content between the markers is rewritten; surrounding
 * prose is left alone.
 *
 * Regions:
 *   package-index (docs/api/typescript.md)  — table of published packages
 *                                             from each package.json
 *   cli-commands  (docs/guide/cli.md)       — command summary parsed from
 *                                             the CLI HELP text
 *   perf-numbers  (docs/guide/performance.md) — benchmark numbers stamped
 *                                             from the committed baseline
 *   landing-bench (apps/landing/app.jsx)    — cross-engine benchmark rows
 *                                             stamped from the committed
 *                                             apps/landing/bench-data.json
 *
 * Modes (mirrors scripts/check-api-surface.mjs UX):
 *   node scripts/docs/generate-docs-sections.mjs           # rewrite (pnpm docs:generate)
 *   node scripts/docs/generate-docs-sections.mjs --check   # verify, diff + exit 1 if stale
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHECK = process.argv.includes('--check');

/* --------------------------------------------------------------------- */
/* Helpers                                                               */
/* --------------------------------------------------------------------- */

/** All published (non-private) packages under packages/*, sorted by dir. */
function publishedPackages() {
  const packagesDir = join(ROOT, 'packages');
  const out = [];
  for (const dir of readdirSync(packagesDir).sort()) {
    const pkgJsonPath = join(packagesDir, dir, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    if (pkg.private === true || !pkg.name) continue;
    out.push({ dir, name: pkg.name, description: (pkg.description ?? '').trim() });
  }
  return out;
}

/**
 * Slugify a Markdown heading the way python-markdown's toc does, so a
 * generated in-page anchor matches the real heading id.
 */
function slugify(heading) {
  return heading
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-');
}

/** Ordered list of `## ` headings in a Markdown file. */
function headingsOf(markdown) {
  const headings = [];
  for (const line of markdown.split('\n')) {
    const m = line.match(/^##\s+(.*\S)\s*$/);
    if (m) headings.push(m[1]);
  }
  return headings;
}

/** 12345 -> "12,345" */
function thousands(n) {
  return n.toLocaleString('en-US');
}

/* --------------------------------------------------------------------- */
/* Region generators                                                     */
/* --------------------------------------------------------------------- */

/** package-index: table of every published package. */
function genPackageIndex(currentDoc) {
  const packages = publishedPackages();
  // Anchor targets: any `## <npm name>` heading present in this doc.
  const anchors = new Map();
  for (const h of headingsOf(currentDoc)) anchors.set(h, slugify(h));

  // Order by the section order in the doc; packages without a section go
  // last, alphabetically — keeps the table stable and readable.
  const withSection = [];
  const withoutSection = [];
  for (const pkg of packages) {
    (anchors.has(pkg.name) ? withSection : withoutSection).push(pkg);
  }
  const sectionOrder = headingsOf(currentDoc);
  withSection.sort(
    (a, b) => sectionOrder.indexOf(a.name) - sectionOrder.indexOf(b.name),
  );
  withoutSection.sort((a, b) => a.name.localeCompare(b.name));

  const rows = [...withSection, ...withoutSection].map((pkg) => {
    const link = anchors.has(pkg.name)
      ? `#${anchors.get(pkg.name)}`
      : `https://www.npmjs.com/package/${pkg.name}`;
    const desc = pkg.description || '(no description)';
    return `| [\`${pkg.name}\`](${link}) | ${desc} |`;
  });

  return [
    '| Package | Description |',
    '|---------|-------------|',
    ...rows,
  ].join('\n');
}

/**
 * cli-commands: parse the `Commands:` block of the CLI HELP template
 * literal into a name + one-line-description table.
 */
function genCliCommands() {
  const cliSrc = readFileSync(join(ROOT, 'packages', 'cli', 'src', 'index.ts'), 'utf-8');
  const helpMatch = cliSrc.match(/const HELP = `([\s\S]*?)`;/);
  if (!helpMatch) {
    throw new Error('Could not find the HELP template literal in packages/cli/src/index.ts');
  }
  const help = helpMatch[1];
  const commandsBlock = help.match(/\n {2}Commands:\n([\s\S]*?)\n {2}Options:/);
  if (!commandsBlock) {
    throw new Error('Could not find the Commands: block in the CLI HELP text');
  }

  const commands = [];
  for (const line of commandsBlock[1].split('\n')) {
    // A command row starts at exactly 4 spaces then the command name;
    // wrapped continuation lines are indented deeper and are skipped.
    // Long names (diagnose-geometry, extract-entities, generate-spaces)
    // have only ONE space before their <args>, so the name-to-remainder
    // gap must be \s+ not \s{2,}; the description is always the final
    // 2+-space-separated field of the row.
    const m = line.match(/^ {4}([a-z][\w-]*)\s+(.+?)\s*$/);
    if (!m) continue;
    const name = m[1];
    // Description extraction, in order of reliability:
    // 1. Most rows separate args from description with 2+ spaces; take
    //    the final such field.
    // 2. Rows like `mcp` use a single space; strip leading <arg> / [arg]
    //    placeholder groups and keep the remainder.
    // 3. Rows like `schema` have no args at all; the remainder IS the
    //    description.
    const parts = m[2].split(/\s{2,}/);
    let description;
    if (parts.length >= 2) {
      description = parts[parts.length - 1].trim();
    } else {
      let rest = m[2];
      let stripped;
      do {
        stripped = rest.replace(/^(<[^>]*>|\[[^\]]*\]|"[^"]*")\s*/, '');
        const changed = stripped !== rest;
        rest = stripped;
        if (!changed) break;
      } while (rest.length > 0);
      description = rest.trim();
    }
    if (!description) continue; // pure continuation line
    commands.push({ name, description });
  }

  if (commands.length < 20) {
    throw new Error(
      `CLI HELP parse found only ${commands.length} commands (expected >= 20). ` +
        'The HELP format in packages/cli/src/index.ts likely changed — update the parser.',
    );
  }

  const rows = commands.map((c) => `| \`${c.name}\` | ${c.description} |`);
  return ['| Command | Description |', '|---------|-------------|', ...rows].join('\n');
}

/** perf-numbers: benchmark table stamped from the committed baseline. */
function genPerfNumbers() {
  const baselinePath = join(ROOT, 'tests', 'benchmark', 'baseline.json');
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'));

  const mb = (v) => (typeof v === 'number' ? `${v.toFixed(1)} MB` : '-');
  const secs = (ms) => (typeof ms === 'number' ? `${(ms / 1000).toFixed(1)} s` : '-');
  const count = (v) => (typeof v === 'number' ? thousands(v) : '-');
  const label = (name) => name.replace(/\.ifc$/i, '');
  const date = (ts) => (ts ? ts.slice(0, 10) : '-');

  // Largest file first: the table reads as a "small -> huge" stress ramp.
  const entries = Object.entries(baseline).sort(
    ([, a], [, b]) => (a.metrics?.fileSizeMB ?? 0) - (b.metrics?.fileSizeMB ?? 0),
  );

  const rows = entries.map(([name, entry]) => {
    const m = entry.metrics ?? {};
    return `| ${label(name)} | ${mb(m.fileSizeMB)} | ${count(m.entityCount)} | ${count(m.totalMeshes)} | ${secs(m.totalWallClockMs)} | ${date(entry.timestamp)} |`;
  });

  const table = [
    '| Model | File size | Entities | Meshes | Total load | Recorded |',
    '|-------|-----------|----------|--------|-----------|----------|',
    ...rows,
  ].join('\n');

  const note =
    'Source: `tests/benchmark/baseline.json`, the committed viewer-benchmark ' +
    'regression baseline. Rows recorded on 2026-07-01 come from the CI runner ' +
    '(GitHub Actions `ubuntu-latest`, headless Chrome + SwiftShader, production ' +
    'build); earlier rows are reference runs on faster local hardware, so the ' +
    'two groups are not directly comparable. Refresh with `pnpm docs:generate` ' +
    'after recording a new baseline.';

  return `${table}\n\n${note}`;
}

/* --------------------------------------------------------------------- */
/* Region wiring                                                         */
/* --------------------------------------------------------------------- */

/**
 * Cross-engine benchmark rows for the landing page's interactive chart,
 * stamped from the committed apps/landing/bench-data.json (which carries
 * engine versions + methodology; raw runs live in the profiling repo).
 * The region markers sit inside block comments so the .jsx stays valid;
 * the body therefore CLOSES the begin-marker comment first and re-OPENS
 * one for the end marker.
 */
function genLandingBench() {
  const dataPath = join(ROOT, 'apps', 'landing', 'bench-data.json');
  const data = JSON.parse(readFileSync(dataPath, 'utf-8'));
  const pad = (str, n) => String(str).padEnd(n);
  const rows = data.models.map((m) => {
    const cells = [
      `id: ${pad(`${JSON.stringify(m.id)},`, 11)}`,
      `name: ${pad(`${JSON.stringify(m.name)},`, 41)}`,
      `size: ${pad(`${m.size.toFixed(1)},`, 7)}`,
      `products: ${pad(`${m.products},`, 7)}`,
      `ifclite_n: ${m.ifclite_n.toFixed(2)},`,
      `ifclite_w: ${m.ifclite_w.toFixed(2)},`,
      `webifc: ${m.webifc.toFixed(2)},`,
      `iosmax: ${m.iosmax.toFixed(2)},`,
      `ios1c: ${m.ios1c.toFixed(2)}`,
    ];
    return `  { ${cells.join(' ')} },`;
  });
  return [
    ' */',
    `// Recorded ${data.meta.recorded} on ${data.meta.hardware}: ${data.meta.units}.`,
    `// Engines: ${data.meta.engines.ifclite_wasm} / ${data.meta.engines.ifclite_native} /`,
    `// ${data.meta.engines.webifc}; IOS rows: ${data.meta.engines.ifcopenshell}.`,
    '// Source of truth: apps/landing/bench-data.json (methodology + raw runs:',
    '// louistrue/profiling@apples-to-apples-with-native). Regenerate with',
    '// `pnpm docs:generate` — do not edit the rows by hand.',
    'const BENCH_MODELS = [',
    ...rows,
    '];',
    '/*',
  ].join('\n');
}

const REGIONS = [
  {
    name: 'package-index',
    file: 'docs/api/typescript.md',
    generate: (currentDoc) => genPackageIndex(currentDoc),
  },
  {
    name: 'cli-commands',
    file: 'docs/guide/cli.md',
    generate: () => genCliCommands(),
  },
  {
    name: 'perf-numbers',
    file: 'docs/guide/performance.md',
    generate: () => genPerfNumbers(),
  },
  {
    name: 'landing-bench',
    file: 'apps/landing/app.jsx',
    generate: () => genLandingBench(),
  },
];

/** Replace the body between a region's markers; returns the new file text. */
function applyRegion(fileText, name, body) {
  const begin = `<!-- BEGIN GENERATED: ${name} -->`;
  const end = `<!-- END GENERATED: ${name} -->`;
  const re = new RegExp(
    `(${begin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})[\\s\\S]*?(${end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`,
  );
  if (!re.test(fileText)) {
    throw new Error(
      `Markers for region "${name}" not found. Add:\n  ${begin}\n  ${end}\nto the doc first.`,
    );
  }
  return fileText.replace(re, `$1\n${body}\n$2`);
}

let stale = 0;
for (const region of REGIONS) {
  const abs = join(ROOT, region.file);
  const original = readFileSync(abs, 'utf-8');
  const body = region.generate(original);
  const updated = applyRegion(original, region.name, body);

  if (updated === original) {
    if (!CHECK) console.log(`  ${region.file} [${region.name}] up to date`);
    continue;
  }

  if (CHECK) {
    stale += 1;
    console.error(`\n❌ Stale generated region "${region.name}" in ${region.file}:\n`);
    printRegionDiff(original, updated, region.name);
  } else {
    writeFileSync(abs, updated);
    console.log(`  ${region.file} [${region.name}] rewritten`);
  }
}

if (CHECK && stale > 0) {
  console.error(
    `\n❌ ${stale} generated doc region${stale === 1 ? '' : 's'} out of date.\n` +
      'Run `pnpm docs:generate` and commit the result.\n',
  );
  process.exit(1);
}

console.log(
  CHECK
    ? `✅ All ${REGIONS.length} generated doc regions are up to date.`
    : `✅ Generated ${REGIONS.length} doc regions.`,
);

/** Line diff of just the changed region, for --check output. */
function printRegionDiff(original, updated, name) {
  const grab = (text) => {
    const begin = text.indexOf(`<!-- BEGIN GENERATED: ${name} -->`);
    const end = text.indexOf(`<!-- END GENERATED: ${name} -->`);
    return text.slice(begin, end).split('\n');
  };
  const before = grab(original);
  const after = grab(updated);
  const max = Math.max(before.length, after.length);
  for (let i = 0; i < max; i += 1) {
    const b = before[i];
    const a = after[i];
    if (b === a) continue;
    if (b !== undefined) console.error(`   - ${b}`);
    if (a !== undefined) console.error(`   + ${a}`);
  }
}
