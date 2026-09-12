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
import { IfcTypeEnum, IfcTypeEnumFromString, IfcTypeEnumToString, type SpatialNode } from '@ifc-lite/data';
import { createListDataProvider } from '../lists/adapter.js';
import type { ListDataProvider } from '@ifc-lite/lists';

export interface BindingModel {
  id: string;
  name: string;
  store: IfcDataStore;
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
  for (const m of text.matchAll(/\{([^{}]+)\}/g)) paths.push(m[1].trim());
  return paths;
}

export interface RenderedTemplate {
  text: string;
  bindings: ResolvedBinding[];
}

/** Replace every `{path}` in `text`; an unresolved one prints as `[path: reason]`. */
export function renderTemplate(text: string, ctx: BindingContext): RenderedTemplate {
  const bindings: ResolvedBinding[] = [];
  const rendered = text.replace(/\{([^{}]+)\}/g, (_, raw: string) => {
    const resolved = resolveBinding(raw.trim(), ctx);
    bindings.push(resolved);
    return resolved.ok ? resolved.value : `[${resolved.path}: ${resolved.reason ?? 'unresolved'}]`;
  });
  return { text: rendered, bindings };
}

// ── Path parsing ────────────────────────────────────────────────────────

interface Segment {
  name: string;
  /** `[…]` selector, unquoted. */
  selector?: string;
}

/** `IfcBuildingStorey["Level 1"].Name` → [{name:'IfcBuildingStorey', selector:'Level 1'}, {name:'Name'}]. */
export function parsePath(path: string): Segment[] | null {
  const segments: Segment[] = [];
  let i = 0;
  while (i < path.length) {
    const nameEnd = indexOfAny(path, ['.', '['], i);
    const name = path.slice(i, nameEnd === -1 ? path.length : nameEnd);
    if (name.length === 0) return null;
    const segment: Segment = { name };
    i = nameEnd === -1 ? path.length : nameEnd;
    if (path[i] === '[') {
      const close = path.indexOf(']', i);
      if (close === -1) return null;
      let selector = path.slice(i + 1, close).trim();
      if ((selector.startsWith('"') && selector.endsWith('"')) || (selector.startsWith("'") && selector.endsWith("'"))) selector = selector.slice(1, -1);
      segment.selector = selector;
      i = close + 1;
    }
    segments.push(segment);
    if (path[i] === '.') i += 1;
    else if (i < path.length) return null;
  }
  return segments;
}

function indexOfAny(text: string, chars: string[], from: number): number {
  let best = -1;
  for (const c of chars) {
    const at = text.indexOf(c, from);
    if (at !== -1 && (best === -1 || at < best)) best = at;
  }
  return best;
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
    const expressId = m.store.entities.getExpressIdByGlobalId(globalId);
    if (expressId <= 0) continue;
    const provider = providerFor(m);
    for (const set of [...provider.getPropertySets(expressId), ...(provider.getTypePropertySets?.(expressId) ?? [])]) for (const prop of set.properties) add(set.name, prop.name);
    for (const set of provider.getQuantitySets(expressId)) for (const q of set.quantities) add(set.name, q.name);
    return out;
  }
  return out;
}

const fail = (path: string, reason: string): ResolvedBinding => ({ path, value: '', ok: false, reason });
const succeed = (path: string, value: string): ResolvedBinding => ({ path, value, ok: true });

