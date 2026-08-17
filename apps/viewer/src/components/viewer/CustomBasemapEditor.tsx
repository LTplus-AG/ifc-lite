/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Input surface for the custom XYZ basemap (issue #2685).
 *
 * Lives under the Base map selector in the Sun & Sky panel, shown only when the
 * `custom` source is picked. Four fields, three of which are the protocol: a
 * tile URL template, the attribution the licence requires, an optional link for
 * it, and the server's deepest zoom.
 */

import { useState } from 'react';
import { useViewerStore } from '@/store';
import {
  probeTileAccess,
  validateCustomBasemap,
  type CustomBasemapField,
  type TileAccessResult,
} from '@/lib/geo/custom-basemap';

const FIELD_CLASS = 'w-full bg-muted/40 rounded px-1.5 py-1 border text-foreground text-[10px]';
const LABEL_CLASS = 'text-[9px] uppercase tracking-wider text-muted-foreground';

export function CustomBasemapEditor() {
  const stored = useViewerStore((s) => s.cesiumCustomBasemap);
  const saveBasemap = useViewerStore((s) => s.setCesiumCustomBasemap);

  const [url, setUrl] = useState(stored?.url ?? '');
  const [credit, setCredit] = useState(stored?.credit ?? '');
  const [creditUrl, setCreditUrl] = useState(stored?.creditUrl ?? '');
  const [maximumLevel, setMaximumLevel] = useState(
    stored?.maximumLevel === undefined ? '' : String(stored.maximumLevel),
  );
  const [problem, setProblem] = useState<{ field: CustomBasemapField; message: string } | null>(null);
  const [probe, setProbe] = useState<TileAccessResult | null>(null);
  const [checking, setChecking] = useState(false);

  const onSave = async () => {
    setProbe(null);
    const result = validateCustomBasemap({
      protocol: 'xyz',
      url,
      credit,
      creditUrl,
      maximumLevel: maximumLevel.trim() === '' ? undefined : Number(maximumLevel),
    });
    if (!result.ok) {
      setProblem({ field: result.field, message: result.message });
      return;
    }
    setProblem(null);
    saveBasemap(result.basemap);
    // Then ask the server whether a browser may actually read its tiles. The
    // save is not gated on it: a probe can also fail because the user is
    // offline, and locking the setting behind a network round-trip would be
    // worse than telling them what happened. The viewport carries the same
    // verdict at runtime via the provider's error event.
    setChecking(true);
    try {
      setProbe(await probeTileAccess(result.basemap));
    } finally {
      setChecking(false);
    }
  };

  const onRemove = () => {
    saveBasemap(null);
    setProbe(null);
    setProblem(null);
  };

  return (
    <div className="flex flex-col gap-1 pt-1 border-t">
      <label className="flex flex-col gap-0.5">
        <span className={LABEL_CLASS}>Tile URL template</span>
        <input
          aria-label="Tile URL template"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.org/tiles/{z}/{x}/{y}.png"
          spellCheck={false}
          className={FIELD_CLASS}
        />
      </label>

      <label className="flex flex-col gap-0.5">
        <span className={LABEL_CLASS}>Attribution (required)</span>
        <input
          aria-label="Attribution"
          value={credit}
          onChange={(e) => setCredit(e.target.value)}
          placeholder="Imagery © provider, CC BY 4.0"
          className={FIELD_CLASS}
        />
      </label>

      <div className="flex gap-1">
        <label className="flex flex-col gap-0.5 flex-1">
          <span className={LABEL_CLASS}>Attribution link</span>
          <input
            aria-label="Attribution link"
            value={creditUrl}
            onChange={(e) => setCreditUrl(e.target.value)}
            placeholder="https://…/licence"
            spellCheck={false}
            className={FIELD_CLASS}
          />
        </label>
        <label className="flex flex-col gap-0.5 w-16">
          <span className={LABEL_CLASS}>Max zoom</span>
          <input
            aria-label="Maximum zoom"
            value={maximumLevel}
            onChange={(e) => setMaximumLevel(e.target.value)}
            placeholder="19"
            inputMode="numeric"
            className={FIELD_CLASS}
          />
        </label>
      </div>

      {/* Privacy: a custom basemap sends the viewport to a third party on every
          pan. That is what a basemap is for, but it should be the pasting
          user's deliberate choice rather than something they discover. */}
      <p className="text-[9px] leading-tight text-muted-foreground">
        Tiles are requested straight from this server, so it sees where you pan and zoom.
      </p>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onSave}
          disabled={checking}
          className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase bg-primary text-primary-foreground disabled:opacity-50"
        >
          {checking ? 'Checking…' : 'Save basemap'}
        </button>
        {stored && (
          <button
            type="button"
            onClick={onRemove}
            className="px-2 py-0.5 rounded text-[10px] uppercase text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Remove
          </button>
        )}
      </div>

      {problem && (
        <p role="alert" className="text-[9px] leading-tight text-red-400">{problem.message}</p>
      )}
      {probe?.status === 'blocked' && (
        <p role="alert" className="text-[9px] leading-tight text-red-400">{probe.message}</p>
      )}
      {/* CORS passed, but the server still refused the tile (401/403). Calm
          `role="status"` wording would read as reassurance for a basemap that
          will never draw, so an actionable probe result gets alert treatment. */}
      {probe?.status === 'ok' && probe.concerning && (
        <p role="alert" className="text-[9px] leading-tight text-amber-400">{probe.message}</p>
      )}
      {probe?.status === 'ok' && !probe.concerning && (
        <p role="status" className="text-[9px] leading-tight text-muted-foreground">
          {probe.message ?? 'Saved. This server allows browser access.'}
        </p>
      )}
    </div>
  );
}
