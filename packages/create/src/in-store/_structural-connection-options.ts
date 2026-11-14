/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { StoreEditor } from '@ifc-lite/mutations';
export interface StructuralMemberConnectionOptions {
  AdditionalConditions?: { Type: 'IfcFailureConnectionCondition'; Name?: string; TensionFailureX?: number; TensionFailureY?: number; TensionFailureZ?: number; CompressionFailureX?: number; CompressionFailureY?: number; CompressionFailureZ?: number }
    | { Type: 'IfcSlippageConnectionCondition'; Name?: string; SlippageX?: number; SlippageY?: number; SlippageZ?: number };
  ConnectionConstraint?: { PointOnRelatingElement: [number, number, number]; PointOnRelatedElement?: [number, number, number]; EccentricityInX: number; EccentricityInY: number; EccentricityInZ: number };
}
/** Validate the entire optional graph before emitting its exclusively owned resources. */
export function prepareMemberConnection(options: StructuralMemberConnectionOptions) {
  const c = options.AdditionalConditions;
  if (c !== undefined && (c === null || typeof c !== 'object' || Array.isArray(c))) throw new Error('connectStructuralMemberToConnectionInStore: AdditionalConditions must be a condition object');
  const fields = c?.Type === 'IfcFailureConnectionCondition' ? ['TensionFailureX', 'TensionFailureY', 'TensionFailureZ', 'CompressionFailureX', 'CompressionFailureY', 'CompressionFailureZ'] : ['SlippageX', 'SlippageY', 'SlippageZ'];
  if (c && !['IfcFailureConnectionCondition', 'IfcSlippageConnectionCondition'].includes(c.Type)) throw new Error('connectStructuralMemberToConnectionInStore: unsupported AdditionalConditions.Type');
  if (c) {
    const unknown = Object.keys(c).find(key => key !== 'Type' && key !== 'Name' && !fields.includes(key));
    if (unknown !== undefined) throw new Error(`connectStructuralMemberToConnectionInStore: unknown AdditionalConditions attribute ${unknown} for ${c.Type}`);
  }
  const values = c ? fields.map(k => Reflect.get(c, k)) : [];
  if (values.some(v => v !== undefined && (typeof v !== 'number' || !Number.isFinite(v)))) throw new Error('connectStructuralMemberToConnectionInStore: condition values must be finite');
  const e = options.ConnectionConstraint;
  if (e !== undefined && (e === null || typeof e !== 'object' || Array.isArray(e))) throw new Error('connectStructuralMemberToConnectionInStore: ConnectionConstraint must be a constraint object');
  if (e && ([e.PointOnRelatingElement, ...(e.PointOnRelatedElement !== undefined ? [e.PointOnRelatedElement] : [])].some(p => !Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite)) || ![e.EccentricityInX, e.EccentricityInY, e.EccentricityInZ].every(Number.isFinite))) throw new Error('connectStructuralMemberToConnectionInStore: eccentricity needs finite points and offsets');
  return (editor: StoreEditor) => {
    const attrs: Parameters<StoreEditor['addEntity']>[1] = [c?.Name ?? null, ...values.map(v => v === undefined ? null : { real: v })];
    const additional = !c ? undefined : c.Type === 'IfcFailureConnectionCondition'
      ? editor.addEntity('IfcFailureConnectionCondition', attrs).expressId
      : editor.addEntity('IfcSlippageConnectionCondition', attrs).expressId;
    const point = (p: number[]) => `#${editor.addEntity('IfcCartesianPoint', [p.map(real => ({ real }))]).expressId}`;
    const constraint = e ? editor.addEntity('IfcConnectionPointEccentricity', [point(e.PointOnRelatingElement), e.PointOnRelatedElement !== undefined ? point(e.PointOnRelatedElement) : null, ...[e.EccentricityInX, e.EccentricityInY, e.EccentricityInZ].map(real => ({ real }))]).expressId : undefined;
    return { additional, constraint };
  };
}
