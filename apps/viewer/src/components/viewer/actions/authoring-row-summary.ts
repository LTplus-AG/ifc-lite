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
import { classificationLabel } from '@/lib/actions/model-authoring-classification';

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
    case 'classification.add':
      return { subject: ref(op.target, t), before: t('modelAuthoring.classificationExistingRetained'), after: classificationLabel(op),
        previewNote: t('modelAuthoring.classificationMetadataPreview') };
    case 'grid.create': case 'column.createOnGrid': {
      const omitted = op.op === 'column.createOnGrid' && 'Profile' in op.params ? sectionGhostOmissions(op.params.Profile) : [];
      return { subject: `${op.op === 'grid.create' ? 'IfcGrid' : 'IfcColumn'} ${op.params.Name ?? ''}`, before: t('modelAuthoring.notYet'), after: t('modelAuthoring.createdOn', { storey: before.storeyName ?? op.storey.globalId, dims: op.op === 'grid.create' ? `${op.params.UAxes.length + op.params.VAxes.length + (op.params.WAxes?.length ?? 0)} ${t('modelAuthoring.gridAxes')}` : `${point(op.params.Position)} · ${num(op.params.Height)} ${units}` }), previewNote: [row.previewUnavailable ? t('modelAuthoring.editPreviewUnavailable') : t(op.op === 'grid.create' ? 'modelAuthoring.gridPreview' : 'modelAuthoring.gridColumnPreview'), omitted.length ? t('modelAuthoring.filletPreview', { fields: omitted.join(', ') }) : ''].filter(Boolean).join(' · ') };
    }
