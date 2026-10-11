/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { roomChainInStore } from '../../../../../../packages/create/src/in-store/room-store.js';
import { polygonArea } from '../../../../../../packages/create/src/in-store/room-footprint-offset.js';
import { nativeRootName } from '@/lib/actions/native-edit-evidence';
import type { RoomReview } from '@/lib/actions/room-review';
import { useTranslation } from '@/i18n';
import { effectiveMetadataRecord } from '@ifc-lite/parser';
import { effectiveStoreyId } from '../../../../../../packages/create/src/in-store/edit/effective-storey.js';

/** Read the detached native writer's actual polygons; no inferred room shape or extra solver. */
export function RoomNativePreview({ review }: { review: RoomReview }) {
  const { t } = useTranslation();
  const { prepared, proposal } = review;
  const native = { modelId: proposal.modelId, dataStore: prepared.preview.store,
    view: prepared.preview.mutationView, editor: prepared.preview.editor };
  const rows = [...prepared.result.created, ...prepared.result.updated].map(ref => {
    const read = roomChainInStore(native.dataStore, native.editor, ref.expressId);
    if (!read.ok) throw new Error('The detached native Room preview has an unsupported written polygon');
    const record = effectiveMetadataRecord(native.dataStore, ref.expressId, native.view);
    const attribute = (name: string) => record?.attributes[record.names.indexOf(name)] ?? null;
    return { storeyId: effectiveStoreyId(native.dataStore,native.view,ref.expressId), id: ref.expressId, name: nativeRootName(native, ref.expressId), outline: read.chain.footprint,
      height: read.chain.thickness, z: read.chain.baseElevation, area: polygonArea(read.chain.footprint),
      PredefinedType: attribute('PredefinedType'), ObjectType: attribute('ObjectType') };
  });
  const shapes = rows.length ? rows.map(row => row.outline) : (prepared.layoutAfter ?? []).map(face => face.centre);
  const points = shapes.flat();
  const minX = Math.min(...points.map(p => p[0])), minY = Math.min(...points.map(p => p[1]));
  const width = Math.max(1, Math.max(...points.map(p => p[0])) - minX);
  const height = Math.max(1, Math.max(...points.map(p => p[1])) - minY);
  const margin = Math.max(width, height) * .04;
  const command = proposal.command;
  const operation = command.action === 'edit' ? command.operation : null;
  const point = (value: readonly number[]) => value.join(', ');
  const operationDescription = operation?.kind === 'drag'
    ? t('roomReview.drag', { from: point(operation.from), to: point(operation.to) })
    : operation?.kind === 'split' ? t('roomReview.split', { from: point(operation.a), to: point(operation.b) })
    : operation?.kind === 'remove' ? t('roomReview.remove', { at: point(operation.at) })
    : operation ? t('roomReview.prune') : null;
  return <div className="space-y-2">
    {command.action === 'edit' && <p>{operationDescription} {' '}{t('roomReview.tolerance', { tolerance: command.tolerance ?? .01 })}</p>}
    {/* Native vector contours need SVG image semantics; an HTML img cannot contain these polygons. */}
    {/* eslint-disable-next-line jsx-a11y/prefer-tag-over-role */}
    {command.action !== 'autoAll' && points.length > 0 && <svg role="img" aria-label={t('roomReview.plan')} className="w-full h-40 border border-border rounded"
      viewBox={`${minX - margin} ${-minY - height - margin} ${width + margin * 2} ${height + margin * 2}`}>
      <title>{t('roomReview.plan')}</title>
      {shapes.map((outline, i) => <polygon key={i} points={outline.map(([x, y]) => `${x},${-y}`).join(' ')}
        fill="currentColor" fillOpacity="0.12" stroke="currentColor" strokeWidth={Math.max(width, height) / 200} />)}
    </svg>}
    <ul className="max-h-48 overflow-auto list-disc pl-4">
      {rows.map(row => <li key={row.id}>{row.name || t('roomReview.unnamedRoom')}
        {review.snapshot.storeys && <p>{t('roomReview.storeyOwner', {name:review.snapshot.storeys.find(storey=>storey.expressId===row.storeyId)?.Name ?? String(row.storeyId)})}</p>}
        <p>{t('roomReview.geometry', { area: Number(row.area.toFixed(4)), height: row.height, z: row.z })}</p>
        <p>{t('roomReview.PredefinedType')}: {String(row.PredefinedType ?? '—')} · {t('roomReview.ObjectType')}: {String(row.ObjectType ?? '—')}</p>
        <details><summary>{t('roomReview.contour')}</summary><pre className="whitespace-pre-wrap break-words">{JSON.stringify(row.outline)}</pre></details>
      </li>)}
    </ul>
    {!rows.length && prepared.layoutAfter && <details><summary>{t('roomReview.layoutContours', { count: prepared.layoutAfter.length })}</summary>
      <pre className="whitespace-pre-wrap break-words">{JSON.stringify(prepared.layoutAfter.map(face => face.centre))}</pre>
    </details>}
  </div>;
}
