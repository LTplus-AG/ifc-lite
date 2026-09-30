/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Model inspector's Dimensions section (charter #6232, M2 §1.7.2).
 *
 * Defaults mode edits what the next element is built with (the defaults
 * slice the command bars read too). Selection mode edits a wall's thickness
 * and height (`setWallSection`, one undo step, re-meshed through the
 * transaction); a slab's thickness and a column's or beam's length are shown
 * read-only for now.
 */

import { useId, useMemo } from 'react';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale';
import { authoringDim, type AuthoredElementKind } from '@/store/slices/authoringDefaultsSlice';
import { CommitField, InspectorCaption, InspectorRow, InspectorSection } from './InspectorControls';
import { DEFAULT_DIMS, DIM_LABEL, METRE_SYMBOL, formatMetres, parseMetres, type DimParam } from './inspector-fields';
import { setWallDimensions } from './inspector-edits';
import type { InspectorSelection } from './useInspectorTarget';

function MetreRow({ param, value, onCommit }: { param: DimParam; value: number | null; onCommit?: (metres: number) => boolean }) {
  const { t } = useTranslation();
  const id = useId();
  const label = t(DIM_LABEL[param]);
  const commit = (text: string) => {
    const metres = parseMetres(text);
    if (metres === null) { toast.error(t('modelInspector.dims.invalid')); return false; }
    return onCommit?.(metres) ?? false;
  };
  return (
    <InspectorRow label={label} htmlFor={id}>
      <CommitField
        id={id}
        value={value === null ? '' : formatMetres(value)}
        onCommit={commit}
        readOnly={!onCommit}
        suffix={METRE_SYMBOL}
        ariaLabel={t('modelInspector.dims.fieldAria', { label })}
      />
    </InspectorRow>
  );
}

export function DefaultDimensions({ kind }: { kind: AuthoredElementKind }) {
  const { t } = useTranslation();
  const defaults = useViewerStore((s) => s.authoringDefaults);
  const setDims = useViewerStore((s) => s.setAuthoringDims);
  // A picked section replaces the rectangle's own sides (Width x Height, Width x Depth): they are the Profile section's.
  const sectioned = (kind === 'beam' || kind === 'member' || kind === 'column') && defaults.profiles[kind].type !== 'Rectangle';
  const rectangleSides: readonly DimParam[] = ['Width', 'Depth', ...(kind === 'column' ? [] : ['Height' as const])];
  const params = DEFAULT_DIMS[kind].filter((param) => !sectioned || !rectangleSides.includes(param));
  if (params.length === 0) return null;
  return (
    <InspectorSection title={t('modelInspector.dims.title')}>
      {params.map((param) => (
        <MetreRow
          key={param}
          param={param}
          value={authoringDim(defaults, kind, param)}
          onCommit={(metres) => { setDims(kind, { [param]: metres }); return true; }}
        />
      ))}
    </InspectorSection>
  );
}

type Measured =
  | { kind: 'wall'; length: number; thickness: number; height: number }
  | { kind: 'readOnly'; rows: Array<[DimParam, number]> }
  | { kind: 'none'; reason: 'modelInspector.dims.notRectangular' | 'modelInspector.dims.unknown' };

function measure(selection: InspectorSelection): Measured {
  const s = useViewerStore.getState();
  const { modelId, expressId, kind } = selection;
  if (kind === 'wall') {
    const wall = s.readWallEndpoints(modelId, expressId);
    if (!wall) return { kind: 'none', reason: 'modelInspector.dims.notRectangular' };
    const length = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
    return { kind: 'wall', length, thickness: wall.thickness, height: wall.height };
  }
  if (kind === 'slab' || kind === 'roof' || kind === 'plate') {
    const slab = s.readSlabFootprint(modelId, expressId);
    if (slab) return { kind: 'readOnly', rows: [['Thickness', slab.thickness]] };
  }
  if (kind === 'column' || kind === 'beam' || kind === 'member') {
    const linear = s.readLinearElementSplitProjection(modelId, expressId, [0, 0, 0]);
    const scale = getModelLengthUnitScale(selection.live.dataStore);
    if (linear) return { kind: 'readOnly', rows: [[kind === 'column' ? 'Height' : 'Length', linear.length * scale]] };
  }
  return { kind: 'none', reason: 'modelInspector.dims.unknown' };
}

export function SelectionDimensions({ selection }: { selection: InspectorSelection }) {
  const { t } = useTranslation();
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const measured = useMemo(() => { void mutationVersion; return measure(selection); }, [selection, mutationVersion]);
  const { modelId, expressId } = selection;

  return (
    <InspectorSection title={t('modelInspector.dims.title')}>
      {measured.kind === 'wall' && (
        <>
          <MetreRow param="Length" value={measured.length} />
          <MetreRow param="Thickness" value={measured.thickness} onCommit={(thickness) => setWallDimensions(modelId, expressId, { thickness })} />
          <MetreRow param="Height" value={measured.height} onCommit={(height) => setWallDimensions(modelId, expressId, { height })} />
        </>
      )}
      {measured.kind === 'readOnly' && (
        <>
          {measured.rows.map(([param, value]) => <MetreRow key={param} param={param} value={value} />)}
          <InspectorCaption>{t('modelInspector.dims.readOnly')}</InspectorCaption>
        </>
      )}
      {measured.kind === 'none' && <InspectorCaption>{t(measured.reason)}</InspectorCaption>}
    </InspectorSection>
  );
}
