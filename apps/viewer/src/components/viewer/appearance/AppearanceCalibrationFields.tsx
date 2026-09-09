/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { rasterLandmarkAt, rasterLandmarkFraction, type RasterCalibration, type RasterCalibrationFrame } from '@/lib/appearance/raster-calibration.js';

type Point = [number, number];
export interface AppearanceCalibrationProps {
  frame: RasterCalibrationFrame;
  sourceKey: string;
  thumbnailUrl: string;
  value?: RasterCalibration;
  onChange(value: RasterCalibration): void;
  disabled: boolean;
  onInvalid(name: string, invalid: boolean): void;
}
export function AppearanceCalibrationFields({ frame, thumbnailUrl, value, onChange, disabled, onInvalid }: AppearanceCalibrationProps) {
  const [points, setPoints] = useState<Array<Point | undefined>>(() => value?.sourcePoints ?? []);
  const [active, setActive] = useState<0 | 1>(0);
  const [cursor, setCursor] = useState<Point>([0.5, 0.5]);
  const [distance, setDistance] = useState(value ? String(value.distanceMetres) : '');
  const metres = Number(distance);
  const a = points[0], b = points[1];
  const invalid = !a || !b || (a[0] === b[0] && a[1] === b[1]) || !distance.trim() || !Number.isFinite(metres) || metres <= 0;
  useEffect(() => { onInvalid('source-calibration', !!invalid); }, [invalid, onInvalid]);
  useEffect(() => () => onInvalid('source-calibration', false), [onInvalid]);

  function publish(next: Array<Point | undefined>, text: string): void {
    const first = next[0], second = next[1], span = Number(text);
    if (first && second && (first[0] !== second[0] || first[1] !== second[1]) && text.trim() && Number.isFinite(span) && span > 0) {
      onChange({ sourcePoints: [first, second], distanceMetres: span });
    }
  }
  function choose(fraction: Point): void {
    const next = [...points];
    next[active] = rasterLandmarkAt(frame, fraction);
    setPoints(next); setCursor(fraction); setActive(active === 0 ? 1 : 0);
    publish(next, distance);
  }
  return <fieldset disabled={disabled} className="space-y-2">
    <legend className="mb-2 text-xs font-medium">Drawing scale</legend>
    <p className="text-[11px] text-muted-foreground">Choose two known points, then enter their distance in the building. The same scale applies across all selected objects.</p>
    <div className="flex gap-2">{([0, 1] as const).map(index => <button key={index} type="button"
      className="rounded border px-2 py-1 text-xs aria-pressed:border-primary aria-pressed:text-primary"
      aria-pressed={active === index} onClick={() => setActive(index)}>Point {index === 0 ? 'A' : 'B'}</button>)}</div>
    <button type="button" aria-label="Choose calibration landmarks on page" aria-describedby="appearance-calibration-help"
      className="relative block w-full overflow-hidden rounded border focus-visible:outline focus-visible:outline-primary"
      onClick={event => {
        if (event.detail === 0) { choose(cursor); return; }
        const rect = event.currentTarget.querySelector('img')?.getBoundingClientRect();
        if (rect && rect.width > 0 && rect.height > 0) choose([
          Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
          Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
        ]);
      }} onKeyDown={event => {
        const directions: Record<string, Point> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        const delta = directions[event.key];
        if (!delta) return;
        event.preventDefault();
        const step = event.shiftKey ? 0.1 : 0.01;
        setCursor(previous => [Math.max(0, Math.min(1, previous[0] + delta[0] * step)),
          Math.max(0, Math.min(1, previous[1] + delta[1] * step))]);
      }}>
      <img src={thumbnailUrl} alt="Source image to calibrate" className="block h-auto w-full" draggable={false} />
      {points.map((point, index) => {
        if (!point) return null;
        const [x, y] = rasterLandmarkFraction(frame, point);
        if (x < 0 || x > 1 || y < 0 || y > 1) return null;
        return <span key={index} aria-hidden="true" className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary px-1 text-xs font-bold text-primary-foreground"
          style={{ left: `${x * 100}%`, top: `${y * 100}%` }}>{index === 0 ? 'A' : 'B'}</span>;
      })}
      <span aria-hidden="true" className="pointer-events-none absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-black/60"
        style={{ left: `${cursor[0] * 100}%`, top: `${cursor[1] * 100}%` }} />
    </button>
    <p id="appearance-calibration-help" className="text-[10px] text-muted-foreground">Click to place A and B. With the page focused, use arrow keys to move the cursor and Enter to place a point.</p>
    <label className="block space-y-1 text-[11px]"><span>Distance A–B (m)</span>
      <Input type="number" min="0" step="any" value={distance} aria-label="Distance A–B (m)"
        aria-invalid={distance !== '' && (!Number.isFinite(metres) || metres <= 0)}
        onChange={event => { setDistance(event.currentTarget.value); publish(points, event.currentTarget.value); }} />
    </label>
    {invalid && <p role="status" className="text-[11px] text-muted-foreground">Choose two distinct points and enter a positive measured distance.</p>}
  </fieldset>;
}
