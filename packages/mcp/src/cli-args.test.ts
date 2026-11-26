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
 * Both front doors now share `parseArgs` (#11534). These tests keep the
 * published flag tables honest: they drive the REAL parser, so a flag added
 * to `parseArgs` without a matching entry (or an entry with no parser
 * branch) fails here rather than in someone's argv.
 */

import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  MCP_VALUE_FLAGS,
  MCP_BOOLEAN_FLAGS,
  bridgeConflict,
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

  it('classifies --allow-origin as value-bearing — the entry that was missing', () => {
    // The specific drift this pair was built to stop: the origin must land in
    // `allowedOrigins`, never in `files`.
    expect(MCP_VALUE_FLAGS).toContain('--allow-origin');
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

describe('--bridge (#9523)', () => {
  it('parses the bridge flags', () => {
    const opts = parseArgs(['--bridge', '--bridge-port', '0', '--bridge-viewer-url', 'http://localhost:5173', '--allow-origin', 'https://x.test']);
    expect(opts).toMatchObject({ bridge: true, bridgePort: 0, bridgeViewerUrl: 'http://localhost:5173', allowedOrigins: ['https://x.test'] });
    expect(bridgeConflict(opts)).toBeNull();
  });

  it('takes --channel only together with --bridge', () => {
    expect(parseArgs(['--bridge', '--channel'])).toMatchObject({ bridge: true, channel: true, files: [] });
    expect(bridgeConflict(parseArgs(['--bridge', '--channel']))).toBeNull();
    expect(bridgeConflict(parseArgs(['--channel', 'model.ifc']))).toBe('--channel needs --bridge: it pushes events from the paired viewer tab.');
  });

  it('treats a bridge value flag without an operand as a usage error, not the default', () => {
    expect(parseArgs(['--bridge', '--bridge-viewer-url']).errors).toEqual(['--bridge-viewer-url needs a value.']);
    expect(parseArgs(['--bridge', '--bridge-port']).errors).toEqual(['--bridge-port needs a value.']);
    // The following flag is not swallowed as the operand.
    const opts = parseArgs(['--bridge', '--bridge-viewer-url', '--read-only']);
    expect(opts.readOnly).toBe(true);
    expect(opts.bridgeViewerUrl).toBeUndefined();
    expect(opts.errors).toEqual(['--bridge-viewer-url needs a value.']);
    // A short flag or an empty string is not an operand either.
    expect(parseArgs(['--bridge', '--bridge-port', '-h']).help).toBe(true);
    expect(parseArgs(['--bridge', '--bridge-port', '-h']).errors).toEqual(['--bridge-port needs a value.']);
    expect(parseArgs(['--bridge', '--bridge-port', '']).errors).toEqual(['--bridge-port needs a value.']);
  });

  it('refuses file arguments, --transport http, --viewer and a bad port', () => {
    expect(bridgeConflict(parseArgs(['--bridge', 'model.ifc']))).toMatch(/loads no files/);
    expect(bridgeConflict(parseArgs(['--bridge', '--transport', 'http']))).toMatch(/stdio only/);
    expect(bridgeConflict(parseArgs(['--bridge', '--viewer']))).toMatch(/--viewer/);
    expect(parseArgs(['--bridge', '--bridge-port', 'abc']).errors).toEqual(['--bridge-port must be an integer from 0 to 65535.']);
    expect(bridgeConflict(parseArgs(['--transport', 'http']))).toBeNull();
  });
});

describe('flag fixes (#11534)', () => {
  it('keeps every --token and --read-only-token, not only the last', () => {
    const opts = parseArgs(['--token', 'a', '--token', 'b', '--read-only-token', 'r1', '--read-only-token', 'r2']);
    expect(opts.tokens).toEqual(['a', 'b']);
    expect(opts.readOnlyTokens).toEqual(['r1', 'r2']);
    expect(opts.warnings).toEqual([]);
  });

  it('makes a value flag with no value a usage error, not a silent default', () => {
    const opts = parseArgs(['--token']);
    expect(opts.tokens).toEqual([]);
    expect(opts.errors).toEqual(['--token needs a value.']);
  });

  it('does not take a known flag as a value, so --read-only is not lost', () => {
    for (const flag of ['--token', '--read-only-token', '--allow', '--allow-origin', '--host', '--bsdd', '--transport']) {
      const opts = parseArgs([flag, '--read-only', 'model.ifc']);
      expect(opts.readOnly, flag).toBe(true);
      expect(opts.files, flag).toEqual(['model.ifc']);
      expect(opts.errors, flag).toEqual([`${flag} needs a value.`]);
    }
  });

  it('refuses a port that is not an integer from 0 to 65535', () => {
    expect(parseArgs(['--port', 'abc']).errors).toEqual(['--port must be an integer from 0 to 65535.']);
    expect(parseArgs(['--viewer-port', '70000']).errors).toHaveLength(1);
    expect(parseArgs(['--port', '0', '--viewer-port', '8080']).errors).toEqual([]);
  });

  it('reads --flag=value for value flags and never echoes an unknown one\'s value', () => {
    const opts = parseArgs(['--token=abc', '--port=9000', '--tokn=s3cr3t']);
    expect(opts.tokens).toEqual(['abc']);
    expect(opts.port).toBe(9000);
    expect(opts.warnings).toEqual(['unknown flag --tokn=… ignored. Run with --help for the flags this version knows.']);
  });

  it('never takes an unknown --x=… as a value, so its value is not echoed or bound', () => {
    const opts = parseArgs(['--host', '--tokn=s3cr3t']);
    expect(opts.host).toBeUndefined();
    expect(opts.errors).toEqual(['--host needs a value.']);
    expect(JSON.stringify(opts)).not.toContain('s3cr3t');
  });

  it('refuses a value on a boolean flag instead of ignoring the flag', () => {
    const opts = parseArgs(['model.ifc', '--read-only=true']);
    expect(opts.errors).toEqual(['--read-only takes no value.']);
  });

  it('takes only stdio or http as the transport', () => {
    expect(parseArgs(['--transport', 'htp']).errors).toEqual(['--transport must be stdio or http.']);
    expect(parseArgs(['--transport', 'http']).transport).toBe('http');
  });

  it('takes only plain decimal ports', () => {
    for (const bad of [' ', '0x1F90', '1e3', '-1']) {
      expect(parseArgs(['--port', bad]).errors, bad).toHaveLength(1);
    }
  });

  it('accepts a token that starts with a dash', () => {
    const opts = parseArgs(['--token', '-s3cr3t']);
    expect(opts.tokens).toEqual(['-s3cr3t']);
    expect(opts.errors).toEqual([]);
    expect(opts.warnings).toEqual([]);
  });

  it('warns about unknown flags and still parses the rest', () => {
    const opts = parseArgs(['--no-such-flag', '--nope=/x', 'model.ifc', '--read-only']);
    expect(opts.files).toEqual(['model.ifc']);
    expect(opts.readOnly).toBe(true);
    expect(opts.warnings).toEqual([
      'unknown flag --no-such-flag ignored. Run with --help for the flags this version knows.',
      'unknown flag --nope=… ignored. Run with --help for the flags this version knows.',
    ]);
  });

  it('accepts --federate from older configs but says it does nothing', () => {
    const opts = parseArgs(['a.ifc', 'b.ifc', '--federate']);
    expect(opts.files).toEqual(['a.ifc', 'b.ifc']);
    expect(opts.warnings).toEqual(['--federate does nothing: every file passed is loaded into the same session. Drop it.']);
  });

  it('warns about nothing for a known command line', () => {
    expect(parseArgs(['--bridge', '--channel', '--bridge-port', '0']).warnings).toEqual([]);
  });
});
