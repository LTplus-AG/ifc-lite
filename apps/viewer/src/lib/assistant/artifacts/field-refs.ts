/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every property and quantity a proposal names, wherever it sits (filter
 * rules, list columns, a lens's rules or auto-colour, a chart's fields), with
 * an immutable replacement. The review checks each against the loaded models
 * and, when one is not there exactly, asks the user to pick a real one.
 */

import type { FilterGroup, FilterRule } from '@ifc-lite/rules';
import type { ArtifactProposal } from './proposal-kinds';
import type { FieldIdentity } from './chart-proposal';

export type FieldKind = 'property' | 'quantity' | 'classification';

export interface FieldName { kind: FieldKind; set: string; name: string }

/**
 * Where a reference sits, for review text the card translates: a filter rule
 * (1-based group and rule, inside a lens rule when `lensRule` names one), a
 * list column by label, a lens's colour-by field, or a chart's dimension or
 * measure.
 */
export type FieldWhere =
  | { kind: 'rule'; group: number; rule: number; lensRule?: string }
  | { kind: 'column'; column: string }
  | { kind: 'colourBy' } | { kind: 'dimension' } | { kind: 'measure' };

export interface FieldSite extends FieldName {
  where: FieldWhere;
  replace: (proposal: ArtifactProposal, set: string, name: string) => ArtifactProposal;
}

export const fieldKey = (field: FieldName): string => `${field.kind}:${JSON.stringify([field.set, field.name])}`;

function groupSites(groups: readonly FilterGroup[], lensRule: string | undefined, write: (proposal: ArtifactProposal, groups: FilterGroup[]) => ArtifactProposal,
  read: (proposal: ArtifactProposal) => readonly FilterGroup[]): FieldSite[] {
  const sites: FieldSite[] = [];
  groups.forEach((group, g) => group.rules.forEach((rule, r) => {
    if (rule.kind !== 'property' && rule.kind !== 'quantity' && rule.kind !== 'classification') return;
    if (rule.kind === 'classification' && !rule.system?.trim()) return;
    const swap = (proposal: ArtifactProposal, set: string, name: string): ArtifactProposal => {
      const next = read(proposal).map((each, gi) => gi !== g ? each : { ...each, rules: each.rules.map((item, ri): FilterRule => {
        if (ri !== r) return item;
        if (item.kind === 'property') return { ...item, setName: set, propertyName: name };
        if (item.kind === 'quantity') return { ...item, setName: set, quantityName: name };
        if (item.kind === 'classification') return { ...item, system: name };
        return item;
      }) });
      return write(proposal, next);
    };
    sites.push({ kind: rule.kind, set: rule.kind === 'classification' ? '' : rule.setName,
      name: rule.kind === 'classification' ? rule.system!.trim() : rule.kind === 'property' ? rule.propertyName : rule.quantityName,
      where: { kind: 'rule', group: g + 1, rule: r + 1, ...(lensRule !== undefined ? { lensRule } : {}) }, replace: swap });
  }));
  return sites;
}

function chartFieldSite(field: FieldIdentity | undefined, where: FieldWhere, key: 'elementField' | 'measureField'): FieldSite[] {
  if (field?.kind === 'classification' && field.system?.trim()) {
    return [{ kind: 'classification', set: '', name: field.system.trim(), where, replace: (proposal, _set, name) => proposal.kind !== 'chart.proposal'
      ? proposal : { ...proposal, chart: { ...proposal.chart, [key]: { kind: 'classification', system: name } } } }];
  }
  if (!field || (field.kind !== 'property' && field.kind !== 'quantity')) return [];
  const set = field.kind === 'property' ? field.psetName : field.qsetName;
  const name = field.kind === 'property' ? field.propertyName : field.quantityName;
  return [{ kind: field.kind, set, name, where, replace: (proposal, nextSet, nextName) => {
    if (proposal.kind !== 'chart.proposal') return proposal;
    const next: FieldIdentity = field.kind === 'property'
      ? { kind: 'property', psetName: nextSet, propertyName: nextName }
      : { kind: 'quantity', qsetName: nextSet, quantityName: nextName };
    return { ...proposal, chart: { ...proposal.chart, [key]: next } };
  } }];
}

/** Every property/quantity reference in `proposal`, in reading order. */
export function fieldSites(proposal: ArtifactProposal): FieldSite[] {
  switch (proposal.kind) {
    case 'filter.proposal':
      return groupSites(proposal.groups, undefined,
        (p, groups) => p.kind === 'filter.proposal' ? { ...p, groups } : p, (p) => p.kind === 'filter.proposal' ? p.groups : []);
    case 'list.proposal': {
      const sites = groupSites(proposal.list.groups, undefined,
        (p, groups) => p.kind === 'list.proposal' ? { ...p, list: { ...p.list, groups } } : p, (p) => p.kind === 'list.proposal' ? p.list.groups : []);
      proposal.list.columns.forEach((column, index) => {
        if (column.source !== 'property' && column.source !== 'quantity') return;
        sites.push({ kind: column.source, set: column.psetName ?? '', name: column.propertyName, where: { kind: 'column', column: column.label ?? column.id },
          replace: (p, set, name) => p.kind !== 'list.proposal' ? p : { ...p, list: { ...p.list,
            columns: p.list.columns.map((each, i) => i === index ? { ...each, psetName: set, propertyName: name } : each) } } });
      });
      return sites;
    }
    case 'lens.proposal': {
      const sites = proposal.lens.rules.flatMap((rule, index) => groupSites(rule.groups, rule.name,
        (p, groups) => p.kind !== 'lens.proposal' ? p : { ...p, lens: { ...p.lens, rules: p.lens.rules.map((each, i) => i === index ? { ...each, groups } : each) } },
        (p) => p.kind === 'lens.proposal' ? p.lens.rules[index]?.groups ?? [] : []));
      const auto = proposal.lens.autoColor;
      if (auto?.source === 'classification' && auto.psetName?.trim()) {
        sites.push({ kind: 'classification', set: '', name: auto.psetName.trim(), where: { kind: 'colourBy' },
          replace: (p, _set, name) => p.kind !== 'lens.proposal' ? p : { ...p, lens: { ...p.lens, autoColor: { ...p.lens.autoColor!, psetName: name } } } });
      }
      if (auto && (auto.source === 'property' || auto.source === 'quantity')) {
        const kind = auto.source;
        sites.push({ kind, set: auto.psetName ?? '', name: auto.propertyName ?? '', where: { kind: 'colourBy' },
          replace: (p, set, name) => p.kind !== 'lens.proposal' ? p : { ...p, lens: { ...p.lens, autoColor: { source: kind, psetName: set, propertyName: name } } } });
      }
      return sites;
    }
    case 'chart.proposal':
      return [
        ...chartFieldSite(proposal.chart.elementField, { kind: 'dimension' }, 'elementField'),
        ...chartFieldSite(proposal.chart.measureField, { kind: 'measure' }, 'measureField'),
        ...groupSites(proposal.chart.filter?.groups ?? [], undefined,
          (p, groups) => p.kind === 'chart.proposal' ? { ...p, chart: { ...p.chart, filter: { groups } } } : p,
          (p) => p.kind === 'chart.proposal' ? p.chart.filter?.groups ?? [] : []),
      ];
  }
}
