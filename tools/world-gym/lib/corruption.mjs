/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Adversarial / negative-label corruption for World Gym models.
 *
 * v1's corpus was 100% positive-label (every model schema-valid, zero
 * clashes, all quantities present) - a reward channel over such a corpus is
 * a constant and cannot discriminate anything. This module produces models
 * with KNOWN-BY-CONSTRUCTION defects, recorded as independent ground truth
 * in the label so the labeler's detections can be validated against what
 * was actually planted (never circularly against the labeler itself).
 *
 * Two defect classes:
 *
 * 1. Build-time (need the live IfcCreator, applied after the family build):
 *    - `clash-pair`: 1-3 pairs of overlapping IfcFooting elements, placed
 *      at isolated plan positions outside the building footprint (and
 *      extending downward from z=0, below every slab) so each pair clashes
 *      ONLY with itself. IfcFooting is a type no clean family emits, so a
 *      footing self-clash rule fires exactly `pairs.length` times on a
 *      corrupted model and exactly 0 times on any clean one. Penetration
 *      depth per pair is drawn from the seed and recorded.
 *    - `degenerate-geometry`: 1-2 zero-height IfcColumn elements (extrusion
 *      depth 0), isolated the same way. The geometry pipeline drops them
 *      (no mesh emitted), so `meshedElementCount` falls short of the
 *      meshable-element count by exactly this number.
 *
 * 2. Text-level (deterministic STEP-text surgery on the serialized bytes,
 *    after toIfc()):
 *    - `duplicate-globalid`: second wall's GlobalId overwritten with the
 *      first wall's. Detected by validate's `unique-globalid` rule (error
 *      -> model invalid).
 *    - `missing-site`: the IFCSITE line is deleted outright. Detected by
 *      validate's `required-entity` rule (error) and leaves the
 *      project->site IfcRelAggregates dangling (parser-hardening territory).
 *    - `multiple-project`: the IFCPROJECT line is duplicated under a fresh
 *      express id (GlobalId reused - one defect at a time; the GUID dup is
 *      its own defect type). Detected by validate's `single-project` rule.
 *    - `dangling-ref`: one element reference inside an
 *      IfcRelContainedInSpatialStructure list is rewritten to #99999999
 *      (an id that does not exist). NOT detected by `ifc-lite validate`
 *      today - recorded as planted ground truth anyway, precisely so the
 *      defect-detection channel can measure that miss instead of hiding it.
 *    - `missing-quantities`: 1-3 IfcRelDefinesByProperties lines binding
 *      GymQuantities sets are deleted, leaving those elements with no
 *      quantity set. Detected by validate's `quantity-completeness`
 *      info/warning and by the quantity-accuracy channel (extracted totals
 *      fall short of ground truth).
 *
 * Everything is drawn from the `{seed}:corrupt` RNG stream, so corruption
 * is exactly as deterministic as generation: same seed in, same defects,
 * same bytes out.
 */

/** All defect types, in the fixed order the plan drawer samples from. */
export const DEFECT_TYPES = [
  'clash-pair',
  'degenerate-geometry',
  'duplicate-globalid',
  'missing-site',
  'multiple-project',
  'dangling-ref',
  'missing-quantities',
];

/**
 * Draw a corruption plan from the seed's corrupt stream: 1-3 distinct defect
 * types with per-defect parameters. Pure function of the rng state.
 */
