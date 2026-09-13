/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export function parseRevertOracleArgs(argv, fail) {
  const opts = {
    base: 'upstream/main', head: 'HEAD', only: [], tests: [],
    mutation: null, json: false, ci: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) fail(`${arg} needs a value`);
      return value;
    };
    if (arg === '--base') opts.base = next();
    else if (arg === '--head') opts.head = next();
    else if (arg === '--only') opts.only.push(next());
    else if (arg === '--test') opts.tests.push(next());
    else if (arg === '--mutation') opts.mutation = next();
    else if (arg === '--root') next(); // consumed before the root is frozen
    else if (arg === '--json') opts.json = true;
    else if (arg === '--ci') opts.ci = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else fail(`unknown argument: ${arg}`);
  }
  return opts;
}
