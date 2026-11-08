/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A small STEP reader for the UI probes' oracles (#9296).
 *
 * A probe exports the model through the viewer's own Export dialog, then asks
 * this reader what is in the file: how many walls, which storey holds them,
 * their base quantities, which openings a door fills. It reads entity
 * instances only (`#id=TYPE(args);`), which is all an oracle needs, and keeps
 * the arguments as parsed values: numbers, strings, `#refs`, lists, `$` and `*`.
 */

/** Split a STEP argument list into values, respecting strings and nested lists. */
export function parseArgs(text) {
  let i = 0;
  const value = () => {
    while (text[i] === ' ') i++;
    const c = text[i];
    if (c === '(') {
      i++;
      const list = [];
      while (text[i] !== ')') {
        list.push(value());
        while (text[i] === ' ') i++;
        if (text[i] === ',') i++;
      }
      i++;
      return list;
    }
    if (c === "'") {
      let s = '';
      i++;
      for (;;) {
        if (text[i] === "'" && text[i + 1] === "'") { s += "'"; i += 2; continue; }
        if (text[i] === "'") { i++; break; }
        s += text[i++];
      }
      return s;
    }
    if (c === '#') {
      const m = /^#(\d+)/.exec(text.slice(i));
      i += m[0].length;
      return { ref: Number(m[1]) };
    }
    if (c === '$' || c === '*') { i++; return c === '$' ? null : '*'; }
    if (c === '.') {
      const end = text.indexOf('.', i + 1);
      const e = text.slice(i, end + 1);
      i = end + 1;
      return { enum: e.slice(1, -1) };
    }
    // Typed value such as IFCLENGTHMEASURE(3.) or a bare number.
    const m = /^([A-Z0-9_]+)\(/.exec(text.slice(i));
    if (m) {
      i += m[0].length - 1;
      const inner = value();
      return { type: m[1], value: inner.length === 1 ? inner[0] : inner };
    }
    const n = /^[-+0-9.Ee]+/.exec(text.slice(i));
    if (n) { i += n[0].length; return Number(n[0]); }
    throw new Error(`STEP parse error at ${i}: ${text.slice(i, i + 40)}`);
  };
  const out = value();
  return out;
}

/** Parse a STEP file into `{ schema, entities: Map<id, {id, type, args}>, byType }`. */
export function readStep(text) {
  const schema = /FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/.exec(text)?.[1] ?? null;
  const entities = new Map();
  const byType = new Map();
  const data = text.slice(text.indexOf('DATA;') + 5);
  // Records end with ");" at line end; strings may hold ";" so split on the record pattern.
  const re = /#(\d+)\s*=\s*([A-Z0-9_]+)\s*(\([\s\S]*?\));\s*(?=#\d+\s*=|ENDSEC;)/g;
  for (let m = re.exec(data); m; m = re.exec(data)) {
    const id = Number(m[1]);
    const type = m[2];
    const args = parseArgs(m[3].replace(/\r?\n/g, ''));
    const entity = { id, type, args };
    entities.set(id, entity);
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(entity);
  }
  const of = (type) => byType.get(type.toUpperCase()) ?? [];
  const get = (ref) => (ref && typeof ref === 'object' && 'ref' in ref ? entities.get(ref.ref) : entities.get(ref));
  return {
    schema,
    entities,
    byType,
    of,
    get,
    count: (type) => of(type).length,
    /** Every element type from a list with its count, zeros included. */
    counts(types) { return Object.fromEntries(types.map((t) => [t, of(t).length])); },
    /** Storeys as `{ id, name, elevation }`, sorted by elevation. */
    storeys() {
      return of('IFCBUILDINGSTOREY').map((s) => ({ id: s.id, guid: s.args?.[0], name: s.args?.[2], elevation: s.args?.[9] }))
        .sort((a, b) => (a.elevation ?? 0) - (b.elevation ?? 0));
    },
    /** Map element id -> spatial container id. */
    containment() {
      const map = new Map();
      for (const rel of of('IFCRELCONTAINEDINSPATIALSTRUCTURE')) {
        for (const r of rel.args?.[4] ?? []) map.set(r.ref, rel.args[5]?.ref);
      }
      return map;
    },
    /** Named quantities of an element via IfcRelDefinesByProperties -> IfcElementQuantity. */
    quantities(elementId) {
      const out = {};
      for (const rel of of('IFCRELDEFINESBYPROPERTIES')) {
        if (!(rel.args?.[4] ?? []).some((r) => r.ref === elementId)) continue;
        const def = get(rel.args[5]);
        if (def?.type !== 'IFCELEMENTQUANTITY') continue;
        for (const q of def.args?.[5] ?? []) {
          const qe = get(q);
          if (qe?.type.startsWith('IFCQUANTITY')) out[qe.args[0]] = qe.args[3];
        }
      }
      return out;
    },
    /**
     * World placement of a product as `{ origin:[x,y,z], xDir:[x,y] }`, composing its
     * IfcLocalPlacement chain. Assumes Z-up placements (rotation about Z only), which
     * is what the viewer writes for walls, slabs and columns.
     */
    placement(entityId) {
      const compose = (ref) => {
        const lp = get(ref);
        if (lp?.type === 'IFCGRIDPLACEMENT') return gridPoint(lp);
        if (!lp || lp.type !== 'IFCLOCALPLACEMENT') return { o: [0, 0, 0], x: [1, 0] };
        const parent = lp.args[0] ? compose(lp.args[0]) : { o: [0, 0, 0], x: [1, 0] };
        const ax = get(lp.args[1]);
        const loc = get(ax?.args?.[0])?.args?.[0] ?? [0, 0, 0];
        const rd = ax?.args?.[2] ? get(ax.args[2])?.args?.[0] : [1, 0, 0];
        const [px, py] = parent.x;
        const o = [parent.o[0] + loc[0] * px - loc[1] * py, parent.o[1] + loc[0] * py + loc[1] * px, parent.o[2] + (loc[2] ?? 0)];
        const n = Math.hypot(rd[0], rd[1]) || 1;
        const lx = [rd[0] / n, rd[1] / n];
        return { o, x: [lx[0] * px - lx[1] * py, lx[0] * py + lx[1] * px] };
      };
      // IfcGridPlacement: the intersection of two grid axes, in the grid's own placement.
      const gridPoint = (gp) => {
        const vgi = get(gp.args[0]);
        const [ra, rb] = vgi?.args?.[0] ?? [];
        const grid = of('IFCGRID').find((g) => [...(g.args?.[7] ?? []), ...(g.args?.[8] ?? []), ...(g.args?.[9] ?? [])].some((r) => r.ref === ra?.ref));
        const line = (axisRef) => get(get(axisRef)?.args?.[1])?.args?.[0]?.map((p) => get(p).args[0]);
        const a = line(ra); const b = line(rb);
        if (!grid || !a || !b) return { o: [0, 0, 0], x: [1, 0] };
        const [p1, p2] = a; const [p3, p4] = b;
        const d = (p1[0] - p2[0]) * (p3[1] - p4[1]) - (p1[1] - p2[1]) * (p3[0] - p4[0]);
        if (Math.abs(d) < 1e-12) return { o: [0, 0, 0], x: [1, 0] };
        const t = ((p1[0] - p3[0]) * (p3[1] - p4[1]) - (p1[1] - p3[1]) * (p3[0] - p4[0])) / d;
        const u = [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])];
        const g = compose(grid.args[5]);
        const [gx, gy] = g.x;
        return { o: [g.o[0] + u[0] * gx - u[1] * gy, g.o[1] + u[0] * gy + u[1] * gx, g.o[2]], x: g.x };
      };
      const e = entities.get(entityId);
      const { o, x } = compose(e?.args?.[5]);
      return { origin: o, xDir: x };
    },
    /** Wall axes in world metres: `{ id, start:[x,y], end:[x,y], z, length }` from the Axis polyline. */
    wallAxes() {
      const out = [];
      for (const w of [...of('IFCWALL'), ...of('IFCWALLSTANDARDCASE')]) {
        const shape = get(w.args?.[6]);
        const axisRep = (shape?.args?.[2] ?? []).map(get).find((r) => r?.args?.[1] === 'Axis');
        const poly = axisRep && get(axisRep.args[3]?.[0]);
        if (!poly || poly.type !== 'IFCPOLYLINE') continue;
        const pts = poly.args[0].map((p) => get(p).args[0]);
        const { origin, xDir } = this.placement(w.id);
        const toWorld = ([u, v]) => [origin[0] + u * xDir[0] - v * xDir[1], origin[1] + u * xDir[1] + v * xDir[0]];
        const start = toWorld(pts[0]);
        const end = toWorld(pts.at(-1));
        out.push({ id: w.id, start, end, z: origin[2], length: Math.hypot(end[0] - start[0], end[1] - start[1]) });
      }
      return out;
    },
    /**
     * The element an opening filler (door, window) is hosted in: filler -> IfcRelFillsElement ->
     * opening -> IfcRelVoidsElement -> host. Null when any link is missing.
     */
    hostOf(fillerId) {
      const fill = of('IFCRELFILLSELEMENT').find((r) => r.args?.[5]?.ref === fillerId);
      const opening = fill?.args?.[4]?.ref;
      const voids = opening && of('IFCRELVOIDSELEMENT').find((r) => r.args?.[5]?.ref === opening);
      return voids?.args?.[4]?.ref ?? null;
    },
    /** Pairs of related ids for a two-sided relationship (relating index, related index). */
    pairs(type, a, b) {
      return of(type).map((r) => [r.args?.[a]?.ref, r.args?.[b]?.ref]);
    },
  };
}
