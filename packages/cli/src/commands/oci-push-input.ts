/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Everything `ifc-lite oci push` checks before it opens a connection: the
 * arguments, the target reference, the annotations, `SOURCE_DATE_EPOCH`, and
 * that the file is a plain IFC-SPF model. Each failure exits 1 via `fatal()`.
 */

import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { IfcInputError, parseSourceHeader, validateStepInput } from '@ifc-lite/parser';
import { OciError, type OciReference } from '@ifc-lite/oci';
import { fatal } from '../output.js';
import { parseModelReference } from '../oci-input.js';

export const TITLE_ANNOTATION = 'org.opencontainers.image.title';
export const CREATED_ANNOTATION = 'org.opencontainers.image.created';
/**
 * Provisional IFC release profile v0 keys, shared with subsoil. An experimental
 * convention, not a buildingSMART standard: https://github.com/LTplus-AG/ifc-lite/discussions/8339
 */
export const IFC_PROFILE_ANNOTATION = 'org.buildingsmart.ifc.profile';
export const IFC_SCHEMA_ANNOTATION = 'org.buildingsmart.ifc.schema';
export const IFC_RELEASE_PROFILE = 'ifc-release/0';

export const PUSH_USAGE =
  'Usage: ifc-lite oci push <oci://host/repository:tag> <model.ifc> [--overwrite] [--annotation key=value]... [--json]';

export interface PushArgs {
  reference: string;
  file: string;
  overwrite: boolean;
  json: boolean;
  /** `--annotation` values in the order given. */
  annotations: string[];
}

export function parsePushArgs(args: string[]): PushArgs {
  const positional: string[] = [];
  const annotations: string[] = [];
  let overwrite = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--overwrite') overwrite = true;
    else if (arg === '--json') json = true;
    else if (arg === '--annotation') {
      const value = args[++i];
      if (value === undefined) fatal(`--annotation needs a key=value argument. ${PUSH_USAGE}`);
      annotations.push(value);
    } else if (arg.startsWith('-')) fatal(`unknown option ${arg}. ${PUSH_USAGE}`);
    else positional.push(arg);
  }
  if (positional.length !== 2) fatal(PUSH_USAGE);
  return { reference: positional[0], file: positional[1], overwrite, json, annotations };
}

/** The push target: an `oci://` reference with a tag and no digest. */
export function pushTarget(arg: string): OciReference & { tag: string } {
  if (!arg.startsWith('oci://')) fatal(`the push target must be an oci:// reference, got "${arg}". ${PUSH_USAGE}`);
  let ref: OciReference;
  try {
    ref = parseModelReference(arg);
  } catch (error) {
    if (error instanceof OciError) fatal(`cannot push to ${arg} (${error.code}): ${error.message}`);
    throw error;
  }
  if (ref.digest !== undefined) {
    fatal(`cannot push to ${arg}: a push names a tag, not a digest (the digest is computed from the manifest). Use oci://host/repository:tag`);
  }
  if (ref.tag === undefined) fatal(`cannot push to ${arg}: the reference has no tag. Use oci://host/repository:tag`);
  return { ...ref, tag: ref.tag };
}

/**
 * Manifest annotations from `--annotation key=value`: the key is non-empty
 * and on one line, a later duplicate wins, and the title (the file name) and
 * the profile keys (they describe the file) are reserved.
 */
export function parseAnnotations(values: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of values) {
    const eq = raw.indexOf('=');
    if (eq === -1) fatal(`--annotation "${raw}" is not key=value`);
    const key = raw.slice(0, eq);
    if (key === '') fatal(`--annotation "${raw}" has an empty key`);
    if (/[\r\n]/.test(key)) fatal('--annotation keys cannot contain a line break');
    if (key === TITLE_ANNOTATION) {
      fatal(`--annotation cannot set ${TITLE_ANNOTATION}: it is the file name (the layer's title) without its extension; rename the file instead`);
    }
    if (key === IFC_PROFILE_ANNOTATION || key === IFC_SCHEMA_ANNOTATION) {
      fatal(`--annotation cannot set ${key}: it is written from the file itself`);
    }
    out[key] = raw.slice(eq + 1);
  }
  return out;
}

/**
 * `org.opencontainers.image.created`: `SOURCE_DATE_EPOCH` (integer seconds)
 * when set, so a rebuild of the same file gives the same manifest digest;
 * otherwise now. RFC 3339 in UTC, whole seconds.
 */
export function createdTimestamp(env: Readonly<Record<string, string | undefined>>, now: () => Date = () => new Date()): string {
  const raw = env.SOURCE_DATE_EPOCH;
  let date: Date;
  if (raw === undefined || raw === '') {
    date = now();
  } else {
    const seconds = Number(raw);
    if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(seconds) || seconds * 1000 > 8.64e15) {
      fatal(`SOURCE_DATE_EPOCH must be a non-negative integer number of seconds, got "${raw}"`);
    }
    date = new Date(seconds * 1000);
  }
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export interface IfcForPush {
  bytes: Uint8Array;
  /** The file's basename: the layer title. */
  fileName: string;
  /** The basename without its extension: the manifest title. */
  title: string;
  /** The `FILE_SCHEMA` entry naming the IFC schema, for example `IFC4`. */
  schema: string;
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

function isZip(bytes: Uint8Array): boolean {
  return ZIP_MAGIC.every((b, i) => bytes[i] === b);
}

/**
 * Reads the model and proves it is plain IFC-SPF with the loader's own
 * content check, plus a `FILE_SCHEMA` naming an IFC schema. IFCZIP (by
 * extension or content) is refused: publishing supports only plain IFC-SPF
 * for now.
 */
export async function readIfcForPush(path: string): Promise<IfcForPush> {
  const fileName = basename(path);
  const zipRefusal = `cannot push ${path}: only plain IFC-SPF (.ifc) models can be published for now, not IFCZIP; unzip it and push the .ifc`;
  if (/\.ifczip$/i.test(fileName)) fatal(zipRefusal);
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error));
    fatal(`cannot read ${path} (${code})`);
  }
  if (isZip(bytes)) fatal(zipRefusal);
  try {
    await validateStepInput(bytes, path);
  } catch (error) {
    if (error instanceof IfcInputError) fatal(`cannot push ${path}: ${error.message}`);
    throw error;
  }
  const schemas = parseSourceHeader(bytes)?.schemaIdentifiers ?? [];
  const schema = schemas.map((s) => s.trim()).find((s) => /^IFC/i.test(s));
  if (schema === undefined) {
    const declared = schemas.length === 0 ? 'declares no FILE_SCHEMA' : `declares FILE_SCHEMA ${schemas.join(', ')}`;
    fatal(`cannot push ${path}: it is a STEP file but ${declared}, not an IFC schema`);
  }
  const ext = extname(fileName);
  return { bytes, fileName, title: ext === '' ? fileName : fileName.slice(0, -ext.length), schema };
}
