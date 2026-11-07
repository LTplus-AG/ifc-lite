/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The LIST tab of the Measurements panel (#5502): every finished
 * measurement of every kind, each in its own list, plus the gesture in
 * progress. Distances, polylines, angles and radii are kept in separate
 * lists rather than merged: an open length, a closed perimeter, an angle
 * and a fitted radius are different KINDS of number from a point-to-point
 * distance, so blending them into one "Total" would add numbers that don't
 * share a basis.
 */

import { useCallback, useId, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { Check, Ruler, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { useViewerStore, type Measurement } from '@/store';
import { useTranslation } from '@/i18n/useTranslation';
import { StaleMeasurementBadge } from '../reposition/StaleMeasurementBadge';
import { formatDistance } from './formatDistance';
import { distanceComponents, formatAxisDeltas, formatHorizontalVertical } from './measure-modes/components';
import { inclination, formatInclination } from './measure-modes/inclination';
import { polylineBasisLabelKey } from './measure-modes/polyline';
import { projectedEnh, EnhLine } from './measure-modes/geo-readout';
import { useAnchorGeoreference, type AnchorGeoreference } from '@/lib/geo/useAnchorGeoreference';
import { finishOpenPolyline, finishOpenRadius } from '@/store/finishMeasureSequence';
import { dispatchKeyboardDown } from '@/lib/commands/dispatcher';
import { ANGLE_REQUIRED_PICKS, formatAngleMeasurement, formatRadiusPoints } from './measure-modes/readouts';

const ROW = 'rounded bg-muted/50 px-2 py-1 text-xs';
const ROW_LIVE = 'flex items-center justify-between gap-2 rounded bg-overlay-accent-soft px-2 py-1 text-xs';
// `size="icon-sm"` (32px) overridden to h-5 w-5 (20px): 2px a side of
// hit-slop reaches the WCAG 2.2 2.5.8 24px minimum (#5826). Each of these
// buttons is the last (or only) item in its `justify-between` row, so
// there is no neighbour to overlap; a live row's Finish and Cancel pair sits
// in a `gap-2` group, which leaves 4px between their slops so a finger aimed
// at Finish does not land on the destructive Cancel.
const HIT_SLOP = 'relative after:absolute after:-inset-0.5 after:content-[""]';
const DELETE = `h-5 w-5 shrink-0 hover:bg-destructive/20 ${HIT_SLOP}`;
// A recorded row, or the list when there is none, takes focus when the row
// that held it goes away (#9041, #9124); a ring shows a keyboard user where
// they landed.
const FOCUS_TARGET = 'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring';
// A recorded row is a native group (`fieldset`: its delete button under the
// row's name). `min-w-0` undoes a fieldset's min-content width in a narrow panel.
const ROW_TARGET = `${ROW} min-w-0 ${FOCUS_TARGET}`;

/** An open sequence whose live row has Finish and Cancel. */
type LiveKind = 'polyline' | 'radius';

/**
 * The row that held focus as it went away: a live row, or a recorded row with
 * the ids of every recorded row in list order at that moment.
 */
type LostFocus = { live: LiveKind } | { row: string; order: readonly string[] };

export function MeasurementList() {
  const { t } = useTranslation();
  const measurements = useViewerStore((s) => s.measurements);
  const activePolyline = useViewerStore((s) => s.activePolyline);
  const polylineMeasurements = useViewerStore((s) => s.polylineMeasurements);
  const angleMeasurements = useViewerStore((s) => s.angleMeasurements);
  const activeAngle = useViewerStore((s) => s.activeAngle);
  const radiusMeasurements = useViewerStore((s) => s.radiusMeasurements);
  const activeRadius = useViewerStore((s) => s.activeRadius);
  const activeTool = useViewerStore((s) => s.activeTool);
  const setActiveTool = useViewerStore((s) => s.setActiveTool);
  const cancelPolyline = useViewerStore((s) => s.cancelPolyline);
  const cancelRadius = useViewerStore((s) => s.cancelRadius);
  const deleteMeasurement = useViewerStore((s) => s.deleteMeasurement);
  const deletePolylineMeasurement = useViewerStore((s) => s.deletePolylineMeasurement);
  const deleteAngleMeasurement = useViewerStore((s) => s.deleteAngleMeasurement);
  const deleteRadiusMeasurement = useViewerStore((s) => s.deleteRadiusMeasurement);
  const unitDisplayOverrides = useViewerStore((s) => s.unitDisplayOverrides);
  const geoReadoutEnabled = useViewerStore((s) => s.geoReadoutEnabled);
  const stale = useViewerStore((s) => s.placementStaleMeasurements);
  const anchor = useAnchorGeoreference();
  const geoAnchor = geoReadoutEnabled ? anchor : null;

  // When a row goes away while it holds focus, focus would fall to the page.
  // #9041: a live row (Finish, Cancel, Esc or Enter pressed on its buttons)
  // hands it to the row that sequence recorded, or to the list when it
  // recorded nothing. #9124: a deleted row hands it to the next row, else the
  // previous one, else the list. A row, never its delete button: a second or
  // held Enter or Space has nothing left to act on, where on a focused button
  // it would delete another measurement. A row that goes away without focus
  // (Enter or Esc from the canvas, a click that did not focus the button)
  // moves nothing.
  const listRef = useRef<HTMLFieldSetElement>(null);
  const lostFocus = useRef<LostFocus | null>(null);
  const recordedRowLostFocus = useCallback((id: string) => {
    const rows = listRef.current?.querySelectorAll<HTMLElement>('[data-measurement-id]') ?? [];
    lostFocus.current = { row: id, order: [...rows].map((el) => el.dataset.measurementId ?? '') };
  }, []);
  const previousRows = useRef({ polyline: polylineMeasurements, radius: radiusMeasurements });
  useLayoutEffect(() => {
    const before = previousRows.current;
    const rows = { polyline: polylineMeasurements, radius: radiusMeasurements };
    previousRows.current = rows;
    const lost = lostFocus.current;
    lostFocus.current = null;
    const list = listRef.current;
    if (!lost || !list) return;
    const active = list.ownerDocument.activeElement;
    if (active && active !== list.ownerDocument.body && active.isConnected) return;
    let candidates: readonly string[];
    if ('live' in lost) {
      const known = new Set(before[lost.live].map((m) => m.id));
      candidates = rows[lost.live].filter((m) => !known.has(m.id)).map((m) => m.id);
    } else {
      const at = lost.order.indexOf(lost.row);
      candidates = [...lost.order.slice(at + 1), ...lost.order.slice(0, Math.max(at, 0)).reverse()];
    }
    const shown = new Map([...list.querySelectorAll<HTMLElement>('[data-measurement-id]')].map((el) => [el.dataset.measurementId, el]));
    const row = candidates.map((id) => shown.get(id)).find((el) => el !== undefined);
    (row ?? list).focus();
  });
  // The list is a native group (`fieldset`) named "Measurements taken": the
  // target when nothing was recorded. Both branches below render one, so it is
  // the same node when Cancel empties the list.
  const listProps = {
    ref: listRef,
    tabIndex: -1,
    'aria-label': t('measure.section.list.title'),
  } as const;

  const totalDistance = measurements.reduce((sum, m) => sum + (stale.has(m.id) ? 0 : m.distance), 0);
  const totalItemCount =
    measurements.length + polylineMeasurements.length + angleMeasurements.length + radiusMeasurements.length;

  if (totalItemCount === 0 && !activePolyline && !activeAngle && !activeRadius) {
    return (
      <fieldset {...listProps} className={`flex min-w-0 flex-col items-center gap-2 px-3 py-8 text-center text-xs text-muted-foreground ${FOCUS_TARGET}`}>
        <span>{t('measure.list.empty')}</span>
        {activeTool !== 'measure' && (
          <Button variant="outline" size="sm" onClick={() => setActiveTool('measure')}>
            <Ruler className="mr-1.5 h-3.5 w-3.5" />
            {t('measure.panel.startMeasuring')}
          </Button>
        )}
      </fieldset>
    );
  }

  return (
    <fieldset {...listProps} className={`min-w-0 space-y-1 px-3 py-2 ${FOCUS_TARGET}`}>
      {measurements.map((m, i) => (
        <MeasurementItem
          key={m.id}
          measurement={m}
          index={i}
          onDelete={deleteMeasurement}
          onLostFocus={recordedRowLostFocus}
          deleteLabel={t('measure.list.deleteDistance', { index: i + 1 })}
          geoAnchor={geoAnchor}
          unitDisplayOverrides={unitDisplayOverrides}
        />
      ))}
      {measurements.length > 1 && (
        <div className="mt-1 flex items-center justify-between border-t pt-1 text-xs font-medium">
          <span>{t('measure.list.totalCurrent')}</span>
          <span className="tabular-nums">{formatDistance(totalDistance, unitDisplayOverrides)}</span>
        </div>
      )}

      {activePolyline && (
        <div className={ROW_LIVE}>
          <span className="tabular-nums">{t('measure.polyline.inProgress', { count: activePolyline.points.length })}</span>
          <LiveRowActions kind="polyline" onFinish={finishOpenPolyline} onCancel={cancelPolyline} lostFocus={lostFocus} />
        </div>
      )}
      {polylineMeasurements.map((pl, i) => (
        <RecordedRow
          key={pl.id}
          id={pl.id}
          label={<>{t('measure.polyline.indexLabel', { index: i + 1 })} · {t(polylineBasisLabelKey(pl.closed))}</>}
          value={formatDistance(pl.length, unitDisplayOverrides)}
          deleteLabel={t('measure.list.deletePolyline', { index: i + 1 })}
          onDelete={deletePolylineMeasurement}
          onLostFocus={recordedRowLostFocus}
        />
      ))}

      {angleMeasurements.map((a, i) => (
        <RecordedRow
          key={a.id}
          id={a.id}
          label={t('measure.angle.indexLabel', { index: i + 1 })}
          // Derived on render, never stored (see measure-modes/readouts).
          value={formatAngleMeasurement(a)}
          deleteLabel={t('measure.list.deleteAngle', { index: i + 1 })}
          onDelete={deleteAngleMeasurement}
          onLostFocus={recordedRowLostFocus}
        />
      ))}
      {activeAngle && (
        <div className={ROW_LIVE}>
          <span className="tabular-nums">
            {t('measure.angle.inProgress', {
              picks: activeAngle.picks.length,
              required: ANGLE_REQUIRED_PICKS[activeAngle.kind],
            })}
            {activeAngle.kind === 'points' && activeAngle.picks.length === 1 ? t('measure.angle.apexSetSuffix') : ''}
            {activeAngle.kind === 'edges' && activeAngle.picks.length === 2 ? t('measure.angle.firstEdgeSetSuffix') : ''}
          </span>
        </div>
      )}

      {radiusMeasurements.map((r, i) => (
        <RecordedRow
          key={r.id}
          id={r.id}
          label={t('measure.radius.indexLabel', { index: i + 1 })}
          value={formatRadiusPoints(r.points, unitDisplayOverrides)}
          wideValue
          deleteLabel={t('measure.list.deleteRadius', { index: i + 1 })}
          onDelete={deleteRadiusMeasurement}
          onLostFocus={recordedRowLostFocus}
        />
      ))}
      {activeRadius && (
        <div className={ROW_LIVE}>
          {/* Live: the same fit the finished list uses, re-derived on every
              added point — reaches "fitted"/"refused" as soon as the picks
              clear the module's gate, no finish step required to SEE it. */}
          <span className="tabular-nums">
            {t('measure.radius.inProgress', { count: activeRadius.points.length })} · {formatRadiusPoints(activeRadius.points, unitDisplayOverrides)}
          </span>
          <LiveRowActions kind="radius" onFinish={finishOpenRadius} onCancel={cancelRadius} lostFocus={lostFocus} />
        </div>
      )}
    </fieldset>
  );
}

/**
 * Calls `report` on unmount when focus is inside `ref`'s element (#9041,
 * #9124). A layout effect's cleanup runs while the row is still in the
 * document, so the focused button is still `activeElement` here; the list's
 * layout effect then moves focus once the commit is done.
 */
function useReportFocusOnUnmount(ref: RefObject<HTMLElement | null>, report: () => void): void {
  const latest = useRef(report);
  useLayoutEffect(() => { latest.current = report; });
  useLayoutEffect(() => {
    const el = ref.current;
    return () => {
      if (el?.contains(el.ownerDocument.activeElement)) latest.current();
    };
  }, [ref]);
}

/**
 * #9169: while a focused button's tooltip is open it takes Esc first (Radix
 * prevents its default, so the keyboard dispatcher skips it), and cancelling
 * took two presses. On the live row's two buttons, whose labels name Enter
 * and Esc, Esc runs its key command at once, exactly as it would with no
 * tooltip open; ending the row closes the tooltip with it. Nowhere else: on
 * other buttons the first Esc still only closes the tooltip (WCAG 1.4.13),
 * so it never also clears a selection or a tool.
 */
function runEscapeCommand(event: KeyboardEvent): void {
  dispatchKeyboardDown(event);
}

/**
 * Finish and Cancel for an open Polyline or Radius. Finish is the same call as
 * Enter, and the only finish a touch user has (#8991).
 */
function LiveRowActions({ kind, onFinish, onCancel, lostFocus }: {
  kind: LiveKind;
  onFinish: () => void;
  onCancel: () => void;
  lostFocus: RefObject<LostFocus | null>;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLSpanElement>(null);
  useReportFocusOnUnmount(ref, () => { lostFocus.current = { live: kind }; });
  return (
    <span ref={ref} className="flex shrink-0 items-center gap-2">
      <IconButton label={t('measure.finishEnter')} variant="ghost" size="icon-sm" className={`h-5 w-5 ${HIT_SLOP}`} onClick={onFinish} onTooltipEscapeKeyDown={runEscapeCommand}>
        <Check className="h-3 w-3" />
      </IconButton>
      <IconButton label={t('measure.cancelEsc')} variant="ghost" size="icon-sm" className={`h-5 w-5 ${HIT_SLOP}`} onClick={onCancel} onTooltipEscapeKeyDown={runEscapeCommand}>
        <X className="h-3 w-3" />
      </IconButton>
    </span>
  );
}

/**
 * One finished measurement: a native group (`fieldset`) named by its own label
 * and value, "Poly #2 · Length 5.000 m", so a screen reader says what a
 * focused row holds; its delete button sits under that name. Focusable from
 * script only (#9041, #9124), never a Tab stop.
 */
function RecordedRow({ id, label, value, wideValue = false, deleteLabel, onDelete, onLostFocus, children }: {
  id: string;
  label: ReactNode;
  value: ReactNode;
  /** A long value (a fitted radius) keeps the label whole and wraps itself. */
  wideValue?: boolean;
  deleteLabel: string;
  onDelete: (id: string) => void;
  onLostFocus: (id: string) => void;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLFieldSetElement>(null);
  const name = useId();
  useReportFocusOnUnmount(ref, () => onLostFocus(id));
  return (
    <fieldset ref={ref} className={ROW_TARGET} tabIndex={-1} data-measurement-id={id} aria-labelledby={`${name}label ${name}value`}>
      <div className="flex items-center gap-2">
        <span id={`${name}label`} className={`${wideValue ? 'shrink-0 ' : ''}text-muted-foreground`}>
          {label}
          <StaleMeasurementBadge id={id} />
        </span>
        <span id={`${name}value`} className={`ml-auto ${wideValue ? 'text-right ' : ''}font-medium tabular-nums`}>{value}</span>
        <IconButton label={deleteLabel} variant="ghost" size="icon-sm" className={DELETE} onClick={() => onDelete(id)}>
          <X className="h-3 w-3" />
        </IconButton>
      </div>
      {children}
    </fieldset>
  );
}

interface MeasurementItemProps {
  measurement: Measurement;
  index: number;
  onDelete: (id: string) => void;
  onLostFocus: (id: string) => void;
  deleteLabel: string;
  /** When set, show real-world E/N/H for the measurement's two endpoints. */
  geoAnchor: AnchorGeoreference | null;
  /** The user's per-unit-type display override (#1573). */
  unitDisplayOverrides: Record<string, string>;
}

function MeasurementItem({ measurement, index, onDelete, onLostFocus, deleteLabel, geoAnchor, unitDisplayOverrides }: MeasurementItemProps) {
  // Pure display: derived from the stored endpoints, nothing is persisted.
  const components = distanceComponents(measurement.start, measurement.end);
  return (
    <RecordedRow
      id={measurement.id}
      label={`#${index + 1}`}
      value={formatDistance(measurement.distance, unitDisplayOverrides)}
      deleteLabel={deleteLabel}
      onDelete={onDelete}
      onLostFocus={onLostFocus}
    >
      <div className="overflow-x-auto whitespace-nowrap font-mono text-2xs leading-tight text-muted-foreground">
        <div>{formatAxisDeltas(components, unitDisplayOverrides)}</div>
        <div>{formatHorizontalVertical(components, unitDisplayOverrides)}</div>
        {/* Inclination, derived from the same two endpoints (#2199 §4). */}
        <div>{formatInclination(inclination(components))}</div>
      </div>
      {geoAnchor && (
        <div className="mt-0.5 overflow-x-auto">
          <EnhLine label="A" enh={projectedEnh(measurement.start, geoAnchor)} />
          <EnhLine label="B" enh={projectedEnh(measurement.end, geoAnchor)} />
        </div>
      )}
    </RecordedRow>
  );
}
