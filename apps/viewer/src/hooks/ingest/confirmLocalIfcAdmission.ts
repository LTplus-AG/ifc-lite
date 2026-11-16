/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { detectFormat } from '@ifc-lite/parser';
import { headIsZip } from './sourceBuffers';
import { inspectIfcArchiveAdmission } from './archiveServerAdmission';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { resolve as t } from '@/i18n/registry';
import { inspectLocalIfcAdmission } from './localIfcAdmission';
import { nonModelContentMessage, nonModelContentReason } from './nonModelContent';

/** Consent belongs to one load, never to a later file/pairing/session. An
 * unwrapped source larger than the approved input needs a fresh decision. */
export function createLocalIfcAdmission(options: {
  tryServer: () => Promise<boolean>; isCurrent: () => boolean;
  onCancel: () => void; signal: AbortSignal;
}): (bytes: number) => Promise<boolean> {
  let approvedBytes = -1;
  return async bytes => {
    if (!options.isCurrent()) return false;
    let warning;
    try { warning = inspectLocalIfcAdmission(bytes); }
    catch (refusal) {
      if (await options.tryServer()) return false;
      if (!options.isCurrent()) return false;
      throw refusal;
    }
    if (!warning || bytes <= approvedBytes) return true;
    if (await options.tryServer() || !options.isCurrent()) return false;
    const agreed = await confirmDialog({
      title: t('viewerShell.localIfcMemory.title'), confirmLabel: t('viewerShell.localIfcMemory.continue'),
      description: t('viewerShell.localIfcMemory.description', { estimated: warning.estimatedGiB.toFixed(1) }),
      signal: options.signal,
    });
    if (!options.isCurrent()) return false;
    if (!agreed) { options.onCancel(); return false; }
    approvedBytes = bytes;
    return true;
  };
}

/** Inspect only the header before a primary scene reset or a cold-tier change. */
export async function preflightLocalIfcSource(file: File, options: {
  admit: (bytes: number, head: ArrayBuffer) => Promise<boolean>; isCurrent: () => boolean;
  onFailure: (error: unknown) => void; finish: () => void;
}): Promise<ArrayBuffer | null> {
  try {
    const head = await file.slice(0, 4096).arrayBuffer();
    const format = detectFormat(head);
    const unknownIfc = format === 'unknown' && (/\.(ifc|ifczip|ifcxml)$/i.test(file.name) || new TextDecoder().decode(head).trimStart().startsWith('ISO-10303-21'));
    // An error response saved or served as a model is refused here, before the primary reset (#9523).
    const nonModel = await nonModelContentReason(file);
    if (nonModel) throw new Error(nonModelContentMessage(nonModel));
    if (!options.isCurrent() || ((format === 'ifc' || unknownIfc || headIsZip(head)) && !await options.admit(file.size, head))) {
      options.finish(); return null;
    }
    return head;
  } catch (error) {
    if (options.isCurrent()) options.onFailure(error);
    options.finish(); return null;
  }
}

/** Keep the loader's pre-reset and server-fallback phases on one decision owner. */
export function createLocalIfcLoadAdmission(file: File, options: {
  isCurrent: () => boolean; signal: AbortSignal;
  onCancel: () => void; onFailure: (error: unknown) => void; finish: () => void;
}) {
  let server: (bytes: number) => Promise<boolean> = async () => false;
  let sourceAllowsServer = true;
  let archiveModelBytes: number | undefined;
  const admit = createLocalIfcAdmission({ ...options, tryServer: () => sourceAllowsServer ? server(Math.max(file.size, archiveModelBytes ?? 0)) : Promise.resolve(false) });
  return {
    admit,
    allowsServer: () => sourceAllowsServer,
    setServer: (attempt: (bytes: number) => Promise<boolean>) => { server = attempt; },
    archiveModelLimit: () => archiveModelBytes,
    preflight: () => preflightLocalIfcSource(file, { ...options, admit: async (bytes, head) => {
      if (headIsZip(head)) {
        // Small legacy ZIP layouts stay local with a hard extraction cap, never a guessed server route.
        const archive = await inspectIfcArchiveAdmission(file) ?? (file.size <= 1024 * 1024
          ? { modelBytes: 64 * 1024 * 1024, allowsServer: false } : null);
        if (!archive) throw new RangeError('Cannot safely inspect this IFC ZIP model size within the archive metadata limit. Extract the IFC before opening it, or use the native CLI/server.');
        sourceAllowsServer = archive.allowsServer;
        archiveModelBytes = archive.modelBytes;
        bytes = Math.max(bytes, archiveModelBytes);
      }
      return admit(bytes);
    } }),
  };
}
