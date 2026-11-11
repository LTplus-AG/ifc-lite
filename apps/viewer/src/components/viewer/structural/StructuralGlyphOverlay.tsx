/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The structural glyph overlay (#9668), loaded lazily by `StructuralGlyphLayer`
 * once a loaded model carries structural connections or actions.
 *
 * The adapter between the parser's plain-data glyph list
 * (`structuralGlyphs`, IFC world metres) and the scene-overlay kernel: each
 * model's list is moved into that model's render frame (`toViewGlyphs`), then
 * drawn as one SVG path per source entity in the kernel's SVG layer. React
 * renders the paths once per glyph list; every dirty projector tick rewrites
 * their `d` in place (`glyphPath`), so orbiting costs a projection pass and
 * no React render.
 *
 * Every load group is shown at once: the viewer has no load group or load
 * case selection. Arrow lengths are relative within each load group.
 *
 * Clicking a glyph selects its connection or activity, the same way a
 * related-entity row in the properties panel selects (#9763).
 */

import { createPortal } from 'react-dom';
import { useEffect, useId, useMemo, useRef } from 'react';
import type { IfcDataStore, StructuralExtraction } from '@ifc-lite/parser';
import { structuralGlyphs, type StructuralGlyph } from '@ifc-lite/parser/structural-glyphs';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useSceneLayer, useSceneProjector } from '@/components/viewport-ui/scene';
import { effectiveStructuralData } from '../properties/effectiveStructuralData';
import { glyphPath, toViewGlyphs, type Project, type ViewGlyph } from './structural-glyph-paths';

type Style = 'support' | 'force' | 'moment' | 'temperature' | 'displacement';

interface SourceGroup {
  key: string;
  modelId: string;
  expressId: number;
  style: Style;
  title: string;
  glyphs: ViewGlyph[];
  /** Largest symbol size in the world, metres. */
  worldCap: number;
}

/** Stroke per style; distinct hues that read on the light and the dark viewport background. */
const STROKE: Record<Style, string> = {
  support: '#14b8a6',
  force: '#ef4444',
  moment: '#a855f7',
  temperature: '#f59e0b',
  displacement: '#3b82f6',
};

/** World cap of a symbol: this share of the model's diagonal, at least 0.25 m. */
const WORLD_CAP_SHARE = 0.03;
const WORLD_CAP_MIN = 0.25;

const LABEL: Record<string, TranslationKey> = {
  fixed: 'structuralGlyphs.support.fixed',
  pinned: 'structuralGlyphs.support.pinned',
  roller: 'structuralGlyphs.support.roller',
  spring: 'structuralGlyphs.support.spring',
  force: 'structuralGlyphs.load.force',
  moment: 'structuralGlyphs.load.moment',
  temperature: 'structuralGlyphs.load.temperature',
  displacement: 'structuralGlyphs.load.displacement',
};

/** An activity takes the colour of its strongest kind: a force with a moment is a force. */
function styleOf(glyphs: readonly StructuralGlyph[]): Style {
  for (const style of ['support', 'force', 'moment', 'displacement'] as const) {
    if (glyphs.some((g) => g.kind === style)) return style;
  }
  return 'temperature';
}

function worldCapOf(info: CoordinateInfo | undefined): number {
  const b = info?.shiftedBounds;
  const diagonal = b ? Math.hypot(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z) : 0;
  return Number.isFinite(diagonal) ? Math.max(WORLD_CAP_MIN, diagonal * WORLD_CAP_SHARE) : WORLD_CAP_MIN;
}

interface ModelInput {
  modelId: string;
  store: IfcDataStore;
  coordinateInfo: CoordinateInfo | undefined;
  view: Parameters<typeof effectiveStructuralData>[1];
}

function groupsOf(input: ModelInput, t: (key: TranslationKey, params?: Record<string, string>) => string): SourceGroup[] {
  const data: StructuralExtraction = effectiveStructuralData(input.store, input.view);
  if (!data.hasStructural) return [];
  const names = new Map<number, string | undefined>();
  for (const item of [...data.connections, ...data.activities]) names.set(item.expressId, item.name);
  const bySource = new Map<number, ViewGlyph[]>();
  for (const glyph of toViewGlyphs(structuralGlyphs(input.store, data).glyphs, input.coordinateInfo)) {
    const list = bySource.get(glyph.glyph.source.expressId) ?? [];
    list.push(glyph);
    bySource.set(glyph.glyph.source.expressId, list);
  }
  const worldCap = worldCapOf(input.coordinateInfo);
  return [...bySource].map(([expressId, glyphs]) => {
    const first = glyphs[0].glyph;
    const kinds = [...new Set(glyphs.map(({ glyph }) => (glyph.kind === 'support' ? glyph.support : glyph.kind)))];
    const entity = `${names.get(expressId) ?? first.source.type} (${first.source.type} #${expressId})`;
    return {
      key: `${input.modelId}:${expressId}`,
      modelId: input.modelId,
      expressId,
      style: styleOf(glyphs.map(({ glyph }) => glyph)),
      title: t('structuralGlyphs.tooltip', { kind: kinds.map((k) => t(LABEL[k])).join(', '), entity }),
      glyphs,
      worldCap,
    };
  });
}

export default function StructuralGlyphOverlay() {
  const { t } = useTranslation();
  const models = useViewerStore((s) => s.models);
  const legacyStore = useViewerStore((s) => s.ifcDataStore);
  const legacyGeometry = useViewerStore((s) => s.geometryResult);
  const mutationViews = useViewerStore((s) => s.mutationViews);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const svgLayer = useSceneLayer('svg');
  const projector = useSceneProjector();
  const anchorId = useId();
  /** Per source: the drawn path and its wider, invisible hit path, which share one `d`. */
  const paths = useRef(new Map<string, SVGGElement>());

  const groups = useMemo(() => {
    const inputs: ModelInput[] = [];
    for (const [modelId, model] of models) {
      if (!model.visible || !model.ifcDataStore) continue;
      inputs.push({ modelId, store: model.ifcDataStore, coordinateInfo: model.geometryResult?.coordinateInfo, view: mutationViews.get(modelId) });
    }
    if (models.size === 0 && legacyStore) {
      inputs.push({ modelId: 'legacy', store: legacyStore, coordinateInfo: legacyGeometry?.coordinateInfo, view: mutationViews.get('__legacy__') });
    }
    return inputs.flatMap((input) => groupsOf(input, t));
    // `mutationVersion` re-reads an edited model's structural records.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, legacyStore, legacyGeometry, mutationViews, mutationVersion, t]);

  useEffect(() => {
    if (!projector) return;
    const redraw = () => {
      const projectToScreen = useViewerStore.getState().cameraCallbacks.projectToScreen;
      if (!projectToScreen) return;
      const project: Project = (p) => projectToScreen(p);
      // Every projection reads the canvas rect, so project everything before
      // writing any path: interleaved, each write forces a layout on the next read.
      const ds = groups.map((group) => glyphPath(group.glyphs, project, group.worldCap));
      for (let i = 0; i < groups.length; i++) {
        const g = paths.current.get(groups[i].key);
        if (!g) continue;
        for (const path of g.children) path.setAttribute('d', ds[i]);
      }
    };
    // A world-point-less anchor: the projector calls it on every dirty tick (`useProjectorTick`'s pattern).
    const unregister = projector.registerAnchor(anchorId, () => null, redraw);
    // The projector wakes on pointer and wheel input only. A camera tween
    // (view cube, Home, frame selection) has none, so follow the live camera
    // feed too, or the glyphs stay where the tween started.
    const unsubscribe = useViewerStore.getState().subscribeCameraRotation(() => projector.wake());
    return () => { unregister(); unsubscribe(); };
  }, [projector, anchorId, groups]);

  if (!svgLayer || groups.length === 0) return null;

  const select = (group: SourceGroup) => {
    const state = useViewerStore.getState();
    state.setSelectedEntityIds([toGlobalIdFromModels(state.models, group.modelId, group.expressId)]);
    state.setSelectedEntity({ modelId: group.modelId, expressId: group.expressId });
    if (state.selectedEntitiesSet.size > 0) useViewerStore.setState({ selectedEntitiesSet: new Set<string>() });
  };

  return createPortal(
    <g data-structural-glyphs fill="none" strokeLinecap="round" strokeLinejoin="round">
      {groups.map((group) => (
        <g
          key={group.key}
          ref={(el) => { if (el) paths.current.set(group.key, el); else paths.current.delete(group.key); }}
          data-structural-glyph={group.style}
          data-express-id={group.expressId}
          className="cursor-pointer"
          onClick={(event) => { event.stopPropagation(); select(group); }}
        >
          <path stroke={STROKE[group.style]} strokeWidth={1.75} style={{ pointerEvents: 'none' }} />
          <path stroke="transparent" strokeWidth={10} style={{ pointerEvents: 'stroke' }}>
            <title>{group.title}</title>
          </path>
        </g>
      ))}
    </g>,
    svgLayer,
  );
}
