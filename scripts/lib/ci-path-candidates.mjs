/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { matchesAny } from './ci-path-coverage.mjs';

/**
 * Resolve candidate input nodes, then account for exact and glob exemptions.
 * The walk is scoped to this census so one input's directory cache cannot leak
 * into another checkout used by the fixture tests.
 */
export function findViolations({ root, workflowDir, isIgnored, gateInputs, allow }) {
  const abs = (p) => join(root, p);

  /** Files under a repo-relative path. Only walked when no glob covers the subtree. */
  const walkCache = new Map();
  function filesUnder(rel) {
    const hit = walkCache.get(rel);
    if (hit) return hit;
    const out = walkUncached(rel);
    walkCache.set(rel, out);
    return out;
  }

  function walkUncached(rel) {
    // Asked about an ignored node directly: it is not committed, so it
    // contributes no files. Belt and braces -- the caller's derivation already
    // declines to hand an ignored path to the walk, so nothing observable
    // depends on this line today. It is here because the old skip set filtered
    // only a walk's CHILDREN and never the root it was asked about, which is the
    // shape that let `node_modules` be enumerated once the derivation admitted
    // it; a future change to the derivation must not be able to reopen it.
    if (isIgnored(rel)) return [];
    const target = abs(rel);
    let st;
    try {
      st = statSync(target);
    } catch {
      return [];
    }
    if (!st.isDirectory()) return [rel];
    const out = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') && dir === target && rel !== workflowDir) continue;
        const full = join(dir, entry.name);
        const child = relative(root, full).split(sep).join('/');
        if (isIgnored(child)) continue;
        if (entry.isDirectory()) walk(full);
        else out.push(child);
      }
    };
    walk(target);
    return out;
  }

  /**
   * The SHALLOWEST uncovered nodes under `rel` -- a whole directory when nothing
   * inside it is reachable, individual files when only some of it is.
   *
   * Granularity is the difference between a usable report and an unusable one:
   * `apps` un-reduced yields 27 file lines that all say the same thing, and the
   * one line worth reading (`apps/landing`) is buried among the favicons. It is
   * also the granularity an exemption should be written at.
   */
  function uncoveredNodes(rel, globs) {
    if (matchesAny(rel, globs)) return [];
    const files = filesUnder(rel);
    if (files.length === 0) return [];
    if (files.length === 1 && files[0] === rel) return [rel];
    if (files.every((f) => !matchesAny(f, globs))) return [rel];

    const byChild = new Map();
    for (const f of files) {
      if (matchesAny(f, globs)) continue;
      const slash = f.indexOf('/', rel.length + 1);
      // No further separator: `f` is a FILE directly in `rel`, so it is its own
      // node. Slicing at -1 here silently truncated the last character and
      // reported paths that do not exist.
      const key = slash === -1 ? f : f.slice(0, slash);
      if (!byChild.has(key)) byChild.set(key, []);
      byChild.get(key).push(f);
    }
    const out = [];
    for (const [child, uncovered] of byChild) {
      if (child === rel) continue;
      const all = filesUnder(child);
      if (all.length === uncovered.length) out.push(child);
      else out.push(...uncoveredNodes(child, globs));
    }
    return out;
  }

  const violations = [];
  for (const [gate, info] of gateInputs) {
    if (info.globs === null) continue; // job has no path filter: everything reaches it
    for (const input of info.inputs) {
      const uncovered = uncoveredNodes(input, info.globs);
      // An exact exemption describes the inferred input itself (for example a
      // temporary staging directory). Partial trigger coverage can split that
      // input into children, but cannot turn it into a repository read. Keep the
      // existing exemption's meaning; fully covered inputs still make it stale.
      const wholeInput = allow.find((a) => a.gate === gate && a.glob === input);
      if (wholeInput && uncovered.length > 0) {
        wholeInput.used = true;
        continue;
      }
      for (const node of uncovered) {
        const hit = allow.find((a) => a.gate === gate && matchesAny(node, [a.glob]));
        if (hit) {
          hit.used = true;
          continue;
        }
        if (!violations.some((v) => v.gate === gate && v.file === node)) {
          violations.push({ gate, file: node, sites: [...new Set(info.sites)] });
        }
      }
    }
  }
  return violations;
}
