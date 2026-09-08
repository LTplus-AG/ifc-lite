/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `MCP_VALUE_FLAGS` must describe the parser it sits next to.
 *
 * Two front doors reach `createMCPServer`: the standalone `ifc-lite-mcp`
 * binary, whose parser reads a flag and consumes its value in one branch, and
 * the `ifc-lite mcp` subcommand in `@ifc-lite/cli`, which only needs to know
 * WHICH flags carry a value so it can skip them while collecting positional
 * `.ifc` paths. The subcommand kept its own copy of that list and it drifted:
 * `--allow-origin` reached the binary and never the copy, so the subcommand
 * skipped the flag, failed to skip the origin after it, and resolved
 * `https://…` as a model file path.
 *
 * The subcommand now imports `MCP_VALUE_FLAGS`. These tests are what keeps
 * that list honest — they drive the REAL parser, so a flag added to
 * `parseArgs` without a matching entry (or an entry with no parser branch)
 * fails here rather than in someone's argv.
 */

import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  isMcpValueFlag,
  MCP_VALUE_FLAGS,
  MCP_BOOLEAN_FLAGS,
  MCP_SUBCOMMAND_UNSUPPORTED_FLAGS,
} from './cli-args.js';

describe('MCP_VALUE_FLAGS agrees with parseArgs', () => {
  it.each(MCP_VALUE_FLAGS)('%s consumes the token after it, so it is never a model path', (flag) => {
    // 'stdio' is a valid value for every flag's shape here (the numeric ones
    // coerce to NaN, which this test does not care about) and — crucially —
    // does not start with '-', so a parser that FAILED to consume it would
    // push it onto `files`.
    const opts = parseArgs([flag, 'stdio', 'model.ifc']);
    expect(opts.files).toEqual(['model.ifc']);
  });

  it.each(MCP_BOOLEAN_FLAGS)('%s stands alone and does not swallow the next token', (flag) => {
    const opts = parseArgs([flag, 'model.ifc']);
    expect(opts.files).toEqual(['model.ifc']);
  });

  it('has no flag in both tables', () => {
    const overlap = MCP_VALUE_FLAGS.filter((f) => MCP_BOOLEAN_FLAGS.includes(f));
    expect(overlap).toEqual([]);
  });

  it('every flag the subcommand cannot honour is still a flag the binary knows', () => {
    for (const flag of MCP_SUBCOMMAND_UNSUPPORTED_FLAGS) {
      expect(MCP_VALUE_FLAGS.includes(flag) || MCP_BOOLEAN_FLAGS.includes(flag)).toBe(true);
    }
  });

  it('classifies --allow-origin as value-bearing — the entry that was missing', () => {
    // The specific drift this pair was built to stop: the origin must land in
    // `allowedOrigins`, never in `files`.
    expect(isMcpValueFlag('--allow-origin')).toBe(true);
    const opts = parseArgs(['--allow-origin', 'https://app.example.test', 'model.ifc']);
    expect(opts.allowedOrigins).toEqual(['https://app.example.test']);
    expect(opts.files).toEqual(['model.ifc']);
  });

  it('leaves --help and --version to the caller instead of exiting the process', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-v']).version).toBe(true);
    expect(parseArgs(['model.ifc']).help).toBe(false);
  });
});
