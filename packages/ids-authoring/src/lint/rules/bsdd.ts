/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * bSDD reference rules IDSL-BSDD-001…003 (03-diagnostics-audit-lint.md §3,
 * IDS-073). They read the URI-health index (`ctx.bsdd`), which a background
 * check fills from bSDD (rate-limited, cached 24 h). A URI not checked yet
 * yields nothing: offline authoring stays quiet rather than wrong.
 */

import type { IDSConstraint } from '@ifc-lite/ids';
import type { BsddUriRecord } from '../../bsdd/types.js';
import { quickFix, type OpBody } from '../fix.js';
import type { FacetView, Finding, SpecRule } from '../types.js';
import { allFacets, at, where } from '../walk.js';
import { gated, literals, single } from './util.js';

function uriOf(view: FacetView): string | undefined {
  const f = view.facet;
  return f.type === 'property' || f.type === 'classification' || f.type === 'material' ? f.uri : undefined;
}

function recordOf(view: FacetView, ctx: { bsdd?: { get(uri: string): BsddUriRecord | undefined } }): BsddUriRecord | undefined {
  const uri = uriOf(view);
  return uri ? ctx.bsdd?.get(uri) : undefined;
}

const lastSegment = (uri: string): string => decodeURIComponent(uri.slice(uri.lastIndexOf('/') + 1));

export const BSDD_001: SpecRule = {
  code: 'IDSL-BSDD-001',
  area: 'BSDD',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'warning',
  title: 'bSDD URI not found or inactive',
  rationale:
    'The facet points at a bSDD class or property that bSDD does not know (any more), or that its owner has deprecated. Tools that follow the URI find nothing or an outdated definition, and the classification or property the requirement asks for may no longer be maintained. URIs are checked in the background (rate-limited, cached for 24 hours); an unchecked URI is not reported.',
  fix: 'Point the facet at the replacement bSDD publishes (and, for a classification, its code).',
  example: '<classification uri="https://identifier.buildingsmart.org/uri/…/class/OLD-CODE" cardinality="required"> … </classification>',
  check(spec, { ctx, doc }) {
    const out: Finding[] = [];
    for (const view of allFacets(spec)) {
      const record = recordOf(view, ctx);
      if (!record || (record.state !== 'notFound' && record.state !== 'inactive')) continue;
      const replacement = record.replacedBy?.length === 1 ? record.replacedBy[0] : undefined;
      const message =
        record.state === 'notFound'
          ? `${where(view)}: bSDD does not know ${record.uri}`
          : `${where(view)}: ${record.uri} is inactive in bSDD${record.replacedBy?.length ? `; replaced by ${record.replacedBy.join(', ')}` : ''}`;
      let fixes;
      if (replacement) {
        const bodies: OpBody[] = [{ kind: 'facet.setUri', payload: { facetId: view.facetId, uri: replacement } }];
        const f = view.facet;
        if (f.type === 'classification' && single(f.value) === lastSegment(record.uri)) {
          bodies.push({ kind: 'value.set', payload: { facetId: view.facetId, field: 'classification.value', value: { kind: 'equals', value: lastSegment(replacement) } } });
        }
        fixes = gated(doc, ctx, [quickFix('Use the replacement', this.code, view.facetId, replacement, bodies)]);
      }
      out.push({ nodeId: view.facetId, message, ...(fixes ? { fixes } : {}) });
    }
    return out;
  },
};

