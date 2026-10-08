/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Plain-language changelog for a `DocumentDiff`: one sentence per change
 * ("Doors: FireRating (Pset_DoorCommon) changed from optional to
 * required"). Every entry kind renders; the min/max occurrence pair of
 * one specification renders as one cardinality sentence.
 */

import { formatConstraint, type IDSConstraint, type IDSFacet, type SupportedLocale } from '@ifc-lite/ids';
import { getField, type FacetFieldName } from '../document/fields.js';
import { describeFacet } from '../render/describe.js';
import type { Uuid } from '../uuid.js';
import { catalogue, type ChangelogCatalogue } from './changelog-text.js';
import type { DiffEntry, DocumentDiff } from './types.js';

export interface ChangelogLine {
  text: string;
  /** Specification the line is about (`undefined` for document-level lines). */
  specName?: string;
  entry: DiffEntry;
}

export interface ChangelogOptions {
  locale?: SupportedLocale;
}

function value(v: unknown, t: ChangelogCatalogue): string {
  if (v === undefined || v === null) return t.none;
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object' && 'type' in v) return formatConstraint(v as IDSConstraint);
  return typeof v === 'string' ? `"${v}"` : String(v);
}

/** A short handle for a facet: what it is about. */
export function facetLabel(facet: IDSFacet): string {
  const f = (field: FacetFieldName) => {
    const c = getField(facet, field);
    if (!c) return '';
    return c.type === 'simpleValue' ? c.value : formatConstraint(c);
  };
  switch (facet.type) {
    case 'entity':
      return f('entity.name');
    case 'attribute':
      return f('attribute.name');
    case 'property':
      return `${f('property.baseName')} (${f('property.propertySet')})`;
    case 'classification':
      return facet.system ? `${f('classification.system')} classification` : 'classification';
    case 'material':
      return 'material';
    case 'partOf':
      return facet.entity ? `partOf ${f('partOf.entity.name')}` : 'partOf';
  }
}

const FIELD_SUFFIX: Partial<Record<FacetFieldName, string>> = {
  'entity.predefinedType': 'predefinedType',
  'attribute.value': '',
  'property.dataType': 'dataType',
  'property.value': '',
  'classification.value': '',
  'material.value': '',
  'partOf.entity.predefinedType': 'predefinedType',
};

function sentence(e: DiffEntry, t: ChangelogCatalogue, locale: SupportedLocale): string {
  switch (e.kind) {
    case 'info.changed':
      if (e.old === undefined) return t.set(t.info[e.field], value(e.new, t));
      if (e.new === undefined) return t.removedValue(t.info[e.field], value(e.old, t));
      return t.changed(t.info[e.field], value(e.old, t), value(e.new, t));
    case 'custom.psetDeclared':
      return t.psetDeclared(e.decl.name);
    case 'custom.psetRemoved':
      return t.psetRemoved(e.decl.name);
    case 'custom.userDefinedTypeDeclared':
      return t.udtDeclared(e.decl.entity, e.decl.value);
    case 'custom.userDefinedTypeRemoved':
      return t.udtRemoved(e.decl.entity, e.decl.value);
    case 'spec.added':
      return t.specAdded(e.specName);
    case 'spec.removed':
      return t.specRemoved(e.specName);
    case 'spec.moved':
      return t.specMoved(e.specName, e.from + 1, e.to + 1);
    case 'spec.changed':
      if (e.field === 'name') return t.specRenamed(String(e.old), String(e.new));
      if (e.cardinality && e.cardinality.old !== e.cardinality.new) {
        return t.specCardinality(e.specName, t.cardinality[e.cardinality.old], t.cardinality[e.cardinality.new]);
      }
      return `${e.specName}: ${t.changed(t.specField[e.field], value(e.old, t), value(e.new, t))}`;
    case 'facet.added':
      return `${e.specName}: ${t.facetAdded(cap(t.section[e.section]), describeFacet(e.facet, e.section, e.optionality, locale))}`;
    case 'facet.removed':
      return `${e.specName}: ${t.facetRemoved(cap(t.section[e.section]), describeFacet(e.facet, e.section, e.optionality, locale))}`;
    case 'facet.moved': {
      const across = e.from.specId !== e.to.specId || e.from.section !== e.to.section;
      const from = across ? t.inSpec(e.specName, t.section[e.from.section]) : t.position(e.from.index + 1);
      const to = across ? t.inSpec(e.specName, t.section[e.to.section]) : t.position(e.to.index + 1);
      return `${e.specName}: ${t.facetMoved(facetLabel(e.facet), from, to)}`;
    }
    case 'facet.replaced':
      return `${e.specName}: ${t.facetReplaced(facetLabel(e.old), describeFacet(e.facet, e.section, e.optionality, locale))}`;
    case 'facet.valueChanged': {
      const suffix = FIELD_SUFFIX[e.field];
      const what = suffix ? `${facetLabel(e.facet)} ${suffix}` : facetLabel(e.facet);
      if (!e.old) return `${e.specName}: ${t.set(what, value(e.new, t))}`;
      if (!e.new) return `${e.specName}: ${t.removedValue(what, value(e.old, t))}`;
      return `${e.specName}: ${t.changed(what, value(e.old, t), value(e.new, t))}`;
    }
    case 'facet.relationChanged':
      return `${e.specName}: ${t.changed(`${facetLabel(e.facet)} ${t.relation}`, e.old.relation, e.new.relation)}`;
    case 'requirement.changed':
      if (e.field === 'optionality') {
        return `${e.specName}: ${t.changed(facetLabel(e.facet), t.optionality[e.old as 'required'], t.optionality[e.new as 'required'])}`;
      }
      return `${e.specName}: ${t.changed(`${facetLabel(e.facet)} ${t.reqField[e.field]}`, value(e.old, t), value(e.new, t))}`;
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function specNameOf(e: DiffEntry): string | undefined {
  return 'specName' in e ? e.specName : undefined;
}

/** One plain-language line per change, in diff order. */
export function changelog(diff: DocumentDiff, options: ChangelogOptions = {}): ChangelogLine[] {
  const locale = options.locale ?? 'en';
  const t = catalogue(locale);
  const lines: ChangelogLine[] = [];
  const cardinalityDone = new Set<Uuid>();
  for (const entry of diff.entries) {
    if (entry.kind === 'spec.changed' && entry.cardinality && entry.cardinality.old !== entry.cardinality.new) {
      if (cardinalityDone.has(entry.specId)) continue;
      cardinalityDone.add(entry.specId);
    }
    const specName = specNameOf(entry);
    lines.push({ text: sentence(entry, t, locale), ...(specName !== undefined ? { specName } : {}), entry });
  }
  return lines;
}

/** The changelog as Markdown, grouped by specification (for `ids diff --md`). */
export function changelogMarkdown(diff: DocumentDiff, options: ChangelogOptions & { title?: string } = {}): string {
  const lines = changelog(diff, options);
  const out: string[] = [`# ${options.title ?? 'Changes'}`, ''];
  if (!lines.length) return `${out.join('\n')}\n`;
  const doc = lines.filter((l) => l.specName === undefined);
  for (const l of doc) out.push(`- ${l.text}`);
  if (doc.length) out.push('');
  const groups = new Map<string, string[]>();
  for (const l of lines) {
    if (l.specName === undefined) continue;
    const list = groups.get(l.specName) ?? [];
    list.push(l.text);
    groups.set(l.specName, list);
  }
  for (const [name, texts] of groups) {
    out.push(`## ${name}`, '', ...texts.map((x) => `- ${x}`), '');
  }
  return out.join('\n');
}
