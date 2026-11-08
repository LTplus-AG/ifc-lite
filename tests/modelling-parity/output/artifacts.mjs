/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Artifact handling for the modelling-parity output probes (#9296).
 *
 * Which files a row's output level judges, and the drawing SANITY checks.
 * SDK results hand over `artifacts.ifc`. UI results (L4) hand over files under
 * `$PARITY_OUT/artifacts/<capability-id>/`, listed in `evidence` and in
 * `artifacts.{ifc,svg,pdf,dxf}` (contract "Handoffs"). IFC files get the full
 * validation in run.mjs. SVG, PDF and DXF get only a sanity check: the file
 * parses, is not empty and carries drawing content. That is not a validation
 * of the drawing's correctness, and the ledger says so.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { CENSUS_CLASSES } from '../probes/sdk/lib/parity.mjs';

export const KINDS = ['ifc', 'svg', 'pdf', 'dxf'];
const EXT = /\.(ifc|svg|pdf|dxf)$/i;

/** The kinds a row's output level needs: groups of alternatives, each group needing one file. Default [['ifc']]. */
export function requiredKinds(cap) {
  const r = cap.probes?.output?.requires;
  return Array.isArray(r) && r.length ? r : [['ifc']];
}

/**
 * Resolve a handed-over path. Absolute paths are used as given (Windows drive paths map to
 * /mnt/<drive>). A relative path is looked up next to the result file, then in each of its
 * ancestors, nearest first, then at the repository root. The first that exists wins. That
 * covers both lane layouts: L4's `ui-r0/probes.json` beside `ui-r0/artifacts/<id>/...`, and
 * `$PARITY_OUT/ui/<file>.json` with the files under `$PARITY_OUT/artifacts/<id>/...`.
 * When none exists, the result-relative candidate is returned so the failure names it.
 */
export function resolveArtifact(path, { root, resultFile }) {
  const win = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  if (win) return `/mnt/${win[1].toLowerCase()}/${win[2].replace(/\\/g, '/')}`;
  if (isAbsolute(path)) return path;
  const candidates = [];
  if (resultFile) {
    for (let dir = resolve(root, dirname(resultFile)); ; dir = dirname(dir)) {
      candidates.push(resolve(dir, path));
      if (dirname(dir) === dir) break;
    }
  }
  candidates.push(resolve(root, path));
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

/** Census classes an IFC export actually contains, by its own STEP records (exact class names). */
export function fileClasses(content) {
  const present = new Set();
  const byUpper = new Map(CENSUS_CLASSES.map((c) => [c.toUpperCase(), c]));
  for (const m of content.matchAll(/^#\d+\s*=\s*(IFC[A-Z0-9_]+)\s*\(/gm)) { const c = byUpper.get(m[1]); if (c) present.add(c); }
  return [...present].sort();
}

/**
 * Artifact sets to judge for one capability: one per pass/partial SDK or UI
 * result that handed over files. SDK results contribute only `artifacts.ifc`
 * (their evidence also lists intermediate exports); UI results contribute
 * `artifacts.*` and any evidence file with a known extension.
 */
export function artifactSets(results, capability, { root }) {
  const sets = [];
  for (const r of results) {
    if (r.capability !== capability || !['sdk', 'ui'].includes(r.probe) || !['pass', 'partial'].includes(r.status)) continue;
    const files = {};
    const add = (kind, p) => {
      if (!KINDS.includes(kind) || typeof p !== 'string' || !p) return;
      const abs = resolveArtifact(p, { root, resultFile: r.file });
      const list = (files[kind] ??= []);
      if (!list.includes(abs)) list.push(abs);
    };
    for (const kind of KINDS) {
      const v = r.artifacts?.[kind];
      for (const p of Array.isArray(v) ? v : [v]) add(kind, p);
    }
    if (r.probe === 'ui') for (const e of r.evidence ?? []) { const m = EXT.exec(String(e)); if (m) add(m[1].toLowerCase(), e); }
    if (Object.keys(files).length) sets.push({ source: r.probe, resultId: r.id, resultFile: r.file, files, census: r.artifacts?.census ?? null });
  }
  return sets;
}

const sanity = (kind) => `${kind.toUpperCase()} sanity check`;

/**
 * SVG: one root element holding well-formed tags, nothing but whitespace (or comments) before
 * or after it, no stray '<', an <svg> root and at least one line/path element.
 */
export function checkSvg(buf) {
  const name = sanity('svg');
  const text = buf.toString('utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<\?[\s\S]*?\?>/g, '').replace(/<!DOCTYPE[^>]*>/gi, '');
  if (!text.trim()) return { name, status: 'fail', detail: 'empty file' };
  const TAG = /<(\/?)([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  if (text.replace(TAG, '').includes('<')) return { name, status: 'fail', detail: "malformed: a '<' that starts no complete tag (truncated or broken markup)" };
  const stack = [], counts = {};
  let root = null, rootEnd = -1;
  for (const m of text.matchAll(TAG)) {
    const [whole, close, tag, , self] = m;
    if (rootEnd !== -1) return { name, status: 'fail', detail: `malformed: <${close}${tag}> after the root element closed` };
    if (!root) {
      if (close) return { name, status: 'fail', detail: `malformed: </${tag}> before any element opened` };
      if (text.slice(0, m.index).trim()) return { name, status: 'fail', detail: 'malformed: text before the root element' };
      root = tag;
    }
    if (close) {
      if (stack.pop() !== tag) return { name, status: 'fail', detail: `malformed: </${tag}> does not close the open element` };
    } else {
      counts[tag] = (counts[tag] ?? 0) + 1;
      if (!self) stack.push(tag);
    }
    if (!stack.length) rootEnd = m.index + whole.length;
  }
  if (stack.length) return { name, status: 'fail', detail: `malformed: <${stack[stack.length - 1]}> is never closed` };
  if (rootEnd !== -1 && text.slice(rootEnd).trim()) return { name, status: 'fail', detail: 'malformed: content after the root element' };
  if (root !== 'svg') return { name, status: 'fail', detail: `no <svg> root element (root is ${root ? `<${root}>` : 'missing'})` };
  const strokes = ['path', 'line', 'polyline', 'polygon'].reduce((n, t) => n + (counts[t] ?? 0), 0);
  if (!strokes) return { name, status: 'fail', detail: 'no path, line, polyline or polygon element: the drawing is empty' };
  return { name, status: 'pass', detail: `${strokes} line/path elements` };
}

/**
 * PDF: header, indirect objects (`n g obj` ... `endobj`), cross-reference data (an `xref`
 * table or an /XRef stream) with `startxref`, a trailer or /Root, the %%EOF marker, and at
 * least one page. Still a sanity check: no object is parsed or rendered.
 */
export function checkPdf(buf) {
  const name = sanity('pdf');
  if (!buf.length) return { name, status: 'fail', detail: 'empty file' };
  const text = buf.toString('latin1');
  const missing = [
    [/^%PDF-[12]\.\d/, '%PDF- header'],
    [/\b\d+\s+\d+\s+obj\b/, 'indirect objects (n g obj)'],
    [/\bendobj\b/, 'endobj'],
    [/\bxref\s+\d+\s+\d+|\/Type\s*\/XRef\b/, 'cross-reference table or /XRef stream'],
    [/\bstartxref\s+\d+/, 'startxref offset'],
    [/\btrailer\b|\/Root\s+\d+\s+\d+\s+R\b/, 'trailer or /Root'],
  ].filter(([re]) => !re.test(text)).map(([, what]) => what);
  if (!text.slice(-2048).includes('%%EOF')) missing.push('%%EOF marker');
  if (missing.length) return { name, status: 'fail', detail: `not a PDF file structure: no ${missing.join(', ')}` };
  const pages = (text.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
  const counted = Math.max(0, ...[...text.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g)].map((m) => Number(m[1] ?? m[2])));
  const n = Math.max(pages, counted);
  if (!n) return { name, status: 'fail', detail: 'no page object found' };
  const box = /\/MediaBox\s*\[\s*([-\d.\s]+)\]/.exec(text)?.[1]?.trim().split(/\s+/).map(Number);
  return { name, status: 'pass', detail: `${n} page(s)${box?.length === 4 ? `, first MediaBox ${Math.round(box[2] - box[0])} x ${Math.round(box[3] - box[1])} pt` : ''}` };
}

/** DXF (ASCII): numeric group codes, an ENTITIES section, an EOF and at least one linework entity. */
export function checkDxf(buf) {
  const name = sanity('dxf');
  if (!buf.length) return { name, status: 'fail', detail: 'empty file' };
  if (buf.subarray(0, 22).toString('latin1').startsWith('AutoCAD Binary DXF')) return { name, status: 'fail', detail: 'binary DXF is not sanity-checked; export ASCII DXF' };
  const lines = buf.toString('latin1').split(/\r?\n/);
  if (lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length < 4 || lines.length % 2) return { name, status: 'fail', detail: `not group-code/value pairs (${lines.length} lines)` };
  let section = null, sawEntities = false, eof = false;
  const entities = {};
  for (let i = 0; i < lines.length; i += 2) {
    const code = lines[i].trim(), value = lines[i + 1].trim();
    if (!/^-?\d+$/.test(code)) return { name, status: 'fail', detail: `line ${i + 1}: group code "${code.slice(0, 20)}" is not an integer` };
    if (code === '0' && value === 'SECTION') section = 'pending';
    else if (code === '2' && section === 'pending') { section = value; if (value === 'ENTITIES') sawEntities = true; }
    else if (code === '0' && value === 'ENDSEC') section = null;
    else if (code === '0' && value === 'EOF') eof = true;
    else if (code === '0' && section === 'ENTITIES') entities[value] = (entities[value] ?? 0) + 1;
  }
  if (!sawEntities) return { name, status: 'fail', detail: 'no ENTITIES section' };
  if (!eof) return { name, status: 'fail', detail: 'no EOF: truncated file' };
  const linework = ['LINE', 'LWPOLYLINE', 'POLYLINE', 'ARC', 'CIRCLE'].reduce((n, t) => n + (entities[t] ?? 0), 0);
  if (!linework) return { name, status: 'fail', detail: `no linework entities (found ${JSON.stringify(entities)})` };
  return { name, status: 'pass', detail: `${linework} linework entities${entities.TEXT || entities.MTEXT ? `, ${(entities.TEXT ?? 0) + (entities.MTEXT ?? 0)} texts` : ''}` };
}

export const DRAWING_CHECKS = { svg: checkSvg, pdf: checkPdf, dxf: checkDxf };

/** Sanity-check one drawing file; a missing file is a failed check, never a pass. */
export function checkDrawing(kind, path) {
  if (!existsSync(path)) return { name: sanity(kind), status: 'fail', detail: `handed-over file not found: ${path}` };
  return { ...DRAWING_CHECKS[kind](readFileSync(path)), file: path };
}