export const BSDD_002: SpecRule = {
  code: 'IDSL-BSDD-002',
  area: 'BSDD',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'info',
  title: 'Classification system differs from the bSDD dictionary name',
  rationale:
    'IDS checks a classification by its system name and code. When the facet references a bSDD class, the system should be the name of the dictionary that publishes the class, as bSDD gives it; authoring tools that write classifications from bSDD use that name, so a different or missing system name may match nothing.',
  fix: 'Use the bSDD dictionary name as the system.',
  example: '<classification uri="https://identifier.buildingsmart.org/uri/…/class/EW"><value><simpleValue>EW</simpleValue></value><system><simpleValue>My system</simpleValue></system></classification>',
  check(spec, { ctx, doc }) {
    const out: Finding[] = [];
    for (const view of allFacets(spec)) {
      const f = view.facet;
      const record = recordOf(view, ctx);
      const name = record?.dictionaryName;
      if (f.type !== 'classification' || !name) continue;
      const system = f.system ? literals(f.system) : [];
      if (system.includes(name) || (f.system && f.system.type === 'pattern')) continue;
      const fix = quickFix(`Use "${name}"`, this.code, view.facetId, name, [{ kind: 'value.set', payload: { facetId: view.facetId, field: 'classification.system', value: { kind: 'equals', value: name } } }]);
      const message = system.length
        ? `${where(view)}: system "${system.join('", "')}" differs from the bSDD dictionary name "${name}"`
        : `${where(view)}: no system; the bSDD dictionary is "${name}"`;
      out.push({ ...at(view, 'classification.system'), message, fixes: gated(doc, ctx, [fix]) });
    }
    return out;
  },
};

/** Literal values of a value constraint, or undefined when it is not a literal/enumeration. */
function valueLiterals(c: IDSConstraint | undefined): string[] | undefined {
  return c && (c.type === 'simpleValue' || c.type === 'enumeration') ? literals(c) : undefined;
}

export const BSDD_003: SpecRule = {
  code: 'IDSL-BSDD-003',
  area: 'BSDD',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'warning',
  title: 'Value outside the allowed values bSDD publishes',
  rationale:
    'The property requirement references a bSDD property with a list of allowed values, but its value (or enumeration) contains values that list does not have (neither as a code nor as a label). A model filled from bSDD can then never pass, or the IDS has drifted from the dictionary. Allowing fewer values than bSDD (a project narrowing) is fine and not reported.',
  fix: 'Keep the values bSDD allows, or take its full list.',
  example: '<property uri="https://identifier.buildingsmart.org/uri/…/prop/FireRating"> … <value><simpleValue>EI 60</simpleValue></value></property>',
  check(spec, { ctx, doc }) {
    const out: Finding[] = [];
    for (const view of allFacets(spec)) {
      const f = view.facet;
      const record = recordOf(view, ctx);
      const allowed = record?.allowedValues;
      if (f.type !== 'property' || !allowed?.length) continue;
      const values = valueLiterals(f.value);
      if (!values) continue;
      // A value may be written as the bSDD code or as its label.
      const accepted = new Set([...allowed, ...(record?.allowedLabels ?? [])]);
      const outside = values.filter((v) => !accepted.has(v));
      if (!outside.length) continue;
      const kept = values.filter((v) => accepted.has(v));
      const base = f.value && 'base' in f.value && f.value.base ? f.value.base : undefined;
      const fixes = [
        kept.length
          ? quickFix('Keep the allowed values', this.code, view.facetId, 'keep', [{ kind: 'value.set', payload: { facetId: view.facetId, field: 'property.value', value: { kind: 'raw', constraint: kept.length === 1 ? { type: 'simpleValue', value: kept[0] } : { type: 'enumeration', values: kept, ...(base ? { base } : {}) } } } }])
          : undefined,
        quickFix('Use the bSDD values', this.code, view.facetId, 'all', [{ kind: 'value.set', payload: { facetId: view.facetId, field: 'property.value', value: { kind: 'raw', constraint: { type: 'enumeration', values: [...allowed], ...(base ? { base } : {}) } } } }]),
      ];
      out.push({ ...at(view, 'property.value'), message: `${where(view)}: ${outside.map((v) => `"${v}"`).join(', ')} not among the bSDD values (${allowed.join(', ')})`, fixes: gated(doc, ctx, fixes) });
    }
    return out;
  },
};
