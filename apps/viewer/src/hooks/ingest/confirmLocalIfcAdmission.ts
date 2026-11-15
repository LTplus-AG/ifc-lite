/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { detectFormat } from '@ifc-lite/parser';
import { headIsZip } from './sourceBuffers';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { resolve as t } from '@/i18n/registry';
import { inspectLocalIfcAdmission } from './localIfcAdmission';

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
    if (!options.isCurrent() || ((detectFormat(head) === 'ifc' || headIsZip(head)) && !await options.admit(file.size, head))) {
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
  let server = async () => false;
  let sourceAllowsServer = true;
  const admit = createLocalIfcAdmission({ ...options, tryServer: () => sourceAllowsServer ? server() : Promise.resolve(false) });
  return {
    admit,
    setServer: (attempt: () => Promise<boolean>) => { server = attempt; },
    preflight: () => {
      // Ordinary files keep the loader's existing first-read/error lifecycle.
      // Only a potentially refused or consent-requiring source needs a read
      // before scene replacement; the header still decides whether it is IFC.
      const inspectHeader = () => preflightLocalIfcSource(file, { ...options, admit: (bytes, head) => {
        // Archive resources are not known until unwrap; do not lose textures by
        // sending an uninspected archive through the plain-IFC server route.
        sourceAllowsServer = !headIsZip(head);
        return admit(bytes);
      } });
      try { return inspectLocalIfcAdmission(file.size) ? inspectHeader() : undefined; }
      catch (error) { if (error instanceof RangeError) return inspectHeader(); throw error; }
    },
  };
}
