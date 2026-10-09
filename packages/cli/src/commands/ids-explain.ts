/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite ids explain <rules.ids> [--lang en|de|fr] [--md]
 *
 * Plain-language rendering of every specification, with the same sentences
 * the IDS editor shows (`describeFacet` in @ifc-lite/ids-authoring).
 */

import type { IDSDocument, IDSSpecification, SupportedLocale } from '@ifc-lite/ids';
import { describeFacet } from '@ifc-lite/ids-authoring';
import { EXIT_CLEAN, IdsUsageError, positionals, readIds, rejectUnknownFlags, runIdsSubcommand } from './ids-subcommand.js';

const EXPLAIN_FLAGS = new Set(['--md']);
const EXPLAIN_VALUE_FLAGS = new Set(['--lang']);
const LOCALES: readonly SupportedLocale[] = ['en', 'de', 'fr'];

function cardinality(spec: IDSSpecification): string {
  if (spec.maxOccurs === 0) return 'prohibited';
  return (spec.minOccurs ?? 0) > 0 ? 'required' : 'optional';
}

function render(ids: IDSDocument, locale: SupportedLocale, md: boolean): string {
  const out: string[] = [];
  out.push(md ? `# ${ids.info.title}` : `\n  ${ids.info.title}`);
  if (ids.info.description) out.push(md ? `\n${ids.info.description}` : `  ${ids.info.description}`);
  for (const spec of ids.specifications) {
    const head = `${spec.name} (${cardinality(spec)}, ${spec.ifcVersions.join(' ')})`;
    out.push(md ? `\n## ${head}\n` : `\n  ${head}`);
    if (spec.description) out.push(md ? `${spec.description}\n` : `    ${spec.description}`);
    const bullet = md ? '- ' : '    - ';
    out.push(md ? '**Applies to**\n' : '    Applies to:');
    for (const facet of spec.applicability.facets) out.push(`${bullet}${describeFacet(facet, 'applicability', 'required', locale)}`);
    if (spec.requirements.length > 0) {
      out.push(md ? '\n**Requires**\n' : '    Requires:');
      for (const r of spec.requirements) out.push(`${bullet}${describeFacet(r.facet, 'requirements', r.optionality, locale)}`);
    }
    if (spec.instructions) out.push(md ? `\n> ${spec.instructions}` : `    Instructions: ${spec.instructions}`);
  }
  return `${out.join('\n')}\n${md ? '' : '\n'}`;
}

export async function idsExplainCommand(args: string[]): Promise<void> {
  await runIdsSubcommand(async () => {
    rejectUnknownFlags(args, EXPLAIN_FLAGS, EXPLAIN_VALUE_FLAGS);
    const [file, extra] = positionals(args, EXPLAIN_VALUE_FLAGS);
    if (!file || extra) throw new IdsUsageError('usage: ifc-lite ids explain <rules.ids> [--lang en|de|fr] [--md]');
    const langIndex = args.indexOf('--lang');
    const lang = langIndex === -1 ? 'en' : args[langIndex + 1];
    if (!(LOCALES as readonly string[]).includes(lang)) throw new IdsUsageError(`--lang expects ${LOCALES.join('|')}, got "${lang}"`);
    const ids = await readIds(file);
    process.stdout.write(render(ids, lang as SupportedLocale, args.includes('--md')));
    return EXIT_CLEAN;
  });
}
