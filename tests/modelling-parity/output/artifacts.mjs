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

export const KINDS = ['ifc', 'svg', 'pdf', 'dxf'];
const EXT = /\.(ifc|svg|pdf|dxf)$/i;

/** The kinds a row's output level needs: groups of alternatives, each group needing one file. Default [['ifc']]. */
export function requiredKinds(cap) {
  const r = cap.probes?.output?.requires;
  return Array.isArray(r) && r.length ? r : [['ifc']];
}

/** Resolve a handed-over path: absolute (Windows drive paths mapped to /mnt/<drive>), else repo- or result-relative. */
export function resolveArtifact(path, { root, resultFile }) {
  const win = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  if (win) return `/mnt/${win[1].toLowerCase()}/${win[2].replace(/\\/g, '/')}`;
  if (isAbsolute(path)) return path;
  const candidates = [resolve(root, path), ...(resultFile ? [resolve(root, dirname(resultFile), path)] : [])];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
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

/** SVG: well-formed tags with an <svg> root and at least one line/path element. */
export function checkSvg(buf) {
  const name = sanity('svg');
  const text = buf.toString('utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<\?[\s\S]*?\?>/g, '').replace(/<!DOCTYPE[^>]*>/gi, '');
  if (!text.trim()) return { name, status: 'fail', detail: 'empty file' };
  const stack = [], counts = {};
  for (const m of text.matchAll(/<(\/?)([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g)) {
    const [, close, tag, , self] = m;
    if (close) {
      if (stack.pop() !== tag) return { name, status: 'fail', detail: `malformed: </${tag}> does not close the open element` };
    } else {
      counts[tag] = (counts[tag] ?? 0) + 1;
      if (!self) stack.push(tag);
    }
  }
  if (stack.length) return { name, status: 'fail', detail: `malformed: <${stack[stack.length - 1]}> is never closed` };
  if (!counts.svg) return { name, status: 'fail', detail: 'no <svg> root element' };
  const strokes = ['path', 'line', 'polyline', 'polygon'].reduce((n, t) => n + (counts[t] ?? 0), 0);
  if (!strokes) return { name, status: 'fail', detail: 'no path, line, polyline or polygon element: the drawing is empty' };
  return { name, status: 'pass', detail: `${strokes} line/path elements` };
}

/** PDF: header, end-of-file marker and at least one page. */
export function checkPdf(buf) {
  const name = sanity('pdf');
  if (!buf.length) return { name, status: 'fail', detail: 'empty file' };
  const text = buf.toString('latin1');
  if (!/^%PDF-[12]\.\d/.test(text)) return { name, status: 'fail', detail: 'no %PDF- header' };
  if (!text.slice(-2048).includes('%%EOF')) return { name, status: 'fail', detail: 'no %%EOF marker: truncated file' };
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
