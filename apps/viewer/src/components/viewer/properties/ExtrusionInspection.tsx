/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ExtrusionDefinitions } from '@ifc-lite/geometry';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { useSelectedExtrusions } from '@/hooks/useSelectedExtrusions';
import { formatAnalyticLength } from './SweptDiskInspection';

type Instance = ExtrusionDefinitions['instances'][number][number];
type Definition = ExtrusionDefinitions['sources'][number];
type Segment = NonNullable<Definition['source']['profile']>['loops'][number]['segments'][number];

function number(value: number): string {
  return value.toLocaleString(undefined, { maximumSignificantDigits: 11 });
}

function vector(values: readonly number[] | null): string {
  return values ? `[${values.map(number).join(', ')}]` : '—';
}

function TransformDetail({ label, matrix, translationScale, units }: {
  label: string; matrix: readonly number[] | null; translationScale: number; units: string;
}) {
  if (!matrix || matrix.length !== 16) return null;
  return <details className="border-t border-zinc-200 dark:border-zinc-800 pt-1">
    <summary className="cursor-pointer">{label}</summary>
    <div>Translation: {vector(matrix.slice(12, 15).map((value) => value * translationScale))} {units}</div>
    <div>X axis: {vector(matrix.slice(0, 3))}</div>
    <div>Y axis: {vector(matrix.slice(4, 7))}</div>
    <div>Z axis: {vector(matrix.slice(8, 11))}</div>
  </details>;
}

function segmentDescription(segment: Segment, scale: number, overrides: Record<string, string>): string {
  if (segment.type === 'line') {
    return `${vector(segment.start.map((v) => v * scale))} → ${vector(segment.end.map((v) => v * scale))} m`;
  }
  return `center ${vector(segment.center.map((v) => v * scale))} m · radius ${formatAnalyticLength(segment.radius * scale, overrides)} · ${number(segment.start_angle)} → ${number(segment.start_angle + segment.sweep_angle)} rad · normal ${vector(segment.normal)} · x-axis ${vector(segment.x_axis)}`;
}

