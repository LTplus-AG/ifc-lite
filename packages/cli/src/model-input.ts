/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one place a command turns its model argument into bytes: a local path,
 * or an `oci://` reference pulled from a registry (see `oci-input.ts`).
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fatal } from './output.js';
import { ModelInputError, openOciModel } from './oci-input.js';

export { ModelInputError } from './oci-input.js';

export interface ModelInput {
  bytes: Uint8Array;
  /** The argument as given (a path or an `oci://` reference), for messages and JSON output. */
  label: string;
  /** A file-like name for the model: the path's basename, or the layer's title. */
  name: string;
}

export function isOciReference(arg: string): boolean {
  return arg.startsWith('oci://');
}

/**
 * Reads a model without exiting the process. A local read failure throws the
 * `readFile` error unchanged; an `oci://` failure throws
 * {@link ModelInputError} with a message ready for the user.
 */
export async function openModelInput(arg: string): Promise<ModelInput> {
  if (isOciReference(arg)) {
    const { bytes, name } = await openOciModel(arg);
    return { bytes, label: arg, name };
  }
  return { bytes: await readFile(arg), label: arg, name: basename(arg) };
}

/**
 * {@link openModelInput} for a command: an `oci://` failure is reported with
 * `fatal()` (exit 1). A local read failure still throws, as `readFile` did.
 */
export async function readModelInput(arg: string): Promise<ModelInput> {
  try {
    return await openModelInput(arg);
  } catch (error) {
    if (error instanceof ModelInputError) return fatal(error.message);
    throw error;
  }
}
