/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Model bindings for documents (#4594): the `{path}` placeholders in a text
 * block. A path names a value of the loaded model; it resolves when the
 * document is shown or printed, so a document opened on the next revision
 * of the file reads that revision's values.
 *
 * Grammar (exact IFC names, case-sensitive):
 *   Model["architecture.ifc"].<path>          value from one named model (#6485)
 *   Today                                    ISO date of the day
 *   Model.Name | Model.Schema | Model.Elements | Model.Count
 *   IfcProject.Name | LongName | Description | GlobalId       (also IfcSite, IfcBuilding)
 *   IfcBuildingStorey[<name>].Name | LongName | Elevation | Elements | GlobalId
 *   IfcBuildingStorey[<n>].…                 1-based, in hierarchy order
 *   Element[<GlobalId>].Name | Description | Type | ObjectType | Tag | GlobalId | Storey
 *   Element[<GlobalId>].<PropertySet>.<Property>              (quantity sets too)
 *   Count[<IfcClass>]                        elements of that class
 *
 * A binding that does not resolve is reported as such, with the reason; a
 * template never silently prints an empty string for it.
 */
import type { IfcDataStore } from '@ifc-lite/parser';
import { normalizeIfcTypeName } from '@ifc-lite/parser';
import { EntityFlags, IfcTypeEnum, IfcTypeEnumFromString, type SpatialNode } from '@ifc-lite/data';
import { iterateEffectiveEntityIds, type MutablePropertyView } from '@ifc-lite/mutations';
import { createListDataProvider } from '../lists/adapter.js';
import type { ListDataProvider } from '@ifc-lite/lists';
import { iterateEffectiveChartRows } from '../charts/datasets/effective-elements.js';
import { effectiveAttribute, effectiveProperty, effectivePropertyPaths, findEffectiveElementId } from './effective-binding-fields.js';
import { effectiveSpatialMembers } from '../effective-spatial-members.js';
import { effectiveStoreyId } from '../effective-storey.js';
import { spatialBindingNodes } from './spatial-binding-nodes.js';
import { parsePath, type Segment } from './binding-path.js';
export { parsePath } from './binding-path.js';

export interface BindingModel {
  id: string;
  name: string;
  store: IfcDataStore;
  /** Session edits for this model, if any. The caller rebuilds the context on each mutation revision. */
  view?: MutablePropertyView;
}

export interface BindingContext {
  models: readonly BindingModel[];
  /** The model unprefixed paths resolve on; the first model when null. */
  activeModelId: string | null;
  today: Date;
}

export interface ResolvedBinding {
  path: string;
  value: string;
  ok: boolean;
  /** Why the binding did not resolve — shown in place of the value. */
  reason?: string;
}

/** The `{path}` placeholders of a template, in order of appearance. */
export function templatePaths(text: string): string[] {
  const paths: string[] = [];
  for (const m of text.matchAll(/\{\{|\}\}|\{([^{}]+)\}/g)) if (m[1] !== undefined) paths.push(m[1].trim());
  return paths;
}

/** Double braces represent literal braces, leaving ordinary authored fields live. */
export function literalTemplateText(text: string): string {
  return text.replace(/[{}]/g, (brace) => brace + brace);
}

export interface ResolvedBindingSpan extends ResolvedBinding { start: number; end: number }

export interface RenderedTemplate {
  text: string;
  bindings: ResolvedBinding[];
  /** Source ranges in rendered text, retained through canonical wrapping for preview annotations. */
  spans?: ResolvedBindingSpan[];
}

/** Replace every `{path}` in `text`; an unresolved one prints as `[path: reason]`. */
export function renderTemplate(text: string, ctx: BindingContext): RenderedTemplate {
  const bindings: ResolvedBinding[] = [];
  const spans: ResolvedBindingSpan[] = [];
  let delta = 0;
  const rendered = text.replace(/\{\{|\}\}|\{([^{}]+)\}/g, (token: string, raw: string | undefined, offset: number) => {
    if (raw === undefined) { delta -= 1; return token[0]; }
    const resolved = resolveBinding(raw.trim(), ctx);
    bindings.push(resolved);
    const value = resolved.ok ? resolved.value : `[${resolved.path}: ${resolved.reason ?? 'unresolved'}]`;
    spans.push({ ...resolved, start: offset + delta, end: offset + delta + value.length });
    delta += value.length - token.length;
    return value;
  });
  return { text: rendered, bindings, spans };
}

// ── Resolution ──────────────────────────────────────────────────────────

const providers = new WeakMap<IfcDataStore, ListDataProvider>();
function providerFor(model: BindingModel): ListDataProvider {
  let provider = providers.get(model.store);
  if (!provider) {
    provider = createListDataProvider(model.store, model.name);
    providers.set(model.store, provider);
  }
  return provider;
}

/** The property paths an element answers — what an "Insert field" picker offers for it. */
export function elementPropertyPaths(globalId: string, ctx: BindingContext, limit = 60): Array<{ path: string; label: string }> {
  const out: Array<{ path: string; label: string }> = [];
  const seen = new Set<string>();
  // An own set and the type's set can carry the same property; the path resolves the own one first.
  const add = (setName: string, name: string): void => {
    const path = `Element[${globalId}].${setName}.${name}`;
    if (seen.has(path) || out.length >= limit) return;
    seen.add(path);
    out.push({ path, label: `${setName} › ${name}` });
  };
  for (const m of ctx.models) {
    const expressId = findEffectiveElementId(m, globalId);
    if (expressId <= 0) continue;
    if (m.view) {
      for (const { setName, name } of effectivePropertyPaths(m, expressId)) add(setName, name);
      return out;
    }
    const provider = providerFor(m);
    for (const set of [...provider.getPropertySets(expressId), ...(provider.getTypePropertySets?.(expressId) ?? [])]) for (const prop of set.properties) add(set.name, prop.name);
    for (const set of provider.getQuantitySets(expressId)) for (const q of set.quantities) add(set.name, q.name);
    return out;
  }
  return out;
}

/** YYYY-MM-DD in the user's own calendar day, not UTC's. */
export function localIsoDate(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const fail = (path: string, reason: string): ResolvedBinding => ({ path, value: '', ok: false, reason });
const succeed = (path: string, value: string): ResolvedBinding => ({ path, value, ok: true });

export function resolveBinding(path: string, ctx: BindingContext): ResolvedBinding {
  let segments = parsePath(path);
  if (!segments || segments.length === 0) return fail(path, 'not a path');
  if (segments[0].name === 'Model' && segments[0].selector !== undefined) {
    const name = segments[0].selector;
    const matches = ctx.models.filter((model) => model.name === name);
    if (matches.length !== 1) return fail(path, matches.length === 0 ? `model "${name}" is not loaded` : `model name "${name}" is ambiguous`);
    const model = matches[0];
    ctx = { ...ctx, models: [model], activeModelId: model.id };
    const tail = segments.slice(1);
    if (tail.length === 0) return fail(path, 'a model selector needs a field');
    // Model["file.ifc"].Name is the scoped form of Model.Name; other roots follow the selector.
    segments = tail[0].selector === undefined && ['Name', 'Schema', 'Elements', 'Count'].includes(tail[0].name) ? [{ name: 'Model' }, ...tail] : tail;
    if (segments[0].name === 'Model' && segments[0].selector !== undefined) return fail(path, 'nested model selectors are not supported');
  }
  const [head, ...rest] = segments;

  if (head.name === 'Today') return succeed(path, localIsoDate(ctx.today));

  const active = ctx.models.find((m) => m.id === ctx.activeModelId) ?? ctx.models[0];
  if (head.name === 'Model') {
    if (ctx.models.length === 0) return fail(path, 'no model loaded');
    const attr = rest[0]?.name;
    switch (attr) {
      case 'Name': return succeed(path, active.name);
      case 'Schema': return succeed(path, active.store.schemaVersion);
      case 'Count': return succeed(path, String(ctx.models.length));
      case 'Elements': return succeed(path, String(ctx.models.reduce((n, m) => {
        if (!m.view) return n + (providerFor(m).getAllEntityIds?.() ?? []).length;
        let count = n;
        for (const row of iterateEffectiveChartRows(m.store, m.view)) if (row.flags & EntityFlags.HAS_GEOMETRY) count++;
        return count;
      }, 0)));
      default: return fail(path, `unknown Model attribute "${attr ?? ''}"`);
    }
  }

  if (head.name === 'Count') {
    if (!head.selector) return fail(path, 'Count needs a class, e.g. Count[IfcWall]');
    if (ctx.models.length === 0) return fail(path, 'no model loaded');
    const typeEnum = IfcTypeEnumFromString(head.selector);
    if (typeEnum === IfcTypeEnum.Unknown) return fail(path, `unknown IFC class "${head.selector}"`);
    let n = 0;
    for (const m of ctx.models) {
      if (!m.view) {
        // @raw-entity-enumeration-ok no mutation view exists for this model; the parsed class bucket is the effective set
        n += m.store.entities.getByType(typeEnum).length;
        continue;
      }
      for (const _row of iterateEffectiveEntityIds(m.store, m.view, [head.selector])) n++;
    }
    return succeed(path, String(n));
  }

  if (head.name === 'Element') {
    if (!head.selector) return fail(path, 'Element needs a GlobalId, e.g. Element[2Ndyd$OSX7s9A04nc41yye]');
    for (const m of ctx.models) {
      const expressId = findEffectiveElementId(m, head.selector);
      if (expressId > 0) return elementAttribute(path, m, expressId, rest);
    }
    return fail(path, ctx.models.length === 0 ? 'no model loaded' : `no element with GlobalId ${head.selector} in the loaded models`);
  }

  if (head.name === 'IfcProject' || head.name === 'IfcSite' || head.name === 'IfcBuilding' || head.name === 'IfcBuildingStorey') {
    if (!active) return fail(path, 'no model loaded');
    const hierarchy = active.store.spatialHierarchy;
    if (!hierarchy) return fail(path, 'the model has no spatial structure');
    const node = spatialNode(active, head);
    if (!node) return fail(path, head.selector ? `no ${head.name} "${head.selector}"` : `no ${head.name} in the model`);
    return spatialAttribute(path, active, node, rest[0]?.name, rest.length);
  }

  return fail(path, `unknown root "${head.name}"`);
}

function spatialNode(model: BindingModel, head: Segment): SpatialNode | null {
  const matches = spatialBindingNodes(model, head.name);
  if (matches.length === 0) return null;
  if (head.selector === undefined) return matches[0];
  const index = /^\d+$/.test(head.selector) ? Number(head.selector) : NaN;
  if (Number.isInteger(index)) return matches[index - 1] ?? null;
  return matches.find((n) => {
    const name = model.view ? effectiveAttribute(model, n.expressId, 'Name') : n.name;
    const longName = model.view ? effectiveAttribute(model, n.expressId, 'LongName') : n.longName;
    return name === head.selector || longName === head.selector;
  }) ?? null;
}

function spatialAttribute(path: string, model: BindingModel, node: SpatialNode, attr: string | undefined, depth: number): ResolvedBinding {
  if (depth !== 1) return fail(path, 'expected exactly one attribute, e.g. IfcProject.Name');
  const { entities } = model.store;
  if (model.view) {
    switch (attr) {
      case 'Name': case 'LongName': case 'Description': case 'GlobalId':
        return succeed(path, effectiveAttribute(model, node.expressId, attr));
      case 'Elevation': {
        const edited = model.view.getAttributeMutationsForEntity(node.expressId).find((mutation) => mutation.name === 'Elevation')?.value;
        const source = model.store.spatialHierarchy?.storeyElevations.get(node.expressId)
          ?? node.elevation ?? effectiveAttribute(model, node.expressId, 'Elevation');
        const raw = edited ?? source;
        const elevation = raw === undefined || raw === '' ? undefined : Number(raw);
        return elevation === undefined || !Number.isFinite(elevation) ? fail(path, 'no elevation') : succeed(path, `${elevation.toFixed(2)} m`);
      }
      case 'Elements': return succeed(path, String(countElements(node, model)));
    }
  }
  switch (attr) {
    case 'Name': return succeed(path, node.name || entities.getName(node.expressId));
    case 'LongName': return succeed(path, node.longName ?? node.name);
    // Description is not in the columnar table on the fast path; the list provider reads it on demand.
    case 'Description': return succeed(path, providerFor(model).getEntityDescription(node.expressId));
    case 'GlobalId': return succeed(path, entities.getGlobalId(node.expressId));
    case 'Elevation': {
      const elevation = model.store.spatialHierarchy?.storeyElevations.get(node.expressId) ?? node.elevation;
      return elevation === undefined ? fail(path, 'no elevation') : succeed(path, `${elevation.toFixed(2)} m`);
    }
    case 'Elements': return succeed(path, String(countElements(node, model)));
    default: return fail(path, `unknown attribute "${attr ?? ''}"`);
  }
}

function countElements(node: SpatialNode, model: BindingModel): number {
  const view = model.view;
  if (view?.isDeleted(node.expressId)) return 0;
  let n = view ? effectiveSpatialMembers(model.store, view, node.expressId).length : node.elements.length;
  for (const child of node.children) n += countElements(child, model);
  return n;
}

function elementAttribute(path: string, model: BindingModel, expressId: number, rest: Segment[]): ResolvedBinding {
  const provider = providerFor(model);
  if (rest.length === 1) {
    if (model.view && ['Name', 'Description', 'ObjectType', 'Tag', 'GlobalId'].includes(rest[0].name)) {
      return succeed(path, effectiveAttribute(model, expressId, rest[0].name));
    }
    switch (rest[0].name) {
      case 'Name': return succeed(path, provider.getEntityName(expressId));
      case 'Description': return succeed(path, provider.getEntityDescription(expressId));
      case 'Type': {
        const edited = model.view?.getEntityTypeMutation(expressId)?.newType ?? model.view?.getNewEntity(expressId)?.type;
        return succeed(path, edited ? normalizeIfcTypeName(edited) : provider.getEntityTypeName(expressId));
      }
      case 'ObjectType': return succeed(path, provider.getEntityObjectType(expressId));
      case 'Tag': return succeed(path, provider.getEntityTag(expressId));
      case 'GlobalId': return succeed(path, provider.getEntityGlobalId(expressId));
      case 'Storey': {
        const storeyId = effectiveStoreyId(model.store, model.view, expressId);
        if (storeyId === undefined) return fail(path, 'not contained in a storey');
        return succeed(path, model.view ? effectiveAttribute(model, storeyId, 'Name') : model.store.entities.getName(storeyId));
      }
      default: break;
    }
  }
  if (rest.length >= 2) {
    const setName = rest[0].name;
    const propName = rest.slice(1).map((s) => s.name).join('.');
    if (model.view) {
      const value = effectiveProperty(model, expressId, setName, propName);
      return value === undefined ? fail(path, `no ${setName}.${propName} on this element`) : succeed(path, value);
    }
    for (const set of [...provider.getPropertySets(expressId), ...(provider.getTypePropertySets?.(expressId) ?? [])]) {
      if (set.name !== setName) continue;
      const prop = set.properties.find((p) => p.name === propName);
      if (prop) return succeed(path, formatValue(prop.value));
    }
    for (const set of [...provider.getQuantitySets(expressId), ...(provider.getTypeQuantitySets?.(expressId) ?? [])]) {
      if (set.name !== setName) continue;
      const q = set.quantities.find((p) => p.name === propName);
      if (q) return succeed(path, q.unit ? `${formatValue(q.value)} ${q.unit}` : formatValue(q.value));
    }
    return fail(path, `no ${setName}.${propName} on this element`);
  }
  return fail(path, `unknown attribute "${rest[0]?.name ?? ''}"`);
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '');
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return value.map(formatValue).join(', ');
  return String(value);
}
