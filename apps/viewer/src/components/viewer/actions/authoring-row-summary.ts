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
    case 'element.create': {
      const omitted = 'Profile' in op.params && typeof op.params.Profile === 'object' ? sectionGhostOmissions(op.params.Profile) : [];
      return { ...(omitted.length ? { previewNote: t('modelAuthoring.filletPreview', { fields: omitted.join(', ') }) } : {}),
        subject: `${op.ifcClass} "${op.name}"`, before: t('modelAuthoring.notYet'),
        after: t('modelAuthoring.createdOn', { storey: before.storeyName ?? op.storey.globalId, dims: dims(op, units) }) };
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
