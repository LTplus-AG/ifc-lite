/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The structural glyphs of every visible model, moved where that model's mesh
 * is drawn and grouped per source entity (#9668): the data half of the glyph
 * overlay adapter.
 *
 * A glyph point takes the mesh's three stages, through the same function the
 * selected-centreline overlay uses (`directrixDisplayPoint`): the source
 * frame's RTC offset, the federation alignment the mesh was baked into
 * (`modelFrameMap`), then the model's placement (Reposition). A direction is
 * the difference of two mapped points, so a rotated model turns its arrows.
 */

import type { IfcDataStore, StructuralExtraction } from '@ifc-lite/parser';
import { structuralGlyphs, type StructuralGlyph } from '@ifc-lite/parser/structural-glyphs';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { ViewerState } from '@/store';
import type { FederatedModel } from '@/store/types';
import type { GeometryResult } from '@ifc-lite/geometry';
import { LEGACY_MODEL_ID, LEGACY_MUTATION_MODEL_ID } from '@/sdk/adapters/model-compat';
import type { TranslationKey } from '@/i18n';
import { directrixDisplayPoint, type FederationPointMap } from '@/lib/analytic/directrix-frame';
import { modelFrameMap } from '@/lib/analytic/selected-centreline-lines';
import { displayedTranslation, placementFor } from '@/lib/model-placement/state';
import { effectiveStructuralData } from '../properties/effectiveStructuralData';
import { toViewGlyphs, type ViewGlyph, type Vec3 } from './structural-glyph-paths';

export type GlyphStyle = 'support' | 'force' | 'moment' | 'temperature' | 'displacement';

export interface SourceGroup {
  key: string;
  modelId: string;
  expressId: number;
  style: GlyphStyle;
  title: string;
  glyphs: ViewGlyph[];
  /** Largest symbol size in the world, metres. */
  worldCap: number;
}

type Translate = (key: TranslationKey, params?: Record<string, string>) => string;

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

/**
 * One glyph list per read model. `effectiveStructuralData` hands back the same
 * object until the store or its edits change, so a model-map update during
 * streaming does not reread the topology.
 */
const glyphCache = new WeakMap<StructuralExtraction, StructuralGlyph[]>();
function glyphsOf(store: IfcDataStore, data: StructuralExtraction): StructuralGlyph[] {
  let glyphs = glyphCache.get(data);
  if (!glyphs) {
    glyphs = structuralGlyphs(store, data);
    glyphCache.set(data, glyphs);
  }
  return glyphs;
}

/** An activity takes the colour of its strongest kind: a force with a moment is a force. */
function styleOf(glyphs: readonly ViewGlyph[]): GlyphStyle {
  for (const style of ['support', 'force', 'moment', 'displacement'] as const) {
    if (glyphs.some(({ glyph }) => glyph.kind === style)) return style;
  }
  return 'temperature';
}

function worldCapOf(info: CoordinateInfo | undefined): number {
  const b = info?.shiftedBounds;
  const diagonal = b ? Math.hypot(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z) : 0;
  return Number.isFinite(diagonal) ? Math.max(WORLD_CAP_MIN, diagonal * WORLD_CAP_SHARE) : WORLD_CAP_MIN;
}

function groupsOf(modelId: string, data: StructuralExtraction, glyphs: ViewGlyph[], worldCap: number, t: Translate): SourceGroup[] {
  const names = new Map<number, string | undefined>();
  for (const item of [...data.connections, ...data.activities]) names.set(item.expressId, item.name);
  const bySource = new Map<number, ViewGlyph[]>();
  for (const glyph of glyphs) {
    const list = bySource.get(glyph.glyph.source.expressId) ?? [];
    list.push(glyph);
    bySource.set(glyph.glyph.source.expressId, list);
  }
  return [...bySource].map(([expressId, list]) => {
    const { type } = list[0].glyph.source;
    const kinds = [...new Set(list.map(({ glyph }) => (glyph.kind === 'support' ? glyph.support : glyph.kind)))];
    return {
      key: `${modelId}:${expressId}`,
      modelId,
      expressId,
      style: styleOf(list),
      title: t('structuralGlyphs.tooltip', { kind: kinds.map((k) => t(LABEL[k])).join(', '), entity: `${names.get(expressId) ?? type} (${type} #${expressId})` }),
      glyphs: list,
      worldCap,
    };
  });
}

/** Every visible model's glyph groups. A model whose data or frame fails is skipped with a warning. */
export async function structuralGlyphGroups(state: ViewerState, t: Translate): Promise<SourceGroup[]> {
  const out: SourceGroup[] = [];
  const legacy = state.models.size === 0 && state.ifcDataStore
    ? [['legacy', { store: state.ifcDataStore, geometry: state.geometryResult, model: undefined }] as const]
    : [];
  const models = [...state.models].flatMap(([id, model]) =>
    model.visible && model.ifcDataStore ? [[id, { store: model.ifcDataStore, geometry: model.geometryResult, model }] as const] : []);
  for (const [modelId, { store, geometry, model }] of [...models, ...legacy]) {
    // One model's bad data or frame skips that model, not the others.
    try {
      out.push(...await modelGroups(state, modelId, store, geometry, model, t));
    } catch (error) {
      console.warn(`[structural-glyphs] ${modelId}: glyphs not drawn`, error);
    }
  }
  return out;
}

async function modelGroups(
  state: ViewerState, modelId: string, store: IfcDataStore, geometry: GeometryResult | null, model: FederatedModel | undefined, t: Translate,
): Promise<SourceGroup[]> {
  const view = model ? state.mutationViews.get(modelId) : state.mutationViews.get(LEGACY_MUTATION_MODEL_ID) ?? state.mutationViews.get(LEGACY_MODEL_ID);
  const data = effectiveStructuralData(store, view);
  if (!data.hasStructural || !geometry) return [];
  const map: FederationPointMap | undefined = model ? await modelFrameMap(model, state) : undefined;
  const sourceFrame = model?.preAlignment?.coordinateInfo ?? geometry.coordinateInfo;
  const placement = { ...placementFor(state.modelPlacement, modelId), translation: displayedTranslation(state.modelPlacement, modelId) };
  const toDisplay = (p: readonly [number, number, number]): Vec3 | null => {
    try {
      const [x, y, z] = directrixDisplayPoint(p, sourceFrame, placement, map);
      return { x, y, z };
    } catch (error) {
      if (error instanceof RangeError) return null;
      throw error;
    }
  };
  return groupsOf(modelId, data, toViewGlyphs(glyphsOf(store, data), toDisplay), worldCapOf(geometry.coordinateInfo), t);
}
