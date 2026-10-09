/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The before → after text of one reviewed authoring row. Values are data
 * (IFC names, numbers with the batch's declared unit symbol); the words
 * around them come from the catalogue.
 */

import { sectionGhostOmissions } from '@/lib/profile-section/profile-outline';
import type { TranslationKey, TranslationParameters } from '@/i18n';
import type { AuthoringOp, ModelAuthoringBatch } from '@/lib/actions/model-authoring';
import type { AuthoringRow } from '@/lib/actions/model-authoring-preview';

type T = (key: TranslationKey, params?: TranslationParameters) => string;

export interface RowSummary { subject: string; before: string; after: string; previewNote?: string }

const num = (v: number) => String(Number(v.toFixed(3)));
const point = (p: readonly number[]) => `(${p.map(num).join(', ')})`;
const ref = (target: { ref: string } | { name: string }, t: T) => 'ref' in target ? t('modelAuthoring.newElement', { ref: target.ref }) : target.name || t('modelChanges.absent');
const stairPatchDisplay=(expected:import('@ifc-lite/create').StairDimensions,units:string)=>({Width:expected.Width*(units==='mm'?1000:1),RiserHeight:expected.RiserHeight*(units==='mm'?1000:1),TreadLength:expected.TreadLength*(units==='mm'?1000:1),...(expected.WaistThickness===undefined?{}:{WaistThickness:expected.WaistThickness*(units==='mm'?1000:1)})});
const fields = (value: object, factor = 1) => Object.entries(value).map(([key, entry]) => `${key}=${typeof entry === 'number' ? String(Number((entry * factor).toPrecision(12))) : String(entry)}`).join(', ');

function dims(op: Extract<AuthoringOp, { op: 'element.create' }>, units: string): string {
  const p = op.params;
  if ('Profile' in p) {
    if (p.Profile === 'polygon' && 'OuterCurve' in p) return `polygon · ${p.OuterCurve.length} vertices · ${point(p.position)} · ${num(p.thickness ?? p.height ?? 0)} ${units}`;
    if (typeof p.Profile === 'object') {
      const shape = Object.entries(p.Profile).filter(([key]) => key !== 'Type').map(([key, value]) => `${key}=${String(Number(Number(value).toPrecision(12)))}`).join(', ');
      const axis = 'start' in p ? `${point(p.start)} → ${point(p.end)}` : `${point(p.position)} · height=${num(p.height ?? 0)}`;
      return `${p.Profile.Type} · ${shape} · ${axis} ${units}`;
    }
  }
  if ('Profile' in p) throw new Error('Unrecognised reviewed native shape');
  if ('start' in p) return `${point(p.start)} → ${point(p.end)} · ${num(p.thickness ?? p.width ?? 0)} × ${num(p.height)} ${units}`;
  return `${point(p.position)} · ${num(p.width)} × ${num(p.depth)} × ${num(p.thickness ?? p.height ?? 0)} ${units}`;
}

export function authoringRowSummary(row: AuthoringRow, batch: ModelAuthoringBatch, t: T): RowSummary {
  const { op, before } = row;
  const units = batch.units;
  const none = t('modelChanges.absent');
  const fromMetres = (v: number) => (units === 'mm' ? v * 1000 : v);
  switch (op.op) {
    case 'grid.create': case 'column.createOnGrid': {
      const omitted = op.op === 'column.createOnGrid' && 'Profile' in op.params ? sectionGhostOmissions(op.params.Profile) : [];
      return { subject: `${op.op === 'grid.create' ? 'IfcGrid' : 'IfcColumn'} ${op.params.Name ?? ''}`, before: t('modelAuthoring.notYet'), after: t('modelAuthoring.createdOn', { storey: before.storeyName ?? op.storey.globalId, dims: op.op === 'grid.create' ? `${op.params.UAxes.length + op.params.VAxes.length + (op.params.WAxes?.length ?? 0)} ${t('modelAuthoring.gridAxes')}` : `${point(op.params.Position)} · ${num(op.params.Height)} ${units}` }), previewNote: [row.previewUnavailable ? t('modelAuthoring.editPreviewUnavailable') : t(op.op === 'grid.create' ? 'modelAuthoring.gridPreview' : 'modelAuthoring.gridColumnPreview'), omitted.length ? t('modelAuthoring.filletPreview', { fields: omitted.join(', ') }) : ''].filter(Boolean).join(' · ') };
    }
    case 'hosted.edit':
      return { subject: `${op.target.ifcClass} "${op.target.name}"`, before: `${fields({ Offset: op.expected.offset, Sill: op.expected.sill, ...(op.expected.size ?? {}) })} ${units}`, after: `${fields(op.edit)} ${units}`, previewNote: row.previewUnavailable ? t('modelAuthoring.editPreviewUnavailable') : t('modelAuthoring.hostedEditBoundsPreview') };
    case 'element.trimExtend':
      return { subject: `${op.target.ifcClass} "${op.target.name}"`, before: JSON.stringify(before.reach ?? op.expected.snapshot),
        after: row.resolved.reachPlan ? t('modelAuthoring.trimExtendResult', { mode: row.resolved.reachPlan.op, end: row.resolved.reachPlan.end, length: num(fromMetres(row.resolved.reachPlan.length)), units, joined: row.resolved.reachPlan.joined ? t('modelAuthoring.joined') : '' }) : none,
        previewNote: [row.resolved.reachPlan && row.resolved.reachPlan.walls.length > 1 ? t('modelAuthoring.reachNeighborPreview') : '', row.previewUnavailable ? t('modelAuthoring.editPreviewUnavailable') : '',
          row.previewOuterBodyOnly ? t('modelAuthoring.outerBodyPreview') : '',
          row.previewOmitted?.length ? t('modelAuthoring.filletPreview', { fields: row.previewOmitted.join(', ') }) : ''].filter(Boolean).join(' · ') || undefined };
    case 'element.split': {
      const cut = op.cut.kind === 'slab' ? `${point(op.cut.a)} → ${point(op.cut.b)} ${units}` : `${num(op.cut.distance)} ${units}`;
      const effects = row.resolved.splitEffects;
      return { subject: `${op.target.ifcClass} "${op.target.name}"`,
        before: op.expected.kind === 'slab' ? `${op.expected.chain.footprint.length} vertices · thickness=${num(op.expected.chain.thickness)} ${units}` : `${point(op.expected.chain.startCoordinates)} · ${op.expected.kind === 'wall' ? `length=${num(op.expected.chain.wallLength)}, height=${num(op.expected.chain.height)}, thickness=${num(op.expected.chain.thickness)}` : `length=${num(op.expected.chain.depth)}, ${fields(op.expected.chain.profile ?? { XDim: op.expected.chain.profileWidth, YDim: op.expected.chain.profileHeight })}`} ${units}`,
        after: t('modelAuthoring.splitResult', { cut, side: effects?.leftId === row.expressId ? 'left' : 'right' }),
        previewNote: `${row.previewUnavailable ? t('modelAuthoring.editPreviewUnavailable') : t('modelAuthoring.splitPreview')}${effects ? ` ${t('modelAuthoring.splitOpenings', effects.openings)}` : ''}` };
    }
    case 'stair.resize': return {subject:`${op.target.ifcClass} ${op.target.name}`,before:`${fields({Width:op.expected.Width,RiserHeight:op.expected.RiserHeight,TreadLength:op.expected.TreadLength,...(op.expected.WaistThickness===undefined?{}:{WaistThickness:op.expected.WaistThickness})},units==='mm'?1000:1)} ${units}`,after:`${fields({...stairPatchDisplay(op.expected,units),...op.size})} ${units}`,previewNote:t('modelAuthoring.editPreviewUnavailable')};
    case 'stair.delete': case 'railing.delete': return {subject:`${op.target.ifcClass} ${op.target.name}`,before:op.target.name,after:t('modelChanges.removed'),previewNote:t('modelAuthoring.editPreviewUnavailable')};
    case 'stair.replace': case 'railing.replace': return {subject:`${op.target.ifcClass} ${op.target.name}`,before:op.target.globalId,after:`${op.op==='stair.replace'?'IfcStair':'IfcRailing'} ${JSON.stringify(op.params)} ${units}`,previewNote:t('modelAuthoring.stairRailingPreview')+(row.previewUnavailable?' '+t('modelAuthoring.editPreviewUnavailable'):'')};
    case 'stair.create': case 'railing.create': return {subject:`${op.op==='stair.create'?'IfcStair':'IfcRailing'} ${op.params.Name??''}`,before:t('modelAuthoring.notYet'),after:t('modelAuthoring.createdOn',{storey:before.storeyName??op.storey.globalId,dims:`${JSON.stringify(op.params)} ${units}`} ),previewNote:t('modelAuthoring.stairRailingPreview')+(row.previewUnavailable?' '+t('modelAuthoring.editPreviewUnavailable'):'')};
    case 'element.resize': case 'element.profile': {
      const notes = [row.previewUnavailable ? t('modelAuthoring.editPreviewUnavailable') : '',
        row.previewOuterBodyOnly ? t('modelAuthoring.outerBodyPreview') : '',
        row.previewOmitted?.length ? t('modelAuthoring.filletPreview', { fields: row.previewOmitted.join(', ') }) : ''].filter(Boolean);
      return { subject: `${op.target.ifcClass} "${op.target.name}"`,
        before: `${fields(op.op === 'element.resize' ? before.size ?? {} : before.Profile ?? {}, units === 'mm' ? 1000 : 1)} ${units}`,
        after: `${fields(op.op === 'element.resize' ? { ...op.expected, ...op.size } : op.Profile)} ${units}`,
        ...(notes.length ? { previewNote: notes.join(' ') } : {}) };
    }
    case 'element.create': {
      const omitted = 'Profile' in op.params && typeof op.params.Profile === 'object' ? sectionGhostOmissions(op.params.Profile) : [];
      return { ...(omitted.length ? { previewNote: t('modelAuthoring.filletPreview', { fields: omitted.join(', ') }) } : {}),
        subject: `${op.ifcClass} "${op.name}"`, before: t('modelAuthoring.notYet'),
        after: t('modelAuthoring.createdOn', { storey: before.storeyName ?? op.storey.globalId, dims: dims(op, units) }) };
    }
    case 'element.copy': case 'element.array': {
      const count = op.op === 'element.copy' ? 1 : op.count - 1;
      const placement = op.op === 'element.copy'
        ? `${point(op.offset)} ${units}${op.angleDeg === undefined ? '' : ` · ${num(op.angleDeg)}° @ ${point(op.pivot!)} ${units}`}`
        : op.mode === 'polar' ? `${num(op.angleDeg ?? 360)}° @ ${point(op.anchor)} ${units}`
          : `${point(op.anchor)} → ${point(op.cursor!)} ${units} · ${t(op.fit ? 'modelAuthoring.arraySpan' : 'modelAuthoring.arraySpacing')}: ${op.distance === undefined ? t('modelAuthoring.cursorDistance') : `${num(op.distance)} ${units}`}`;
      return { subject: ref(op.target, t), before: before.origin ? `${point(before.origin.map(fromMetres))} ${units}` : none,
        after: t('modelAuthoring.copied', { count, placement, storey: before.storeyName ?? t('modelAuthoring.sourceStorey') }) };
    }
    case 'element.delete':
      return { subject: `${op.target.ifcClass} "${op.target.name}"`, before: `${before.ifcClass ?? op.target.ifcClass} "${before.name ?? op.target.name}"`, after: t('modelChanges.removed') };
    case 'element.move': {
      const origin = before.origin?.map(fromMetres);
      return { subject: `${op.target.ifcClass} "${op.target.name}"`, before: origin ? `${point(origin)} ${units}` : none,
        after: origin ? `${point([origin[0] + op.delta[0], origin[1] + op.delta[1]])} ${units}` : t('modelAuthoring.movedBy', { delta: `${point(op.delta)} ${units}` }) };
    }
    case 'element.rotate':
      return { subject: `${op.target.ifcClass} "${op.target.name}"`, before: before.angleDeg === undefined ? none : `${num(before.angleDeg)}°`,
        after: before.angleDeg === undefined ? t('modelAuthoring.turnedBy', { angle: num(op.angleDeg) }) : `${num(before.angleDeg + op.angleDeg)}°` };
    case 'type.detach':
      return { subject: ref(op.target, t), before: before.type ?? none, after: none,
        previewNote: t('modelAuthoring.editPreviewUnavailable') };
    case 'type.assign':
      return { subject: ref(op.target, t), before: before.type ?? none,
        after: 'create' in op.type ? t('modelAuthoring.newType', { name: op.type.create.name, ifcClass: op.type.create.ifcClass }) : op.type.name };
    case 'material.assign':
      return { subject: ref(op.target, t), before: before.material ?? none,
        after: row.resolved.materialId === null ? t('modelAuthoring.newMaterial', { name: op.material.name }) : op.material.name };
    case 'walls.join':
      return { subject: `${ref(op.walls[0], t)} + ${ref(op.walls[1], t)}`, before: t('modelAuthoring.unjoined'), after: t('modelAuthoring.joined') };
    case 'hosted.create':
      return { subject: ref(op.host, t), before: t('modelAuthoring.notYet'),
        after: t(`modelAuthoring.hosted.${op.kind}`, { size: `${num(op.width)} × ${num(op.height)} ${units}`, offset: num(op.offset), sill: num(op.sill), units }) };
  }
}
