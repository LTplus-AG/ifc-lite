/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Provenance detail for one stratum (#1717 V4, 08-review.md §8.5): the
 * full manifest — author, base, scope claims, check evidence, merge
 * record, identity map — rendered from the layer document itself.
 */

import { useState } from 'react';
import { getProvenance, validateProvenance } from '@ifc-lite/ifcx';
import type { IfcxFile, ProvenanceManifest } from '@ifc-lite/ifcx';
import { CheckCircle2, ChevronDown, ChevronRight, XCircle } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTranslation } from '@/i18n';
import { shortContentId } from '@/lib/layers/stack';
import { LayerCheckEvidence } from './LayerCheckEvidence';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-1.5">
      <span className="w-16 shrink-0 text-2xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 text-2xs">{children}</span>
    </div>
  );
}

function ChecksList({ manifest }: { manifest: ProvenanceManifest }) {
  const { t } = useTranslation();
  const [openReport, setOpenReport] = useState<string | null>(null);
  if (manifest.checks.length === 0) {
    return <span className="text-muted-foreground">{t('layersPanel.provenance.checksNoneAttached')}</span>;
  }
  return (
    <span className="flex flex-col gap-0.5">
      {manifest.checks.map((check, i) => (
        <span key={`${check.spec ?? check.tool}-${i}`} className="flex flex-col">
          <span className="flex items-center gap-1">
            {check.result === 'pass' ? (
              <CheckCircle2
                className="size-3 shrink-0 text-emerald-500"
                aria-label={t('layersPanel.provenance.checkPassAriaLabel')}
              />
            ) : (
              <XCircle
                className="size-3 shrink-0 text-red-500"
                aria-label={t('layersPanel.provenance.checkFailAriaLabel')}
              />
            )}
            <span className="truncate">{check.spec ?? check.tool}</span>
            {check.report && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setOpenReport((prev) => (prev === check.report ? null : check.report ?? null))}
                    className="inline-flex items-center gap-0.5 rounded bg-muted px-1 font-mono text-2xs hover:bg-muted/60"
                    aria-expanded={openReport === check.report}
                  >
                    {openReport === check.report ? (
                      <ChevronDown className="size-2.5" aria-hidden />
                    ) : (
                      <ChevronRight className="size-2.5" aria-hidden />
                    )}
                    {shortContentId(check.report)}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="font-mono text-2xs">
                  {t('layersPanel.provenance.checkReportTooltip', { report: check.report })}
                </TooltipContent>
              </Tooltip>
            )}
          </span>
          {check.report && openReport === check.report && <LayerCheckEvidence digest={check.report} />}
        </span>
      ))}
    </span>
  );
}

export function LayerProvenanceDetail({ file }: { file: IfcxFile }) {
  const { t } = useTranslation();
  const manifest = getProvenance(file);
  if (!manifest) {
    return (
      <p className="px-1 py-1 text-2xs text-muted-foreground">
        {t('layersPanel.provenance.noManifest')}
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
      <p className="px-1 py-1 text-2xs text-muted-foreground">
        {t('layersPanel.provenance.malformedManifest', {
          count: manifestErrors.length,
          countDisplay: String(manifestErrors.length),
        })}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1 rounded border bg-muted/20 p-1.5">
      <Field label={t('layersPanel.provenance.authorField')}>
        {t('layersPanel.provenance.authorLine', { kind: manifest.author.kind, principal: manifest.author.principal })}
        {manifest.author.tool ? t('layersPanel.provenance.authorToolSuffix', { tool: manifest.author.tool }) : ''}
      </Field>
      <Field label={t('layersPanel.provenance.intentField')}>{manifest.intent}</Field>
      <Field label={t('layersPanel.provenance.createdField')}>{manifest.created}</Field>
      <Field label={t('layersPanel.provenance.baseField')}>
        {manifest.base ? (
          <span className="font-mono text-2xs">{`${manifest.base.kind}:${shortContentId(manifest.base.id)}`}</span>
        ) : (
          <span className="text-muted-foreground">{t('layersPanel.provenance.baseNone')}</span>
        )}
      </Field>
      <Field label={t('layersPanel.provenance.scopeField')}>
        {manifest.scope_claim.length > 0 ? (
          <span className="flex flex-wrap gap-1">
            {manifest.scope_claim.map((claim) => (
              <span key={claim} className="rounded bg-muted px-1 font-mono text-2xs">
                {claim}
              </span>
            ))}
          </span>
        ) : (
          <span className="text-muted-foreground">{t('layersPanel.provenance.scopeUnrestricted')}</span>
        )}
      </Field>
      <Field label={t('layersPanel.provenance.checksField')}>
        <ChecksList manifest={manifest} />
      </Field>
      {manifest.merge && (
        <Field label={t('layersPanel.provenance.mergeField')}>
          <span className="flex flex-col gap-0.5">
            <span>
              <span className="font-mono text-2xs">{shortContentId(manifest.merge.candidate)}</span>
              {t('layersPanel.provenance.mergeIntoBy', {
                into: manifest.merge.into,
                resolver: manifest.merge.resolver,
              })}
            </span>
            <span className="text-muted-foreground">
              {t('layersPanel.provenance.resolutionsCount', {
                count: manifest.merge.resolutions.length,
                countDisplay: String(manifest.merge.resolutions.length),
              })}
              {manifest.merge.waived_checks.length > 0
                ? t('layersPanel.provenance.waivedCountSuffix', {
                    count: manifest.merge.waived_checks.length,
                    countDisplay: String(manifest.merge.waived_checks.length),
                  })
                : ''}
            </span>
          </span>
        </Field>
      )}
      {manifest.identity_map.length > 0 && (
        <Field label={t('layersPanel.provenance.identityField')}>
          {t('layersPanel.provenance.identityCount', {
            count: manifest.identity_map.length,
            countDisplay: String(manifest.identity_map.length),
          })}
        </Field>
      )}
      {manifest.signatures.length > 0 && (
        <Field label={t('layersPanel.provenance.signedField')}>
          {t('layersPanel.provenance.signaturesCount', {
            count: manifest.signatures.length,
            countDisplay: String(manifest.signatures.length),
          })}
        </Field>
      )}
    </div>
  );
}
