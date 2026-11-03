/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * React mount for the start screen's layered 3D mark: drag to spin, hover a
 * block for an inspector-style tag.
 *
 * Default-exported and loaded through `React.lazy` by `ViewportWelcome`, so
 * three.js stays out of the viewer's first-load bundle. On a device that
 * refuses WebGL it renders nothing — the mark is decoration and the screen is
 * complete without it.
 *
 * The tag follows its block every frame while the mark spins. That position is
 * written straight to the DOM from the scene's `onTagAnchor` callback; React
 * only re-renders when the hovered block changes.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useThreeScene } from '@/components/mcp/useThreeScene';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { useViewerStore } from '@/store';
import { createWelcomeScene, type WelcomeHoverTarget, type WelcomeSceneHandle } from './welcome-scene';
import { blockTag } from './welcome-scene-layout';

/** EXPRESS names, shown verbatim (never translated): the tag mimics the
 *  Properties panel, which shows IFC attribute names as the schema spells them. */
const IFC_CLASS = 'IfcColumn';
const ATTR_GLOBAL_ID = 'GlobalId';
const ATTR_HEIGHT = 'Height';
const ATTR_LOAD_BEARING = 'LoadBearing';
const LOAD_BEARING_VALUE = 'TRUE';

const CARD_W = 248;
const CARD_OFFSET_X = 56;
const CARD_OFFSET_Y = -118;

export default function WelcomeLayerScene() {
  const { t, locale } = useTranslation();
  const theme = useViewerStore((s) => s.theme);
  const dark = theme === 'dark';
  const [hover, setHover] = useState<WelcomeHoverTarget | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<SVGLineElement>(null);
  const dotRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);

  // The scene reports the anchor in the same frame it reports the hover, before
  // React has mounted the tag; keep it so the tag is placed as it mounts.
  const anchorRef = useRef<{ x: number; y: number } | null>(null);
  const placeTag = useCallback((x: number, y: number) => {
    anchorRef.current = { x, y };
    const card = cardRef.current;
    const line = lineRef.current;
    const dot = dotRef.current;
    const host = hostRef.current;
    if (!card || !line || !dot || !host) return;
    const w = host.clientWidth;
    // Right of the block when it fits, otherwise mirrored to the left.
    const right = x + CARD_OFFSET_X + CARD_W <= w - 8;
    const cx = right ? x + CARD_OFFSET_X : Math.max(8, x - CARD_OFFSET_X - CARD_W);
    const cy = Math.max(8, y + CARD_OFFSET_Y);
    card.style.transform = `translate(${cx}px, ${cy}px)`;
    dot.style.transform = `translate(${x - 3.5}px, ${y - 3.5}px)`;
    line.setAttribute('x1', String(x));
    line.setAttribute('y1', String(y));
    line.setAttribute('x2', String(right ? cx : cx + CARD_W));
    line.setAttribute('y2', String(cy + 22));
  }, []);

  const { containerRef, handleRef, unavailable } = useThreeScene<WelcomeSceneHandle>(
    'welcome',
    (el) => createWelcomeScene(el, dark, { onHover: setHover, onTagAnchor: placeTag }),
  );

  useEffect(() => {
    handleRef.current?.setDark(dark);
  }, [dark, handleRef]);

  // Place a freshly mounted tag before paint, so it never flashes at 0,0.
  const hovering = hover !== null;
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (hovering && anchor) placeTag(anchor.x, anchor.y);
  }, [hovering, placeTag]);

  if (unavailable) return null;
  const tag = hover ? blockTag(hover.layer, hover.column) : null;
  const metres = (value: number) =>
    t('viewportLighting.container.emptyState.scene.metres', {
      value: formatLocaleNumber(locale, value, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    });

  return (
    <div ref={hostRef} className="relative h-full w-full select-none">
      <div ref={containerRef} className="h-full w-full" aria-hidden="true" />
      {tag && (
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
          <svg className="absolute inset-0 h-full w-full overflow-visible">
            <line ref={lineRef} className="stroke-primary" strokeWidth={1} />
          </svg>
          <div ref={dotRef} className="absolute left-0 top-0 h-[7px] w-[7px] rounded-full bg-primary" />
          <div
            ref={cardRef}
            style={{ width: CARD_W }}
            className="absolute left-0 top-0 rounded-md border border-zinc-300 bg-white text-xs shadow-lg dark:border-[#3b4261] dark:bg-[#16161e]"
          >
            <div className="border-b border-zinc-200 px-3 pb-2 pt-2.5 dark:border-[#262a3d]">
              <div className="text-sm font-semibold text-zinc-900 dark:text-[#c0caf5]">
                {IFC_CLASS} · {tag.name}
              </div>
              <div className="text-zinc-500 dark:text-[#9aa3c7]">
                {t('viewportLighting.container.emptyState.scene.layerOf', {
                  index: tag.layer + 1,
                  count: tag.layerCount,
                  file: tag.layerFile,
                })}
              </div>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-3 py-2">
              <dt className="text-zinc-500 dark:text-[#9aa3c7]">{ATTR_GLOBAL_ID}</dt>
              <dd className="text-right font-mono text-2xs text-zinc-900 dark:text-[#c0caf5]">{tag.globalId}</dd>
              <dt className="text-zinc-500 dark:text-[#9aa3c7]">{ATTR_HEIGHT}</dt>
              <dd className="text-right tabular-nums text-zinc-900 dark:text-[#c0caf5]">{metres(tag.columnHeight)}</dd>
              <dt className="text-zinc-500 dark:text-[#9aa3c7]">{ATTR_LOAD_BEARING}</dt>
              <dd className="text-right text-zinc-900 dark:text-[#c0caf5]">{LOAD_BEARING_VALUE}</dd>
            </dl>
          </div>
        </div>
      )}
    </div>
  );
}
