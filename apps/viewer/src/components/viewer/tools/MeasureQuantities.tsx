/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Area / volume / weight / length for the current selection — issue #2199
 * §1 (element surface area), §2 (volume) and §6 (weight).
 *
 * This measures what the MODEL says, not what the pixels say, and it is
 * explicit about which. Two independent sources are shown side by side and
 * never blended:
 *
 * - **Declared** — the file's own `IfcElementQuantity`, occurrence first with
 *   the element's type as fallback (the #1745/#1755 rule, matching the Lists
 *   engine and the material totals panel). Gross and net stay apart, which is
 *   how §1's "indicate whether opening areas are included or excluded" is
 *   answered: IFC already encodes it in the naming, so the tool surfaces the
 *   distinction rather than inventing one.
 * - **Geometry** — `MeshData.geometryVolume`, the kernel's enclosed volume,
 *   present only where a single closed orientable solid could be PROVED. The
 *   count of elements where it could not is reported rather than hidden, which
 *   is §2's "report that the volume cannot be calculated reliably instead of
 *   returning an incorrect result". Two things follow from that field's own
 *   contract and are handled here rather than assumed away:
 *   - A GPU-instanced-only element has NO flat mesh at all; the geometry pass
 *     parks its proved volume in `GeometryResult.instancedGeometryVolumes`
 *     instead. Reading only `meshes` would report an entire precast field as
 *     unprovable while the answer sat in the side channel.
 *   - A federated model that alignment RE-BAKED (`'same-crs'` / `'reprojected'`)
 *     carries volumes measured at a size that is no longer on screen, and
 *     nothing on this side can re-measure them (#1993). Those are withheld and
 *     COUNTED SEPARATELY — "we scaled it away" is a different statement from
 *     "the kernel could not prove it", and collapsing the two would be the
 *     silent blend this whole panel exists to avoid.
 * - **Area mesh** — the triangulated mesh's total surface area, summed live
 *   from each submesh's `positions`/`indices` (`measure-modes/mesh-area.ts`,
 *   using `triangleArea` newly re-exported from `@ifc-lite/clash`'s public
 *   surface — the "mesh analysis reachable from TypeScript" prerequisite
 *   #2199 names). Unlike `geometryVolume` this needs no closed-solid proof, so
 *   it covers open shells and layered walls too; and because it re-reads
 *   `positions` on every call rather than trusting a value cached before
 *   alignment, it is NOT invalidated by federation re-baking. It is the sum of
 *   EVERY meshed face, not one side, so it is never comparable to a
 *   `NetSideArea`/`GrossSideArea` and is labelled its own "mesh" row.
 *   GPU-instanced-only elements and mesh records with fewer than three indices
 *   have no measurable mesh area; a triangulated mesh with degenerate faces
 *   instead has a measured zero. `collectMeshAreas` takes mesh data without an
 *   `IfcDataStore`, so missing store data cannot suppress a mesh measurement.
 *
 * - **Mass derived** — geometry volume x the material density the file declares
 *   in `Pset_MaterialCommon.MassDensity` (#2736). This is the ONLY number on
 *   the panel this tool calculates from two unrelated facts, so it is the one
 *   that most needs its provenance attached, and `measure-modes/weight.ts`
 *   attaches it: a declared `Qto` weight is never derived over, an untrusted
 *   volume never becomes a mass at all, and a density the file did not declare
 *   would land in a separate "estimated" row rather than this one. The whole
 *   arithmetic is `kg/m³ x m³`, which is why the row says "Mass" and not
 *   "Weight" — #2736 §4's mass-vs-force distinction, answered by routing
 *   through `project_units`' `MASSUNIT` rather than a second convention.
 *
 * Values are normalised to SI at read time, while each value is still next to
 * the `ProjectUnits` that explain it, because a federation can mix a
 * millimetre model with a metre one. Display then converts once, honouring the
 * user's per-unit-type override from #1573.
 */

import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n/useTranslation';
import type { TranslationKey } from '@/i18n/en';
import { ProjectUnits } from '@ifc-lite/parser';
import { resolveQuantityDisplay, formatConverted } from '@/lib/units/display';
import { MEASURABLE_QUANTITY_TYPES, type QuantityBasis } from './measure-modes/quantities';
import type { WeightBasis } from './measure-modes/weight';
import { SourceQuantityInspection } from './SourceQuantityInspection';
import { QuantityResultView } from './QuantityResultView';
import { ResultState } from '../result/ResultState';
import { useSelectionQuantitySummary } from './measure-modes/use-selection-quantity-summary';

const QUANTITY_TYPE_LABEL_KEY: Record<number, TranslationKey> = {
  0: 'measure.qty.length',
  1: 'measure.qty.area',
  2: 'measure.qty.volume',
  4: 'measure.qty.weight',
};

const BASIS_LABEL_KEY: Record<QuantityBasis, TranslationKey | null> = {
  net: 'measure.basis.net',
  gross: 'measure.basis.gross',
  unqualified: null,
};

/**
 * Row labels for the two DERIVED weight bases (#2736).
 *
 * `declared` has no entry because it is not rendered from this rollup: a
 * declared `Qto` weight is already a row of the `declared` quantity table
 * above, complete with its own net/gross basis, and rendering it twice would
 * be the second number this panel exists to avoid. The rollup still models it
 * — that is what lets a declared weight suppress its own derivation — it is
 * just not drawn from here.
 *
 * "Mass" rather than "Weight" is deliberate and is #2736 §4: kg/m³ x m³ is a
 * mass, and a row that said "Weight" beside a `MASSUNIT` total would leave the
 * reader to guess whether it meant a force.
 */
const DERIVED_WEIGHT_LABEL_KEY: Record<Exclude<WeightBasis, 'declared'>, TranslationKey> = {
  'derived-ifc-density': 'measure.weight.massDerived',
  'derived-library-density': 'measure.weight.massEstimated',
};

const DERIVED_WEIGHT_TITLE_KEY: Record<Exclude<WeightBasis, 'declared'>, TranslationKey> = {
  'derived-ifc-density': 'measure.weight.massDerivedTitle',
  'derived-library-density': 'measure.weight.massEstimatedTitle',
};

export function MeasureQuantities() {
  const { t } = useTranslation();
  const unitDisplayOverrides = useViewerStore((s) => s.unitDisplayOverrides);
  const quantities = useSelectionQuantitySummary();
  const { summary } = quantities;

  // Totals are already SI, so display resolves against an EMPTY unit context —
  // handing it the file's declared millimetres would scale a metre total again.
  const render = (value: number, quantityType: number): string => {
    const disp = resolveQuantityDisplay(value, quantityType, ProjectUnits.empty(), unitDisplayOverrides);
    const formatted = disp.converted !== null
      ? formatConverted(disp.converted)
      : value.toLocaleString(undefined, { maximumFractionDigits: 3 });
    return disp.unit ? `${formatted} ${disp.unit}` : formatted;
  };

  if (!summary) return <QuantityResultView quantities={quantities} />;

  const { declared, geometry, meshArea, weights, elements } = summary;
  // Derived-mass rows only. The `declared` basis is already a row of the
  // `declared` table above; see DERIVED_WEIGHT_LABEL.
  const derivedWeights = weights.rows.filter((r) => r.basis !== 'declared');
  // A derived mass needs a trusted proved volume, so `geometry.proved === 0`
  // already implies `derivedWeights` is empty — stated as a condition rather
  // than left as an invariant a future edit could break silently.
  const nothing = declared.length === 0
    && geometry.proved === 0
    && meshArea.withMesh === 0
    && derivedWeights.length === 0;

  return (
    <QuantityResultView quantities={quantities} evidence={<SourceQuantityInspection />}>
    <div className="space-y-1.5 px-3 py-2">
      {nothing ? (
        <ResultState kind="partial" title={t('measure.quantities.nothingFound')} />
      ) : (
        <div className="space-y-0.5 overflow-x-auto">
          {declared.length > 0 && <div className="font-mono text-2xs uppercase tracking-wider text-muted-foreground">{t('measure.quantities.authoredHeading')}</div>}
          {declared.map((r) => (
            <div
              key={`${r.quantityType}-${r.basis}`}
              className="flex items-baseline gap-2 whitespace-nowrap"
              title={r.provenance.join('\n')}
            >
              <span className="w-[5.5rem] shrink-0 font-mono text-2xs uppercase tracking-wider text-muted-foreground">
                {QUANTITY_TYPE_LABEL_KEY[r.quantityType] ? t(QUANTITY_TYPE_LABEL_KEY[r.quantityType]) : r.quantityType}{' '}
                {BASIS_LABEL_KEY[r.basis] ? t(BASIS_LABEL_KEY[r.basis]!) : ''}
              </span>
              <span className="font-mono text-2xs tabular-nums">{render(r.total, r.quantityType)}</span>
              {r.contributing < elements && (
                <span className="font-mono text-2xs text-amber-600 dark:text-amber-500">
                  {r.contributing}/{elements}
                </span>
              )}
            </div>
          ))}

          {(geometry.proved > 0 || meshArea.withMesh > 0 || derivedWeights.length > 0) &&
            <div className="font-mono text-2xs uppercase tracking-wider text-muted-foreground">{t('measure.quantities.computedHeading')}</div>}

          {geometry.proved > 0 && (
            <div
              className="flex items-baseline gap-2 whitespace-nowrap"
              title={t('measure.quantities.volumeMeshTitle')}
            >
              <span className="w-[5.5rem] shrink-0 font-mono text-2xs uppercase tracking-wider text-muted-foreground">
                {t('measure.quantities.volumeMeshLabel')}
              </span>
              <span className="font-mono text-2xs tabular-nums">{render(geometry.total, 2)}</span>
              {geometry.unproved > 0 && (
                <span className="font-mono text-2xs text-amber-600 dark:text-amber-500">
                  {geometry.proved}/{elements}
                </span>
              )}
            </div>
          )}

          {meshArea.withMesh > 0 && (
            <div
              className="flex items-baseline gap-2 whitespace-nowrap"
              title={t('measure.quantities.areaMeshTitle')}
            >
              <span className="w-[5.5rem] shrink-0 font-mono text-2xs uppercase tracking-wider text-muted-foreground">
                {t('measure.quantities.areaMeshLabel')}
              </span>
              <span className="font-mono text-2xs tabular-nums">{render(meshArea.total, 1)}</span>
              {meshArea.withoutMesh > 0 && (
                <span className="font-mono text-2xs text-amber-600 dark:text-amber-500">
                  {meshArea.withMesh}/{elements}
                </span>
              )}
            </div>
          )}

          {/* Derived mass (#2736). Each basis is its own row: a mass computed
              from a density the FILE declared and one estimated from a library
              default are different claims, and one total labelled "Weight"
              covering both would be exactly the false precision the gross/net
              split above exists to avoid. The label is never rendered apart
              from the number — they are the same element. */}
          {derivedWeights.map((r) => (
            <div
              key={r.basis}
              className="flex items-baseline gap-2 whitespace-nowrap"
              title={[t(DERIVED_WEIGHT_TITLE_KEY[r.basis as Exclude<WeightBasis, 'declared'>]), ...r.provenance].join('\n')}
            >
              <span className="w-[5.5rem] shrink-0 font-mono text-2xs uppercase tracking-wider text-muted-foreground">
                {t(DERIVED_WEIGHT_LABEL_KEY[r.basis as Exclude<WeightBasis, 'declared'>])}
              </span>
              <span className="font-mono text-2xs tabular-nums">
                {render(r.total, MEASURABLE_QUANTITY_TYPES.Weight)}
              </span>
              {r.contributing < elements && (
                <span className="font-mono text-2xs text-amber-600 dark:text-amber-500">
                  {r.contributing}/{elements}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* The openings question, stated rather than assumed. This tool never
          decides whether an opening is subtracted — it reports which
          convention each number was authored under and keeps them apart.
          Zones v2 (#2508) faces the same question when apportioning a wall's
          volume; stating it here is what lets the two features be compared
          instead of quietly differing. */}
      {!nothing && (
        <div className="font-mono text-2xs leading-tight text-muted-foreground">
          {t('measure.quantities.legend')}
        </div>
      )}

      {/* #2736's provenance requirement, stated rather than implied by a row
          label: a derived mass is a calculation of ours, not a quantity the
          file authored, and the reader is told which density it used. */}
      {derivedWeights.length > 0 && (
        <div className="font-mono text-2xs leading-tight text-muted-foreground">
          {derivedWeights.some((r) => r.basis === 'derived-library-density')
            ? t('measure.quantities.massLegendWithEstimated')
            : t('measure.quantities.massLegend')}
        </div>
      )}
    </div>
    </QuantityResultView>
  );
}
