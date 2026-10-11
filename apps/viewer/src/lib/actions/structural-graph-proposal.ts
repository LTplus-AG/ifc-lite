/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { isRecord, onlyKeys, requiredText } from '@/lib/check-authoring/proposal-json';
export const STRUCTURAL_OPS = ['structural.analysis.create', 'structural.member.create', 'structural.connection.create',
  'structural.group.create', 'structural.pointAction.create', 'structural.linearAction.create',
  'structural.member.connect', 'structural.activity.connect', 'structural.group.assign'] as const;
export type StructuralOpName = typeof STRUCTURAL_OPS[number];
export type StructuralRef = number | { ref: string };
export interface StructuralOperation { op: StructuralOpName; ref?: string; params?: Record<string, unknown>; storey?: StructuralRef; target?: StructuralRef; related?: StructuralRef[] }
export interface StructuralProposal { version: 1; kind: 'structural.graph'; title: string; modelId: string; nativeMeasuresAcknowledged: true; expected: unknown; operations: StructuralOperation[] }
const common = ['Name', 'Description', 'ObjectType', 'GlobalId'];
const parameterKeys: Record<string, string[]> = {
  'structural.analysis.create': [...common, 'PredefinedType', 'LoadGroupIds', 'ResultGroupIds'],
  'structural.member.create': [...common, 'Start', 'End', 'PredefinedType'],
  'structural.connection.create': [...common, 'Position', 'BoundaryCondition'],
  'structural.group.create': [...common, 'PredefinedType', 'ActionType', 'ActionSource', 'Coefficient', 'Purpose', 'SelfWeightCoefficients'],
  'structural.pointAction.create': [...common, 'GlobalOrLocal', 'DestabilizingLoad', 'LoadName', 'ForceX', 'ForceY', 'ForceZ', 'MomentX', 'MomentY', 'MomentZ'],
  'structural.linearAction.create': [...common, 'GlobalOrLocal', 'DestabilizingLoad', 'LoadName', 'ProjectedOrTrue', 'LinearForceX', 'LinearForceY', 'LinearForceZ', 'LinearMomentX', 'LinearMomentY', 'LinearMomentZ'],
};
const name = (value: unknown): string => { if (typeof value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(value)) throw new Error('Use a short unique operation reference name'); return value; };
export function structuralRef(value: unknown): StructuralRef {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (isRecord(value)) { onlyKeys(value, ['ref'], 'reference'); return { ref: name(value.ref) }; }
  throw new Error('Use a captured native expressId or earlier approved operation reference');
}
export function structuralSnapshotWork(value: unknown): void {
  const pending = [{ value, depth: 0 }]; let work = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++work > 12000 || item.depth > 20) throw new Error('The complete Structural snapshot exceeds the review limit');
    const values = Array.isArray(item.value) ? item.value : isRecord(item.value) ? Object.values(item.value) : null;
    if (values) { if (values.length > (Array.isArray(item.value) ? 1000 : 40)) throw new Error('Too many native snapshot fields'); for (const value of values) pending.push({ value, depth: item.depth + 1 }); }
    else if (typeof item.value === 'number' && !Number.isFinite(item.value)) throw new Error('Snapshot numbers must be finite');
    else if (item.value !== null && item.value !== undefined && !['string', 'boolean', 'number'].includes(typeof item.value)) throw new Error('Supply native JSON snapshot evidence');
  }
}
const text = (value: unknown): string => { if (typeof value !== 'string' || value.length > 2000 || Array.from(value).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw new Error('Native text must be bounded'); return value; };
const finite = (value: unknown): number => { if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Supply a finite native measure'); return value; };
const boolean = (value: unknown): boolean => { if (typeof value !== 'boolean') throw new Error('Supply an explicit native boolean'); return value; };
function params(value: unknown, op: StructuralOpName): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Supply explicit native params');
  onlyKeys(value, parameterKeys[op], 'native params');
  const parsed: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (['LoadGroupIds', 'ResultGroupIds'].includes(key)) { if (!Array.isArray(item) || item.length > 200) throw new Error('Supply at most 200 native refs'); parsed[key] = item.map(structuralRef); }
    else if (['Start', 'End', 'Position', 'SelfWeightCoefficients'].includes(key)) { if (!Array.isArray(item) || item.length !== 3) throw new Error(`${key} needs three finite components`); parsed[key] = item.map(finite); }
    else if (key === 'BoundaryCondition') {
      if (!isRecord(item)) throw new Error('Supply a native boundary condition');
      onlyKeys(item, ['Name', 'TranslationalStiffnessX', 'TranslationalStiffnessY', 'TranslationalStiffnessZ', 'RotationalStiffnessX', 'RotationalStiffnessY', 'RotationalStiffnessZ'], key);
      parsed[key] = Object.fromEntries(Object.entries(item).map(([k, v]) => [k, k === 'Name' ? text(v) : typeof v === 'boolean' ? v : finite(v)]));
    } else if (['DestabilizingLoad', 'ProjectedOrTrue'].includes(key)) parsed[key] = boolean(item);
    else if (key === 'Coefficient' || /^(?:Linear)?(?:Force|Moment)[XYZ]$/.test(key)) parsed[key] = finite(item);
    else parsed[key] = text(item);
  }
  if (typeof parsed.Name !== 'string' || !parsed.Name.length) throw new Error('Every supplied native owner requires an explicit Name');
  if (op === 'structural.member.create' && (!parsed.Start || !parsed.End) || op === 'structural.connection.create' && !parsed.Position) throw new Error('Supply native member endpoints or connection position');
  if (op === 'structural.group.create' && (typeof parsed.ActionType !== 'string' || typeof parsed.ActionSource !== 'string')) throw new Error('Load group requires supplied native ActionType and ActionSource');
  return parsed;
}
export function declaresStructuralGraph(content: string): boolean { return /"kind"\s*:\s*"structural\.graph"/.test(content); }
export function parseStructuralProposal(content: string): StructuralProposal {
  if (content.length > 100000) throw new Error('Structural proposal too large');
  const trimmed = content.trim(), fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  const value: unknown = JSON.parse(fenced ? fenced[1] : trimmed);
  if (!isRecord(value) || value.version !== 1 || value.kind !== 'structural.graph') throw new Error('Expected version 1 Structural graph');
  onlyKeys(value, ['version', 'kind', 'title', 'modelId', 'nativeMeasuresAcknowledged', 'expected', 'operations'], 'Structural proposal');
  if (value.nativeMeasuresAcknowledged !== true) throw new Error('Explicitly acknowledge verbatim native load/stiffness fields; no unit conversion is performed');
  if (!isRecord(value.expected)) throw new Error('Attach the complete current native Structural snapshot');
  structuralSnapshotWork(value.expected);
  if (!Array.isArray(value.operations) || !value.operations.length || value.operations.length > 200) throw new Error('Choose 1..200 supplied operations');
  const refs = new Set<string>(); let referenceWork = 0;
  const validate = (ref: StructuralRef) => { if (++referenceWork > 200) throw new Error('Too many operation references'); if (typeof ref !== 'number' && !refs.has(ref.ref)) throw new Error('Only earlier approved creation references are supported'); };
  const operations = value.operations.map((raw): StructuralOperation => {
    if (!isRecord(raw) || !STRUCTURAL_OPS.includes(raw.op as StructuralOpName)) throw new Error('Unsupported native Structural operation');
    const op = raw.op as StructuralOpName, create = op in parameterKeys, placed = ['structural.member.create', 'structural.connection.create'].includes(op);
    onlyKeys(raw, create ? ['op', 'ref', 'params', ...(placed ? ['storey'] : [])] : ['op', 'target', 'related', 'ref'], op);
    const operation: StructuralOperation = { op };
    if (create) operation.params = params(raw.params, op);
    if (placed) { operation.storey = structuralRef(raw.storey); validate(operation.storey); }
    if (!create) {
      operation.target = structuralRef(raw.target); validate(operation.target);
      if (!Array.isArray(raw.related) || !raw.related.length || raw.related.length > 200 || op !== 'structural.group.assign' && raw.related.length !== 1) throw new Error('Supply the explicit native related reference population');
      operation.related = raw.related.map(structuralRef); operation.related.forEach(validate);
    }
    for (const key of ['LoadGroupIds', 'ResultGroupIds']) if (Array.isArray(operation.params?.[key])) for (const ref of operation.params[key]) validate(structuralRef(ref));
    if (raw.ref !== undefined) { operation.ref = name(raw.ref); if (refs.has(operation.ref)) throw new Error('Operation ref must be unique'); refs.add(operation.ref); }
    return operation;
  });
  return { version: 1, kind: 'structural.graph', title: requiredText(value, 'title', 'Structural proposal', 200), modelId: requiredText(value, 'modelId', 'Structural proposal', 200), nativeMeasuresAcknowledged: true, expected: value.expected, operations };
}
export const STRUCTURAL_GRAPH_GUIDANCE = `Explicit supplied analytical models use version 1 kind "structural.graph", title, one modelId, nativeMeasuresAcknowledged:true, complete nativeStructural.expected and operations. Native refs are captured expressIds or {ref:"earlierName"}. Supported operations structural.analysis.create, structural.member.create, structural.connection.create, structural.group.create, structural.pointAction.create, structural.linearAction.create (native PascalCase params, optional ref; member/connection require storey); structural.member.connect (member target, one connection related); structural.activity.connect (item target, one activity related); structural.group.assign (group target, related objects). Start/End/Position are metres in the canonical source storey-local IFC Z-up frame. Forces/moments/stiffness are verbatim native model measures: disclose missing declarations, never assume N/Nm or convert. Supply explicit load/restraint values, no structural design, load inference, compliance claim or solver. Use only complete available evidence: rich source expectedJsonParts must be joined and parsed without missing/truncated parts; explicit attachment carries expected. Never mutate on missing/truncated evidence. Proposal only; explicit user review and Apply are required.`;