/** Authored source parameters. Values remain distinct from placed or cut mesh measurements. */
export function ExtrusionRecord({ instance, definition, lengthUnitScale }: {
  instance: Instance;
  definition: Definition | null;
  lengthUnitScale: number;
}) {
  const { t } = useTranslation();
  const overrides = useViewerStore((state) => state.unitDisplayOverrides);
  const source = definition?.source;
  const profile = source?.profile;
  const unsupported = !source || instance.status.type === 'unsupported' || source.status.type === 'unsupported'
    || source.profile?.status.type === 'unsupported';
  return <section className="border border-zinc-200 dark:border-zinc-800 p-2 space-y-1 text-xs"
    aria-label={t('properties.extrusion.solid', { id: instance.solid_id })}>
    <div className="font-semibold">{t('properties.extrusion.solid', { id: instance.solid_id })}</div>
    <div>{t('properties.extrusion.status')}: {unsupported ? t('properties.extrusion.unsupported') : t('properties.extrusion.complete')}</div>
    {instance.status.type === 'unsupported' && <p role="alert">{instance.status.reason}</p>}
    {source?.status.type === 'unsupported' && <p role="alert">{source.status.reason}</p>}
    {!definition && <p role="alert">{t('properties.extrusion.missingSource')}</p>}
    <div>{t('properties.extrusion.sourceModified')}: {instance.source_modified ? t('properties.extrusion.yes') : t('properties.extrusion.no')}</div>
    {instance.source_modified && <p className="text-amber-700 dark:text-amber-400">{t('properties.extrusion.modifiedHint')}</p>}
    <div className="break-all">{t('properties.extrusion.mappingPath')}: {instance.mapping_path.length
      ? instance.mapping_path.map((id) => `#${id}`).join(' → ') : t('properties.extrusion.none')}</div>
    {source && <>
      <div>{t('properties.extrusion.depth')}: {source.Depth === null ? t('properties.extrusion.none')
        : formatAnalyticLength(source.Depth * lengthUnitScale, overrides)}</div>
      <div>{t('properties.extrusion.direction')}: {vector(source.DirectionRatios)}</div>
      <div>{t('properties.extrusion.position')}: {source.Position === null ? t('properties.extrusion.none') : `#${source.Position}`}</div>
      <div>{t('properties.extrusion.profile')}: {profile
        ? `${profile.ifc_type_name} #${profile.profile_id}` : t('properties.extrusion.none')}</div>
      <details className="border-t border-zinc-200 dark:border-zinc-800 pt-1">
        <summary className="cursor-pointer">{t('properties.extrusion.placement')}</summary>
        <p className="text-zinc-500">{t('properties.extrusion.placementNote')}</p>
        <TransformDetail label={t('properties.extrusion.profileFrame')}
          matrix={profile?.profile_position ?? null} translationScale={lengthUnitScale} units="m" />
        <TransformDetail label={t('properties.extrusion.solidFrame')}
          matrix={source.position_matrix} translationScale={lengthUnitScale} units="m" />
        <TransformDetail label={t('properties.extrusion.worldFrame')}
          matrix={instance.world_from_source} translationScale={1} units="m" />
      </details>
    </>}
    {profile && <>
      <div>{t('properties.extrusion.profileType')}: {profile.ProfileType ?? t('properties.extrusion.none')}</div>
      <div>{t('properties.extrusion.profilePosition')}: {profile.Position === null ? t('properties.extrusion.none') : `#${profile.Position}`}</div>
      {profile.status.type === 'unsupported' && <p role="alert">{profile.status.reason}</p>}
      {profile.loops.map((loop, index) => <details key={index} className="border-t border-zinc-200 dark:border-zinc-800 pt-1">
        <summary className="cursor-pointer">{t('properties.extrusion.loop', { index: index + 1 })} · {loop.kind} · {loop.segments.length} {t('properties.extrusion.segments')}</summary>
        <div>{t('properties.extrusion.perimeter')}: {formatAnalyticLength(loop.perimeter * lengthUnitScale, overrides)}</div>
        <div>{t('properties.extrusion.signedArea')}: {number(loop.signed_area * lengthUnitScale ** 2)} m²</div>
        <ol className="list-decimal pl-5 space-y-1">
          {loop.segments.map((segment, segmentIndex) => <li key={segmentIndex} className="break-all">
            {segment.type} · {segmentDescription(segment, lengthUnitScale, overrides)}
          </li>)}
        </ol>
      </details>)}
    </>}
  </section>;
}

export function ExtrusionInspection({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  const { items, loading, error } = useSelectedExtrusions(enabled);
  if (!enabled) return null;
  const withRecords = items.filter((item) => item.product.occurrences.length || item.product.diagnostics.length);
  if (!loading && !error && withRecords.length === 0) return null;
  return <section className="space-y-2" aria-label={t('properties.extrusion.heading')}>
    <h3 className="text-xs font-semibold uppercase tracking-wide">{t('properties.extrusion.heading')}</h3>
    <p className="text-2xs text-zinc-500">{t('properties.extrusion.sourceNote')}</p>
    {loading && <output className="block">{t('properties.extrusion.loading')}</output>}
    {error && <p role="alert">{error}</p>}
    {withRecords.map((item) => <div key={`${item.ref.modelId}:${item.ref.expressId}`} className="space-y-2">
      <div className="font-mono text-2xs">{item.ref.modelId} · #{item.ref.expressId}</div>
      {item.product.occurrences.map(({ instance, definition }, index) => <ExtrusionRecord
        key={`${instance.solid_id}:${instance.ordinal}:${index}`} instance={instance} definition={definition}
        lengthUnitScale={item.product.lengthUnitScale} />)}
      {item.product.diagnostics.map((message, index) => <p key={index} role="alert"
        className="text-xs break-words text-amber-700 dark:text-amber-400">{message}</p>)}
    </div>)}
  </section>;
}
