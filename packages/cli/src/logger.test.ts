/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger, parseVerbosity } from './logger.js';

describe('parseVerbosity', () => {
  it('maps the shorthands and strips them from argv', () => {
    expect(parseVerbosity(['--verbose', 'info', 'model.ifc'])).toEqual({
      level: 'debug',
      debug: false,
      rest: ['info', 'model.ifc'],
    });
    expect(parseVerbosity(['--quiet', 'query', 'm.ifc']).level).toBe('error');
    const dbg = parseVerbosity(['export', '--debug', 'm.ifc']);
    expect(dbg.level).toBe('debug');
    expect(dbg.debug).toBe(true);
    expect(dbg.rest).toEqual(['export', 'm.ifc']);
  });

  it('strips --log-level AND its value so positional scans stay correct', () => {
    const v = parseVerbosity(['info', '--log-level', 'warn', 'model.ifc']);
    expect(v.level).toBe('warn');
    expect(v.rest).toEqual(['info', 'model.ifc']);
    // the classic trap: the value must never look like the file path
    expect(v.rest.find((a) => !a.startsWith('-'))).toBe('info');
  });

  it('explicit --log-level wins over shorthands', () => {
    expect(parseVerbosity(['--verbose', '--log-level', 'warn']).level).toBe('warn');
    expect(parseVerbosity(['--log-level', 'debug', '--quiet']).level).toBe('debug');
  });

  it('warns and ignores an invalid --log-level value', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const v = parseVerbosity(['--log-level', 'loud', 'cmd']);
    expect(v.level).toBe('info');
    expect(v.rest).toEqual(['cmd']);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('leaves command-local flags untouched', () => {
    const v = parseVerbosity(['generate-spaces', 'm.ifc', '--json', '--out', 'x.json']);
    expect(v.rest).toEqual(['generate-spaces', 'm.ifc', '--json', '--out', 'x.json']);
  });
});

describe('logger', () => {
  afterEach(() => {
    logger.configure({ level: 'info' });
    vi.restoreAllMocks();
  });

  it('writes to stderr only, gated by level', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    logger.configure({ level: 'info' });
    logger.debug('hidden');
    expect(err).not.toHaveBeenCalled();
    logger.info('shown');
    expect(err).toHaveBeenCalledWith('shown\n');

    logger.configure({ level: 'error' });
    logger.info('quiet');
    logger.warn('quiet');
    expect(err).toHaveBeenCalledTimes(1);
    logger.error('loud');
    expect(err).toHaveBeenCalledWith('loud\n');

    expect(out).not.toHaveBeenCalled();
  });
});
