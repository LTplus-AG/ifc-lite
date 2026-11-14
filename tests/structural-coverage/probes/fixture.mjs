/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Level `fixture`: a manifest-backed corpus file whose own `FILE_SCHEMA`
 * declares the row's schema carries at least one record of the row's entity.
 * A file is only ever counted under the schema it declares (an IFC4X2 file
 * counts for none). The coverage ledger applies a similar rule, but its IFC4X3
 * pattern is stricter (`catalogueSchema` accepts any `IFC4X3*` identifier).
 */

export default {
  name: 'fixture:corpus-scan',
  level: 'fixture',
  async run(rows, ctx) {
    const out = new Map();
    for (const row of rows) {
      const carriers = ctx.corpus.carriers(row.schema, row.entity);
      out.set(row.id, carriers.length
        ? { status: 'pass', evidence: carriers.map((f) => `${f.path} (${f.step.count(row.entity)})`) }
        : ctx.corpus.nothingCarries(row.schema, row.entity));
    }
    return out;
  },
};
