/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseCapabilities } from '@ifc-lite/extensions';
import { createNativeBcfWriteGateway } from '@ifc-lite/flow-nodes/bcf-publication-node';
import { fatal, printJson } from '../output.js';

const USAGE = 'Usage: ifc-lite flow bcf list [--page-size N] [--after <cursor>] | check <entryId> --allow-host <host> [--token-env NAME] [--confirm-owner-stopped] [--confirm-full-read-access] | reconcile <entryId> --guid <checkedGuid> | confirm-absent <entryId>';

/** Inspect a recorded target with fresh permission; reconciliation never sends a write. */
export async function flowBcfCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  const values = new Map<string, string>();
  const positional: string[] = [];
  let confirmOwnerStopped = false;
  let confirmFullReadAccess = false;
  for (let i = 0; i < rest.length; i += 1) {
    const argument = rest[i];
    if (argument === '--json') continue;
    if (argument === '--confirm-full-read-access') {
      if (confirmFullReadAccess) fatal('Duplicate --confirm-full-read-access');
      confirmFullReadAccess = true;
      continue;
    }
    if (argument === '--confirm-owner-stopped') {
      if (confirmOwnerStopped) fatal('Duplicate --confirm-owner-stopped');
      confirmOwnerStopped = true;
      continue;
    }
    if (argument.startsWith('--')) {
      if (!['--allow-host', '--token-env', '--guid', '--after', '--page-size'].includes(argument)) fatal(`Unknown BCF option ${argument}`);
      const value = rest[++i];
      if (!value || value.startsWith('--') || values.has(argument)) fatal(`${argument} needs one value`);
      values.set(argument, value);
    } else positional.push(argument);
  }
  const gateway = createNativeBcfWriteGateway();
  if (action === 'list' && positional.length === 0 && !confirmOwnerStopped && !confirmFullReadAccess
    && [...values.keys()].every(key => ['--after', '--page-size'].includes(key))) {
    if (!values.size) printJson(await gateway.list());
    else {
      const size = values.get('--page-size');
      if (size !== undefined && !/^[1-9][0-9]{0,3}$/.test(size)) fatal('--page-size needs an integer from 1 to 1000');
      printJson(await gateway.listPage({ cursor: values.get('--after'), limit: size === undefined ? undefined : Number(size) }));
    }
    return;
  }
  const [entryId] = positional;
  if (positional.length !== 1) fatal(USAGE);
  if (action === 'check') {
    if ([...values.keys()].some(key => !['--allow-host', '--token-env'].includes(key))) fatal(USAGE);
    const host = values.get('--allow-host');
    // A capability permits a hostname, never a URL, wildcard, credentials, or arbitrary route.
    if (!host || !/^[a-zA-Z0-9.-]+$/.test(host)) fatal('--allow-host needs an explicit hostname');
    const grants = parseCapabilities([`network.fetch:${host}`]);
    if (!grants.ok) fatal(grants.errors.map(error => error.message).join('; '));
    const tokenName = values.get('--token-env');
    if (tokenName && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenName)) fatal('--token-env needs an environment variable name');
    const token = tokenName ? process.env[tokenName] : undefined;
    if (tokenName && !token?.trim()) fatal(`Environment variable ${tokenName} is empty or unset`);
    printJson(await gateway.check(entryId, { networkGrants: grants.value, token, confirmOwnerStopped, confirmFullReadAccess }));
    return;
  }
  if (action === 'confirm-absent' && values.size === 0 && !confirmOwnerStopped && !confirmFullReadAccess) {
    printJson(await gateway.confirmAbsent(entryId));
    return;
  }
  if (action === 'reconcile' && values.size === 1 && values.has('--guid') && !confirmOwnerStopped && !confirmFullReadAccess) {
    printJson(await gateway.reconcile(entryId, values.get('--guid')!));
    return;
  }
  fatal(USAGE);
}
