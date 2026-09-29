/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Nominal measurements of IFC source solids, kept separate from product Qto and mesh. */
import { QuantityType } from '@ifc-lite/data';
import type { ExtrusionDefinitions } from '@ifc-lite/geometry';
import { ProjectUnits } from '@ifc-lite/parser';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { useSelectedSweptDisks, type SelectedSweptDisksState } from '@/hooks/useSelectedSweptDisks';
import { useSelectedExtrusions, type SelectedExtrusionsState } from '@/hooks/useSelectedExtrusions';
import { formatConverted, resolveQuantityDisplay } from '@/lib/units/display';

const SI_UNITS = ProjectUnits.empty();
type NominalExtrusion = NonNullable<ExtrusionDefinitions['sources'][number]['nominal_quantities']>;

function validNominal(nominal: NominalExtrusion | null | undefined, scale: number): nominal is NominalExtrusion {
  return !!nominal && Number.isFinite(scale) && scale > 0 &&
    [nominal.profile_area * scale ** 2, nominal.projected_height * scale,
      nominal.nominal_volume * scale ** 3].every(Number.isFinite);
}

interface SourceQuantityData {
  disks: SelectedSweptDisksState;
  extrusions: SelectedExtrusionsState;
}

function SourceValue({ value, type }: { value: number; type: QuantityType }) {
  const overrides = useViewerStore((state) => state.unitDisplayOverrides);
  const display = resolveQuantityDisplay(value, type, SI_UNITS, overrides);
  const amount = display.converted ?? value;
  // The shared panel formatter caps decimals at four places. A valid small
  // source volume (for example 1e-6 m³) must not read as a measured zero.
  const formatted = amount !== 0 && Math.abs(amount) < 1e-4
    ? amount.toExponential(3)
    : formatConverted(amount);
  return <span className="font-mono tabular-nums">{formatted} {display.unit}</span>;
}

/** Both source families are selected through their existing cached hooks. */
export function SourceQuantityInspection() {
  const disks = useSelectedSweptDisks(true);
  const extrusions = useSelectedExtrusions(true);
  return <SourceQuantityContent disks={disks} extrusions={extrusions} />;
}

export function SourceQuantityContent({ disks, extrusions }: SourceQuantityData) {
  const { t } = useTranslation();
  const hasDisks = disks.items.some((item) => item.occurrences.length > 0 || item.diagnostics.length > 0);
  const hasExtrusions = extrusions.items.some((item) => item.product.occurrences.length > 0 || item.product.diagnostics.length > 0);
  if (!hasDisks && !hasExtrusions && !disks.loading && !extrusions.loading && !disks.error && !extrusions.error) return null;

  return <section className="space-y-1.5 border-t border-border pt-2" aria-label={t('measure.source.heading')}>
    <h3 className="font-mono text-2xs uppercase tracking-wider text-foreground">{t('measure.source.heading')}</h3>
    <p className="font-mono text-2xs leading-tight text-muted-foreground">{t('measure.source.limitation')}</p>
    {(disks.loading || extrusions.loading) && <output className="block text-2xs">{t('measure.source.loading')}</output>}
    {disks.error && <p role="alert" className="text-2xs text-amber-600">{disks.error}</p>}
    {extrusions.error && <p role="alert" className="text-2xs text-amber-600">{extrusions.error}</p>}

    {disks.items.flatMap(({ ref, diagnostics }) => diagnostics.map((diagnostic, index) =>
      <p key={`disk-diagnostic:${ref.modelId}:${ref.expressId}:${index}`} className="text-2xs text-amber-600 dark:text-amber-500">
        {t('measure.source.product', { modelId: ref.modelId, productId: ref.expressId })}: {diagnostic}
      </p>))}
    {extrusions.items.flatMap(({ ref, product }) => product.diagnostics.map((diagnostic, index) =>
      <p key={`extrusion-diagnostic:${ref.modelId}:${ref.expressId}:${index}`} className="text-2xs text-amber-600 dark:text-amber-500">
        {t('measure.source.product', { modelId: ref.modelId, productId: ref.expressId })}: {diagnostic}
      </p>))}

    {disks.items.map(({ ref, occurrences }) => occurrences.map((source, index) => {
      const length = source.directrix_metrics?.total_length;
      const hasLength = length !== undefined && Number.isFinite(length) && length >= 0;
      return <div key={`disk:${ref.modelId}:${ref.expressId}:${index}`} className="space-y-0.5 text-2xs">
        <div className="font-mono text-muted-foreground">{t('measure.source.sweptDiskSolid', {
          modelId: ref.modelId, productId: ref.expressId, solidId: source.solid_id,
        })}{source.mapping_path.length ? ` · ${t('measure.source.mapped')}` : ''}</div>
        <div>{t('measure.source.centrelineLength')}: {hasLength
          ? <SourceValue value={length} type={QuantityType.Length} />
          : t('measure.source.unavailable')}</div>
        {source.source_modified && <p className="text-amber-600 dark:text-amber-500">{t('measure.source.modified')}</p>}
        {source.status.type === 'unsupported' && <p className="text-amber-600 dark:text-amber-500">{source.status.reason}</p>}
      </div>;
    }))}

    {extrusions.items.map(({ ref, product }) => product.occurrences.map(({ instance, definition }, index) => {
      const nominal = definition?.nominal_quantities;
      const scale = product.lengthUnitScale;
      const hasNominal = validNominal(nominal, scale);
      return <div key={`extrusion:${ref.modelId}:${ref.expressId}:${index}`} className="space-y-0.5 text-2xs">
        <div className="font-mono text-muted-foreground">{t('measure.source.extrusionSolid', {
          modelId: ref.modelId, productId: ref.expressId, solidId: instance.solid_id,
        })}{instance.mapping_path.length ? ` · ${t('measure.source.mapped')}` : ''}</div>
        {hasNominal ? <>
          <div>{t('measure.source.profileArea')}: <SourceValue value={nominal.profile_area * scale ** 2} type={QuantityType.Area} /></div>
          <div>{t('measure.source.projectedHeight')}: <SourceValue value={nominal.projected_height * scale} type={QuantityType.Length} /></div>
          <div>{t('measure.source.nominalVolume')}: <SourceValue value={nominal.nominal_volume * scale ** 3} type={QuantityType.Volume} /></div>
        </> : <div>{t('measure.source.nominalVolume')}: {t('measure.source.unavailable')}</div>}
        {instance.source_modified && <p className="text-amber-600 dark:text-amber-500">{t('measure.source.modified')}</p>}
        {instance.status.type === 'unsupported' && <p className="text-amber-600 dark:text-amber-500">{instance.status.reason}</p>}
        <p className="text-muted-foreground">{t('measure.source.unplaced')}</p>
      </div>;
    }))}
  </section>;
}