export function drawDefectPlan(rng) {
  const defectCount = rng.int(1, 3);
  const pool = [...DEFECT_TYPES];
  const chosen = [];
  for (let i = 0; i < defectCount; i++) {
    const idx = rng.int(0, pool.length - 1);
    chosen.push(pool.splice(idx, 1)[0]);
  }
  // Fixed application order (build-time first, then text-level) regardless
  // of draw order, so the plan is order-canonical.
  chosen.sort((a, b) => DEFECT_TYPES.indexOf(a) - DEFECT_TYPES.indexOf(b));

  return chosen.map((type) => {
    switch (type) {
      case 'clash-pair':
        return { type, pairs: rng.int(1, 3), overlap: round3(rng.range(0.3, 0.7)) };
      case 'degenerate-geometry':
        return { type, count: rng.int(1, 2) };
      case 'missing-quantities':
        return { type, count: rng.int(1, 3) };
      default:
        return { type };
    }
  });
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

/**
 * Apply the build-time defects to the live creator (must run inside the
 * deterministic runtime, before toIfc()). Returns the ground-truth records.
 *
 * `footprint` is the family's {width, depth} so injections land strictly
 * outside the building in plan.
 */
export function applyBuildDefects(creator, storeyId, footprint, plan) {
  const records = [];
  const baseX = footprint.width + 10;

  for (const defect of plan) {
    if (defect.type === 'clash-pair') {
      const pairs = [];
      for (let k = 0; k < defect.pairs; k++) {
        const cx = round3(baseX + 4 * k);
        const cy = -8;
        const size = 1.0;
        const dx = round3(size - defect.overlap); // centre offset -> overlap depth = defect.overlap
        const aName = `GymClashA-${k}`;
        const bName = `GymClashB-${k}`;
        creator.addIfcFooting(storeyId, { Name: aName, Position: [cx, cy, 0], Width: size, Depth: size, Height: 1 });
        creator.addIfcFooting(storeyId, { Name: bName, Position: [round3(cx + dx), cy, 0], Width: size, Depth: size, Height: 1 });
        pairs.push({ a: aName, b: bName, penetration: defect.overlap });
      }
      records.push({ type: 'clash-pair', pairs });
    } else if (defect.type === 'degenerate-geometry') {
      const names = [];
      for (let k = 0; k < defect.count; k++) {
        const name = `GymDegenerate-${k}`;
        creator.addIfcColumn(storeyId, {
          Name: name,
          Position: [round3(baseX + 4 * k), -16, 0],
          Width: 0.3,
          Depth: 0.3,
          Height: 0,
        });
        names.push(name);
      }
      records.push({ type: 'degenerate-geometry', names });
    }
  }
  return records;
}

const LINE_RE = /^#(\d+)=([A-Z0-9_]+)\((.*)\);$/;

function maxExpressId(lines) {
  let max = 0;
  for (const line of lines) {
    const m = LINE_RE.exec(line);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/**
 * Apply the text-level defects to the serialized STEP content. Deterministic
 * pure string surgery. Returns { content, records }.
 */
export function applyTextDefects(content, plan) {
  const records = [];
  let lines = content.split('\n');

  for (const defect of plan) {
    switch (defect.type) {
      case 'duplicate-globalid': {
        const wallIdx = [];
        for (let i = 0; i < lines.length && wallIdx.length < 2; i++) {
          if (/^#\d+=IFCWALL\(/.test(lines[i])) wallIdx.push(i);
        }
        if (wallIdx.length < 2) break; // cannot apply; recorded as skipped below
        const guidOf = (line) => /\('([^']+)'/.exec(line)?.[1];
        const sourceGuid = guidOf(lines[wallIdx[0]]);
        const targetGuid = guidOf(lines[wallIdx[1]]);
        if (!sourceGuid || !targetGuid) break;
        // Replacer FUNCTION, not a replacement string: IFC GlobalIds use a
        // base64 alphabet that includes '$', which String.replace treats as
        // a substitution pattern in replacement strings ("$'" = portion
        // after the match). The 100k run surfaced exactly that: 120 models
        // whose "duplicate" GUID was silently garbled into a unique one.
        lines[wallIdx[1]] = lines[wallIdx[1]].replace(`'${targetGuid}'`, () => `'${sourceGuid}'`);
        records.push({ type: 'duplicate-globalid', guid: sourceGuid });
        break;
      }
      case 'missing-site': {
        const idx = lines.findIndex((l) => /^#\d+=IFCSITE\(/.test(l));
        if (idx === -1) break;
        const id = Number(LINE_RE.exec(lines[idx])[1]);
        lines.splice(idx, 1);
        records.push({ type: 'missing-site', removedExpressId: id });
        break;
      }
      case 'multiple-project': {
        const idx = lines.findIndex((l) => /^#\d+=IFCPROJECT\(/.test(l));
        if (idx === -1) break;
        const m = LINE_RE.exec(lines[idx]);
        const newId = maxExpressId(lines) + 1;
        // Give the duplicate project a DISTINCT GlobalId (first char
        // flipped, deterministic) so this defect is purely a
        // single-project violation and never doubles as an unplanned
        // duplicate-globalid - keeps defect types independently
        // verifiable (the IfcOpenShell oracle counts GUID-dup groups and
        // must see exactly the planted number).
        const guidMatch = /^'([^']+)'/.exec(m[3]);
        let body = m[3];
        if (guidMatch) {
          const guid = guidMatch[1];
          const altered = (guid[0] === '0' ? '1' : '0') + guid.slice(1);
          body = `'${altered}'${m[3].slice(guidMatch[0].length)}`;
        }
        lines.splice(idx + 1, 0, `#${newId}=IFCPROJECT(${body});`);
        records.push({ type: 'multiple-project', duplicateExpressId: newId });
        break;
      }
      case 'dangling-ref': {
        // Rewrite the LAST element ref in the first RelContainedInSpatialStructure list.
        const idx = lines.findIndex((l) => /^#\d+=IFCRELCONTAINEDINSPATIALSTRUCTURE\(/.test(l));
        if (idx === -1) break;
        const listMatch = /\(([^()]*#\d+[^()]*)\)/.exec(lines[idx].slice(lines[idx].indexOf('(') + 1));
        if (!listMatch) break;
        const refs = listMatch[1].match(/#\d+/g);
        if (!refs || refs.length === 0) break;
        const victim = refs[refs.length - 1];
        // Replace only the list occurrence (the last one in the line).
        const pos = lines[idx].lastIndexOf(victim);
        lines[idx] = `${lines[idx].slice(0, pos)}#99999999${lines[idx].slice(pos + victim.length)}`;
        records.push({ type: 'dangling-ref', originalRef: Number(victim.slice(1)), danglingRef: 99999999 });
        break;
      }
      case 'missing-quantities': {
        const qsetIds = new Set();
        for (const line of lines) {
          const m = /^#(\d+)=IFCELEMENTQUANTITY\(/.exec(line);
          if (m) qsetIds.add(m[1]);
        }
        const relIdx = [];
        for (let i = 0; i < lines.length; i++) {
          const m = /^#\d+=IFCRELDEFINESBYPROPERTIES\(.*#(\d+)\);$/.exec(lines[i]);
          if (m && qsetIds.has(m[1])) relIdx.push(i);
        }
        const toRemove = relIdx.slice(0, defect.count);
        const removed = [];
        for (let j = toRemove.length - 1; j >= 0; j--) {
          const m = LINE_RE.exec(lines[toRemove[j]]);
          removed.push(Number(m[1]));
          lines.splice(toRemove[j], 1);
        }
        if (removed.length > 0) {
          records.push({ type: 'missing-quantities', removedRelExpressIds: removed.sort((a, b) => a - b) });
        }
        break;
      }
      default:
        break; // build-time defects handled elsewhere
    }
  }

  return { content: lines.join('\n'), records };
}

/**
 * Derive the label-side expectations from the applied defect records - the
 * independent ground truth every reward channel is validated against.
 */
export function expectationsFromRecords(records) {
  const types = records.map((r) => r.type);
  const clashPairs = records
    .filter((r) => r.type === 'clash-pair')
    .flatMap((r) => r.pairs);
  const degenerate = records
    .filter((r) => r.type === 'degenerate-geometry')
    .flatMap((r) => r.names);
  const missingQto = records
    .filter((r) => r.type === 'missing-quantities')
    .reduce((n, r) => n + r.removedRelExpressIds.length, 0);
  const schemaErrorTypes = types.filter((t) =>
    t === 'duplicate-globalid' || t === 'missing-site' || t === 'multiple-project');

  return {
    schemaValid: schemaErrorTypes.length === 0,
    schemaErrorCount: schemaErrorTypes.length,
    clashPairCount: clashPairs.length,
    clashPairs,
    unmeshedElementCount: degenerate.length,
    degenerateElements: degenerate,
    missingQuantitySets: missingQto,
    undetectableBySchemaCheck: types.filter((t) => t === 'dangling-ref'),
  };
}
