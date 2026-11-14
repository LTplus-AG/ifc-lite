/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #9668: real derivation against the AxisVM roof truss, in world metres. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStore } from '../lib/packages.mjs';
import { readStep } from '../lib/step.mjs';
import { boundedSpawnSync } from '../../../scripts/lib/bounded-process.mjs';

export const FRAME = 'structural/ifc_structuralanalysisview/roof_truss--Axis-Struc.ifc';
// Partial credit requires at least 90% of members to match, including physical links.
const MIN_MEMBER_MATCH_RATIO = 0.9;
const TOLERANCE = 0.001; // one millimetre, including endpoint and line-axis drift
const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
const minus = (a, b) => a.map((v, i) => v - b[i]);
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const unit = (v) => v.map((x) => x / Math.hypot(...v));

/** Independent STEP geometry oracle. Refuse unsupported topology and cyclic placements. */
function referenceGeometry(step) {
  const get = (ref) => { const e = step.get(ref); if (!e) throw new Error(`missing reference ${JSON.stringify(ref)}`); return e; };
  const point = (ref) => get(ref).args[0];
  const transform = (p, placement, seen = new Set()) => {
    if (!placement) return p;
    const local = get(placement);
    if (seen.has(local.id)) throw new Error('cyclic placement');
    seen.add(local.id);
    if (local.type !== 'IFCLOCALPLACEMENT') throw new Error(`unsupported placement ${local.type}`);
    const axis = get(local.args[1]);
    const z = axis.args[1] ? unit(point(axis.args[1])) : [0,0,1];
    const x = axis.args[2] ? unit(point(axis.args[2])) : [1,0,0];
    const y = unit(cross(z,x));
    const o = point(axis.args[0]);
    return transform(o.map((v,i) => v + x[i]*p[0]+y[i]*p[1]+z[i]*p[2]), local.args[0], seen);
  };
  const topology = (e) => {
    const shape = get(e.args[6]);
    const rep = get(shape.args[2][0]);
    return get(rep.args[3][0]);
  };
  const vertex = (ref) => point(get(ref).args[0]);
  const links = new Map();
  const add = (item, product) => {
    if (!links.has(item)) links.set(item, new Set());
    links.get(item).add(product);
  };
  for (const r of step.of('IFCRELCONNECTSSTRUCTURALELEMENT')) add(r.args[5].ref, r.args[4].ref);
  for (const r of step.of('IFCRELASSIGNSTOPRODUCT')) {
    for (const item of r.args[4] ?? []) if (get(item).type.startsWith('IFCSTRUCTURAL')) add(item.ref, r.args[6].ref);
  }
  const members = step.of('IFCSTRUCTURALCURVEMEMBER').map((e) => {
    const edge = topology(e);
    if (!['IFCEDGE', 'IFCEDGECURVE'].includes(edge.type)) throw new Error(`unsupported edge ${edge.type}`);
    return { id: e.id, ends: edge.args.slice(0,2).map((v) => transform(vertex(v), e.args[5])), links: [...(links.get(e.id) ?? [])].sort((a,b)=>a-b) };
  });
  const nodes = step.of('IFCSTRUCTURALPOINTCONNECTION').map((e) => {
    if (!e.args[6]) return { id:e.id, position:transform([0,0,0],e.args[5]) };
    const t = topology(e);
    const p = t.type === 'IFCVERTEXPOINT' ? vertex({ref:t.id}) : point({ref:t.id});
    return { id:e.id, position:transform(p,e.args[5]) };
  });
  // A reference node's physical counterparts are the physical products of
  // its incident authored members, even when the file omits direct node links.
  for (const node of nodes) {
    const physical = new Set(links.get(node.id) ?? []);
    for (const r of [...step.of('IFCRELCONNECTSSTRUCTURALMEMBER'), ...step.of('IFCRELCONNECTSWITHECCENTRICITY')]) {
      if (r.args[5]?.ref !== node.id) continue;
      for (const id of links.get(r.args[4]?.ref) ?? []) physical.add(id);
    }
    node.links = [...physical].sort((a,b)=>a-b);
  }
  return { members, nodes };
}

/** Both directions matter: missing or extra members/nodes must fail too. */
export function compareDerived(actual, expected) {
  const problems = [];
  if (!expected.members.length || !expected.nodes.length) problems.push('reference has no members or connections');
  const matches = (a,b) => {
    const endError = Math.min(Math.max(distance(a.ends[0],b.ends[0]),distance(a.ends[1],b.ends[1])), Math.max(distance(a.ends[0],b.ends[1]),distance(a.ends[1],b.ends[0])));
    const axisError = Math.hypot(...cross(unit(minus(a.ends[1],a.ends[0])),unit(minus(b.ends[1],b.ends[0]))));
    return endError <= TOLERANCE && axisError <= TOLERANCE && JSON.stringify(a.links) === JSON.stringify(b.links);
  };
  const remaining = new Set(actual.members);
  let matchedMembers = 0;
  for (const ref of expected.members) {
    const hit = [...remaining].find((a) => matches(a,ref));
    if (hit) { remaining.delete(hit); matchedMembers++; }
    else problems.push(`reference member #${ref.id}: no derived match for ends ${JSON.stringify(ref.ends)}, axis and physical links ${JSON.stringify(ref.links)}`);
  }
  for (const extra of remaining) problems.push(`extra derived member #${extra.id}: ${JSON.stringify(extra)}`);
  const nodes = new Set(actual.nodes);
  for (const ref of expected.nodes) {
    const hit = [...nodes].find((a) => distance(a.position,ref.position) <= TOLERANCE && JSON.stringify(a.links) === JSON.stringify(ref.links));
    if (hit) nodes.delete(hit); else problems.push(`reference connection #${ref.id}: no derived point with links ${JSON.stringify(ref.links)} within ${TOLERANCE} m at ${JSON.stringify(ref.position)}`);
  }
  for (const extra of nodes) problems.push(`extra derived connection #${extra.id} at ${JSON.stringify(extra.position)}`);
  const memberMatchRatio = matchedMembers / Math.max(1, expected.members.length, actual.members.length);
  const status = !expected.members.length || !expected.nodes.length || memberMatchRatio < MIN_MEMBER_MATCH_RATIO
    ? 'fail' : problems.length ? 'partial' : 'pass';
  return { status, reason: problems.join('; '), mismatches: problems, toleranceMetres: TOLERANCE, axisSineTolerance: TOLERANCE, counts: { matchedMembers, memberMatchRatio, referenceMembers: expected.members.length, derivedMembers: actual.members.length, referenceNodes: expected.nodes.length, derivedNodes: actual.nodes.length } };
}