export function resolveBinding(path: string, ctx: BindingContext): ResolvedBinding {
  const segments = parsePath(path);
  if (!segments || segments.length === 0) return fail(path, 'not a path');
  const [head, ...rest] = segments;

  if (head.name === 'Today') return succeed(path, ctx.today.toISOString().slice(0, 10));

  const active = ctx.models.find((m) => m.id === ctx.activeModelId) ?? ctx.models[0];
  if (head.name === 'Model') {
    if (ctx.models.length === 0) return fail(path, 'no model loaded');
    const attr = rest[0]?.name;
    switch (attr) {
      case 'Name': return succeed(path, active.name);
      case 'Schema': return succeed(path, active.store.schemaVersion);
      case 'Count': return succeed(path, String(ctx.models.length));
      case 'Elements': return succeed(path, String(ctx.models.reduce((n, m) => n + (providerFor(m).getAllEntityIds?.() ?? []).length, 0)));
      default: return fail(path, `unknown Model attribute "${attr ?? ''}"`);
    }
  }

  if (head.name === 'Count') {
    if (!head.selector) return fail(path, 'Count needs a class, e.g. Count[IfcWall]');
    if (ctx.models.length === 0) return fail(path, 'no model loaded');
    const typeEnum = IfcTypeEnumFromString(head.selector);
    if (typeEnum === IfcTypeEnum.Unknown) return fail(path, `unknown IFC class "${head.selector}"`);
    let n = 0;
    for (const m of ctx.models) n += m.store.entities.getByType(typeEnum).length;
    return succeed(path, String(n));
  }

  if (head.name === 'Element') {
    if (!head.selector) return fail(path, 'Element needs a GlobalId, e.g. Element[2Ndyd$OSX7s9A04nc41yye]');
    for (const m of ctx.models) {
      const expressId = m.store.entities.getExpressIdByGlobalId(head.selector);
      if (expressId > 0) return elementAttribute(path, m, expressId, rest);
    }
    return fail(path, ctx.models.length === 0 ? 'no model loaded' : `no element with GlobalId ${head.selector} in the loaded models`);
  }

  if (head.name === 'IfcProject' || head.name === 'IfcSite' || head.name === 'IfcBuilding' || head.name === 'IfcBuildingStorey') {
    if (!active) return fail(path, 'no model loaded');
    const hierarchy = active.store.spatialHierarchy;
    if (!hierarchy) return fail(path, 'the model has no spatial structure');
    const node = spatialNode(hierarchy.project, head);
    if (!node) return fail(path, head.selector ? `no ${head.name} "${head.selector}"` : `no ${head.name} in the model`);
    return spatialAttribute(path, active, node, rest[0]?.name, rest.length);
  }

  return fail(path, `unknown root "${head.name}"`);
}

function spatialNode(project: SpatialNode, head: Segment): SpatialNode | null {
  if (head.name === 'IfcProject') return project;
  const matches: SpatialNode[] = [];
  const walk = (node: SpatialNode): void => {
    if (IfcTypeEnumToString(node.type) === head.name) matches.push(node);
    for (const child of node.children) walk(child);
  };
  walk(project);
  if (matches.length === 0) return null;
  if (head.selector === undefined) return matches[0];
  const index = /^\d+$/.test(head.selector) ? Number(head.selector) : NaN;
  if (Number.isInteger(index)) return matches[index - 1] ?? null;
  return matches.find((n) => n.name === head.selector || n.longName === head.selector) ?? null;
}

function spatialAttribute(path: string, model: BindingModel, node: SpatialNode, attr: string | undefined, depth: number): ResolvedBinding {
  if (depth !== 1) return fail(path, 'expected exactly one attribute, e.g. IfcProject.Name');
  const { entities } = model.store;
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
    case 'Elements': return succeed(path, String(countElements(node)));
    default: return fail(path, `unknown attribute "${attr ?? ''}"`);
  }
}

function countElements(node: SpatialNode): number {
  let n = node.elements.length;
  for (const child of node.children) n += countElements(child);
  return n;
}

function elementAttribute(path: string, model: BindingModel, expressId: number, rest: Segment[]): ResolvedBinding {
  const provider = providerFor(model);
  if (rest.length === 1) {
    switch (rest[0].name) {
      case 'Name': return succeed(path, provider.getEntityName(expressId));
      case 'Description': return succeed(path, provider.getEntityDescription(expressId));
      case 'Type': return succeed(path, provider.getEntityTypeName(expressId));
      case 'ObjectType': return succeed(path, provider.getEntityObjectType(expressId));
      case 'Tag': return succeed(path, provider.getEntityTag(expressId));
      case 'GlobalId': return succeed(path, provider.getEntityGlobalId(expressId));
      case 'Storey': {
        const storeyId = model.store.spatialHierarchy?.elementToStorey.get(expressId);
        return storeyId === undefined ? fail(path, 'not contained in a storey') : succeed(path, model.store.entities.getName(storeyId));
      }
      default: break;
    }
  }
  if (rest.length >= 2) {
    const setName = rest[0].name;
    const propName = rest.slice(1).map((s) => s.name).join('.');
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
