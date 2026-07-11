/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Provenance detail for one stratum (#1717 V4, 08-review.md §8.5): the
 * full manifest — author, base, scope claims, check evidence, merge
 * record, identity map — rendered from the layer document itself.
 */

import { getProvenance, validateProvenance } from '@ifc-lite/ifcx';
import type { IfcxFile, ProvenanceManifest } from '@ifc-lite/ifcx';
import { CheckCircle2, XCircle } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { shortContentId } from '@/lib/layers/stack';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-1.5">
      <span className="w-16 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 text-[11px]">{children}</span>
    </div>
  );
}

function ChecksList({ manifest }: { manifest: ProvenanceManifest }) {
  if (manifest.checks.length === 0) return <span className="text-muted-foreground">none attached</span>;
  return (
    <span className="flex flex-col gap-0.5">
      {manifest.checks.map((check, i) => (
        <span key={`${check.spec ?? check.tool}-${i}`} className="flex items-center gap-1">
          {check.result === 'pass' ? (
            <CheckCircle2 className="size-3 shrink-0 text-emerald-500" aria-label="pass" />
          ) : (
            <XCircle className="size-3 shrink-0 text-red-500" aria-label="fail" />
          )}
          <span className="truncate">{check.spec ?? check.tool}</span>
          {check.report && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="rounded bg-muted px-1 font-mono text-[10px]">{shortContentId(check.report)}</span>
              </TooltipTrigger>
              <TooltipContent side="top" className="font-mono text-[10px]">
                evidence report {check.report}
              </TooltipContent>
            </Tooltip>
          )}
        </span>
      ))}
    </span>
  );
}

export function LayerProvenanceDetail({ file }: { file: IfcxFile }) {
  const manifest = getProvenance(file);
  if (!manifest) {
    return (
      <p className="px-1 py-1 text-[11px] text-muted-foreground">
        No provenance manifest — this layer is unsigned raw IFCX (an import or a foreign file).
      </p>
    );
  }
  // IFCX is foreign JSON: a manifest-shaped value missing mandatory
  // fields must degrade to a message, not crash the panel on deref.
  let manifestErrors: string[];
  try {
    manifestErrors = validateProvenance(manifest);
  } catch {
    manifestErrors = ['unreadable manifest'];
  }
  if (manifestErrors.length > 0) {
    return (
      <p className="px-1 py-1 text-[11px] text-muted-foreground">
        Provenance manifest present but malformed ({manifestErrors.length} issue
        {manifestErrors.length === 1 ? '' : 's'}) — treating this layer as unsigned.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1 rounded border bg-muted/20 p-1.5">
      <Field label="Author">
        {manifest.author.kind} · {manifest.author.principal}
        {manifest.author.tool ? ` · ${manifest.author.tool}` : ''}
      </Field>
      <Field label="Intent">{manifest.intent}</Field>
      <Field label="Created">{manifest.created}</Field>
      <Field label="Base">
        {manifest.base ? (
          <span className="font-mono text-[10px]">{`${manifest.base.kind}:${shortContentId(manifest.base.id)}`}</span>
        ) : (
          <span className="text-muted-foreground">none (base/import layer)</span>
        )}
      </Field>
      <Field label="Scope">
        {manifest.scope_claim.length > 0 ? (
          <span className="flex flex-wrap gap-1">
            {manifest.scope_claim.map((claim) => (
              <span key={claim} className="rounded bg-muted px-1 font-mono text-[10px]">
                {claim}
              </span>
            ))}
          </span>
        ) : (
          <span className="text-muted-foreground">unrestricted</span>
        )}
      </Field>
      <Field label="Checks">
        <ChecksList manifest={manifest} />
      </Field>
      {manifest.merge && (
        <Field label="Merge">
          <span className="flex flex-col gap-0.5">
            <span>
              <span className="font-mono text-[10px]">{shortContentId(manifest.merge.candidate)}</span>
              {' into '}
              {manifest.merge.into} by {manifest.merge.resolver}
            </span>
            <span className="text-muted-foreground">
              {manifest.merge.resolutions.length} resolution{manifest.merge.resolutions.length === 1 ? '' : 's'}
              {manifest.merge.waived_checks.length > 0
                ? `, ${manifest.merge.waived_checks.length} waived check${manifest.merge.waived_checks.length === 1 ? '' : 's'}`
                : ''}
            </span>
          </span>
        </Field>
      )}
      {manifest.identity_map.length > 0 && (
        <Field label="Identity">
          {manifest.identity_map.length} content-derived entit{manifest.identity_map.length === 1 ? 'y' : 'ies'}
        </Field>
      )}
      {manifest.signatures.length > 0 && (
        <Field label="Signed">
          {manifest.signatures.length} signature{manifest.signatures.length === 1 ? '' : 's'}
        </Field>
      )}
    </div>
  );
}