/** The file without its authored analytical graph: physical geometry, ids and properties kept. */
export function physicalOnly(file) {
    const removed = new Set([...file.step.entities.values()].filter((e) => e.type.startsWith('IFCSTRUCTURAL')).map((e)=>e.id));
    const referencesRemoved = (value) => Array.isArray(value) ? value.some(referencesRemoved)
      : value !== null && typeof value === 'object' && 'ref' in value && removed.has(value.ref);
    for (const e of file.step.entities.values()) {
      if (e.type.startsWith('IFCREL') && e.args.some(referencesRemoved)) removed.add(e.id);
    }
    return file.bytes.toString('latin1').replace(/#(\d+)\s*=\s*[^;]*;/g,
      (record,id)=>removed.has(Number(id)) ? '' : record);
}

/** STEP text parsed into an editable session; `text()` exports it with its edits. */
export async function editSession(ctx,input,schema) {
    const store = await parseStore(ctx.pkgs, input);
    const view = new ctx.pkgs.mutations.MutablePropertyView(null,'probe');
    view.setOnDemandExtractor((id)=>ctx.pkgs.parser.extractPropertiesOnDemand(store,id));
    const editor = new ctx.pkgs.mutations.StoreEditor(store,view);
    const text = () => {
      const {content} = new ctx.pkgs.exporter.StepExporter(store,view).export({schema,applyMutations:true});
      return typeof content === 'string' ? content : new TextDecoder().decode(content);
    };
    return {store,view,editor,text};
}

/** Derive an analytical model into the physical-only file and export it as STEP text. */
export async function deriveInto(ctx,file) {
    // Apply's normal no-existing-model path.
    const {store,editor,text} = await editSession(ctx,physicalOnly(file),file.schema);
    const facts = ctx.pkgs.create.readStructuralDerivationFacts(store,editor);
    const plan = ctx.pkgs.create.planStructuralDerivation(facts);
    ctx.pkgs.create.applyStructuralDerivation(editor,store,plan);
    return text();
}

export async function measureDerivation(ctx,file) {
    const expected = referenceGeometry(file.step);
    return {actual:referenceGeometry(readStep(await deriveInto(ctx,file))),expected};
}

export const derive = {
  name:'capability:derive-analytical-model', level:'capability', covers:(r)=>r.id==='cap/derive-analytical-model',
  async run(rows,ctx) {
    const file = ctx.corpus.files.find((f)=>f.path===FRAME);
    if (!file) return new Map(rows.map((r)=>[r.id,ctx.corpus.nothingFound(`is ${FRAME}`)]));
    const {actual,expected} = await measureDerivation(ctx,file);
    const result = compareDerived(actual,expected);
    const report = 'tests/structural-coverage/.out/derive-comparison.json';
    mkdirSync(join(ctx.root, 'tests/structural-coverage/.out'), { recursive:true });
    writeFileSync(join(ctx.root,report), JSON.stringify({ ...result, actual, expected },null,2) + '\n');
    result.evidence = [FRAME, report];
    return new Map(rows.map((r)=>[r.id,result]));
  },
};

export const toggle = {
  name:'capability:analytical-physical-toggle', level:'capability', covers:(r)=>r.id==='cap/analytical-physical-toggle',
  async run(rows,ctx) {
    const file = ctx.corpus.files.find((f)=>f.path===FRAME);
    if (!file) return new Map(rows.map((r)=>[r.id,ctx.corpus.nothingFound(`is ${FRAME}`)]));
    const products = [...file.step.entities.values()].filter((e)=> /^(IFCBEAM|IFCCOLUMN|IFCSTRUCTURAL(CURVEMEMBER|POINTCONNECTION))$/.test(e.type));
    const expected = {
      physical: products.filter((e)=>!e.type.startsWith('IFCSTRUCTURAL')).map((e)=>e.id),
      analytical: products.filter((e)=>e.type.startsWith('IFCSTRUCTURAL')).map((e)=>e.id),
    };
    // Run the viewer's real store and hook under its existing Node/Vite adapter.
    const run = boundedSpawnSync('pnpm',['exec','tsx','--tsconfig','apps/viewer/tsconfig.json','--import','./apps/viewer/src/test/vite-module-hooks.mjs','apps/viewer/src/test/structural-capability-driver.ts',JSON.stringify(expected)],{cwd:ctx.root,encoding:'utf8',timeout:120000,maxBuffer:1024*1024});
    const line = run.stdout?.split('\n').find((l)=>l.startsWith('CAP_TOGGLE='));
    const result = run.status===0 && line ? JSON.parse(line.slice(11)) : {status:'fail',reason:`viewer toggle probe failed: ${run.stderr || run.stdout || run.error}`};
    return new Map(rows.map((r)=>[r.id,result]));
  },
};
