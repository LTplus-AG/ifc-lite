/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The structural glyph overlay (#9668), loaded lazily by `StructuralGlyphLayer`
 * once a loaded model carries structural connections or actions.
 *
 * The adapter between the parser's plain-data glyph list
 * (`structuralGlyphs`, IFC world metres) and the scene-overlay kernel:
 * `structuralGlyphGroups` moves each model's list to where its mesh is drawn,
 * and this component draws one SVG path per source entity in the kernel's SVG
 * layer. React renders the paths once per glyph list; every dirty projector
 * tick rewrites their `d` in place (`glyphPath`), so orbiting costs a
 * projection pass and no React render.
 *
 * Every load group is shown at once: the viewer has no load group or load
 * case selection. Arrow lengths are relative within each load group.
 *
 * Clicking a glyph selects its connection or activity as a viewport click
 * selects an element (`selectPickedGlobalId`).
 */

import { createPortal } from 'react-dom';
import { useEffect, useId, useRef, useState } from 'react';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { useTranslation } from '@/i18n';
import { useSceneLayer, useSceneProjector } from '@/components/viewport-ui/scene';
import { selectPickedGlobalId } from '../viewport-selection';
import { glyphPath, type Project } from './structural-glyph-paths';
import { structuralGlyphGroups, type GlyphStyle, type SourceGroup } from './structural-glyph-groups';

/** Stroke per style; distinct hues that read on the light and the dark viewport background. */
const STROKE: Record<GlyphStyle, string> = {
  support: '#14b8a6',
  force: '#ef4444',
  moment: '#a855f7',
  temperature: '#f59e0b',
  displacement: '#3b82f6',
};

export default function StructuralGlyphOverlay() {
  const { t } = useTranslation();
  const models = useViewerStore((s) => s.models);
  const legacyStore = useViewerStore((s) => s.ifcDataStore);
  const legacyGeometry = useViewerStore((s) => s.geometryResult);
  const mutationViews = useViewerStore((s) => s.mutationViews);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const modelPlacement = useViewerStore((s) => s.modelPlacement);
  const georefMutations = useViewerStore((s) => s.georefMutations);
  const svgLayer = useSceneLayer('svg');
  const projector = useSceneProjector();
  const anchorId = useId();
  /** Per source: the drawn path and its wider, invisible hit path, which share one `d`. */
  const paths = useRef(new Map<string, SVGGElement>());
  const [groups, setGroups] = useState<SourceGroup[]>([]);

  // The inputs are read off the store inside; they are listed so a change
  // re-runs it. The federation frame map is asynchronous.
  useEffect(() => {
    let cancelled = false;
    structuralGlyphGroups(useViewerStore.getState(), t).then((next) => { if (!cancelled) setGroups(next); }, (error) => {
      console.warn('[structural-glyphs] could not place the glyphs', error);
    });
    return () => { cancelled = true; };
  }, [models, legacyStore, legacyGeometry, mutationViews, mutationVersion, modelPlacement, georefMutations, t]);

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

  const select = (group: SourceGroup) =>
    selectPickedGlobalId(toGlobalIdFromModels(useViewerStore.getState().models, group.modelId, group.expressId));

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
