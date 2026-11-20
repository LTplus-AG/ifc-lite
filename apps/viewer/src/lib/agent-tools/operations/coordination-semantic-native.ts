/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { BsddNamespace } from '@ifc-lite/sdk';
import { isFeatureEnabled } from '@/lib/features';
import { DEFAULT_MAPPING, DEFAULT_PROFILE, assertProfile, assertResourceUriIdentityConfig, dictionaryToProfile, generateArtifacts, asJsonLd, profileFromBsdd, type BindingMapping, type ProfileDefinition } from '@ifc-lite/semantic';
import { useSemanticSession } from '@/lib/semantic/session';
import { useSemanticEndpointGrant } from '@/lib/semantic/assist/endpoint-grant';
import { loadSemanticSource } from '@/lib/semantic/load-source';
import { useViewerStore } from '@/store';
import { coordination, textSchema } from './coordination-common';
import { emptySchema } from './contract';
function mappingOf(json: string): BindingMapping {
  const value: unknown = JSON.parse(json); if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(item => typeof item !== 'string')) throw new Error('Native binding mapping must be a plain string-valued object.'); return value as BindingMapping;
}
export const coordinationSemanticNativeOperations = [
  coordination<{ mode: 'local' | 'turtle' | 'nquads' | 'jsonld' | 'json' | 'sparql' | 'construct'; payload: string; query: string; mapping_json: string; related_selection: boolean; expected_data_version: number; expected_endpoint: string; expected_grant_generation: number }>('semantic.loadSource', 'Load bounded JSON/RDF or retrieve from the already exercised native endpoint grant through the same provider and validation worker as the panel. Related selection uses native identity/query resolution. Credentials/loopback/host grants cannot be supplied or broadened.', ['configuration', 'network'], {
    type: 'object', properties: { mode: { type: 'string', enum: ['local', 'turtle', 'nquads', 'jsonld', 'json', 'sparql', 'construct'] }, payload: { type: 'string', maxLength: 5000000 }, query: { type: 'string', maxLength: 100000 }, mapping_json: { type: 'string', maxLength: 100000 }, related_selection: { type: 'boolean' }, expected_data_version: { type: 'integer', minimum: 0 }, expected_endpoint: { type: 'string', maxLength: 10000 }, expected_grant_generation: { type: 'integer', minimum: 0 } }, required: ['mode', 'payload', 'query', 'mapping_json', 'related_selection', 'expected_data_version', 'expected_endpoint', 'expected_grant_generation'], additionalProperties: false,
  }, async (i, c) => {
    const session = useSemanticSession.getState(), authority = useSemanticEndpointGrant.getState(), models = useViewerStore.getState().models;
    if (session.dataVersion !== i.expected_data_version) throw new Error('Native semantic dataset changed.');
    const remote = ['json', 'sparql', 'construct'].includes(i.mode); const grant = authority.grant;
    if (remote && (!grant || grant.endpoint !== i.expected_endpoint || authority.generation !== i.expected_grant_generation)) throw new Error('An exact existing native endpoint grant is required; exercise it in Linked records first.');
    const input = { mode: i.mode, payload: i.payload, query: i.query, mapping: mappingOf(i.mapping_json), endpoint: remote ? grant!.endpoint : '', host: remote ? grant!.host : '', bearer: remote ? grant!.bearer : undefined, relayProvider: remote ? grant!.relayProvider : undefined, loopbackHttpOrigin: remote ? grant!.loopbackHttpOrigin : undefined };
    if (i.related_selection) {
      if (!remote) throw new Error('Related retrieval requires a native endpoint grant.');
      const [{ queryForSelection }, { createSelectionAdapter }, { liveEntities }] = await Promise.all([import('@/lib/semantic/related-query'), import('@/sdk/adapters/selection-adapter'), import('@/lib/semantic/viewer')]);
      input.query = queryForSelection({ selection: createSelectionAdapter(useViewerStore).get(), entities: liveEntities(), revisions: session.revisions, profile: session.profile, mapping: session.resultMapping ?? input.mapping, document: session.document, results: session.results, settings: session }); input.mode = 'sparql'; input.mapping = { ...DEFAULT_MAPPING, id: 'subject' };
    }
    const guard = () => { c.checkpoint?.(); if (useViewerStore.getState().models !== models || remote && useSemanticEndpointGrant.getState().generation !== authority.generation) throw new Error('Native model binding or endpoint authority changed.'); };
    let committed = false;
    guard(); const outcome = await loadSemanticSource(input, c.signal ?? new AbortController().signal, undefined, undefined, write => { guard(); const value = c.commit(write); committed = true; return value; });
    // A cancelled load never reports success: before any write the dataset is unchanged; after one,
    // records were stored but validation did not finish.
    if (c.signal?.aborted) throw committed
      ? new DOMException('The semantic load was cancelled after its records were stored; validation did not finish. Load again to validate.', 'AbortError')
      : c.signal.reason ?? new DOMException('The semantic load was cancelled.', 'AbortError');
    return outcome;
  }),
  coordination('semantic.endpoint', 'Inspect only the identity/generation of the already exercised native endpoint grant; credentials and relay secrets remain private.', ['read'], emptySchema, () => { const state = useSemanticEndpointGrant.getState(); return { endpoint: state.grant?.endpoint ?? null, generation: state.generation, configured: !!state.grant }; }),
  coordination<{ kind: 'profile' | 'dictionary' | 'reference'; definition: string }>('semantic.profile', 'Import a native data-only profile/dictionary using the canonical validators, or restore the reference profile. Imported JSON cannot supply executable contexts or shapes.', ['configuration'], {
    type: 'object', properties: { kind: { type: 'string', enum: ['profile', 'dictionary', 'reference'] }, definition: { type: 'string', maxLength: 1000000 } }, required: ['kind', 'definition'], additionalProperties: false,
  }, (i, c) => { if (new TextEncoder().encode(i.definition).byteLength > 1024 * 1024) throw new Error('Native profile/dictionary exceeds the 1 MiB byte limit.'); let profile: ProfileDefinition = DEFAULT_PROFILE; let diagnostics: string[] = []; if (i.kind === 'profile') { const value: unknown = JSON.parse(i.definition); assertProfile(value); profile = value; } if (i.kind === 'dictionary') { const imported = dictionaryToProfile(JSON.parse(i.definition) as unknown); profile = imported.profile; diagnostics = imported.diagnostics; } return c.commit(() => { useSemanticSession.getState().setProfile(profile); return { profile, diagnostics }; }); }),
  { ...coordination<{ class_uri: string }>('semantic.profileFromBsdd', 'Build the native data-only profile from an exact bSDD class using the same configured proxy as the profile control. Retains native third-party privacy gate and rejects a changed profile.', ['network', 'configuration'], {
    type: 'object', properties: { class_uri: { type: 'string', minLength: 1, maxLength: 4000 } }, required: ['class_uri'], additionalProperties: false,
  }, async (i, c) => { if (!isFeatureEnabled('privacy.third-party')) throw new Error('Native third-party providers are disabled.'); const initial = useSemanticSession.getState().profile; const imported = await profileFromBsdd(new BsddNamespace({ apiBase: '/api/bsdd' }), i.class_uri, { id: i.class_uri + '/ifc-lite-profile', version: '1.0.0', vocabulary: i.class_uri + '#' }); return c.commit(() => { if (!isFeatureEnabled('privacy.third-party') || useSemanticSession.getState().profile !== initial) throw new Error('Native privacy grant or profile changed.'); useSemanticSession.getState().setProfile(imported.profile); return imported; }); }), features: ['privacy.third-party'] as const },
  coordination('semantic.profileArtifact', 'Export the current native profile with generated data-only validation artifacts.', ['artifact'], emptySchema, async (_, c) => { const profile = useSemanticSession.getState().profile, artifacts = await generateArtifacts(profile); return c.artifacts.create({ filename: 'semantic-profile.json', mimeType: 'application/json', data: JSON.stringify({ profile, artifacts }, null, 2) }); }),
  coordination('semantic.links', 'Apply bounded native resource identity links through the exact parser used by the identity controls.', ['configuration'], textSchema, async (i, c) => { const { parseResourceLinks } = await import('@/lib/semantic/identity-input'); const links = parseResourceLinks(i.value); return c.commit(() => { useSemanticSession.getState().setLinks(links); return { links }; }); }),
  coordination<{ strategy: 'ifc-global-id' | 'resource-links' | 'profile-fields' | 'resource-uri'; GlobalId: string; modelRevision: string; uri_mode: 'template' | 'last-path-segment'; uri_template: string }>('semantic.identity', 'Configure the existing native identity strategy, profile field binding and resource URI template using canonical validation. Revision/model bindings remain explicit.', ['configuration'], {
    type: 'object', properties: { strategy: { type: 'string', enum: ['ifc-global-id', 'resource-links', 'profile-fields', 'resource-uri'] }, GlobalId: { type: 'string', minLength: 1, maxLength: 500 }, modelRevision: { type: 'string', maxLength: 500 }, uri_mode: { type: 'string', enum: ['template', 'last-path-segment'] }, uri_template: { type: 'string', maxLength: 10000 } }, required: ['strategy', 'GlobalId', 'modelRevision', 'uri_mode', 'uri_template'], additionalProperties: false,
  }, (i, c) => c.commit(() => {
    const s = useSemanticSession.getState(); if (i.strategy === 'profile-fields' && (s.profile.fields[i.GlobalId]?.kind !== 'string' || i.modelRevision && !['string', 'iri'].includes(s.profile.fields[i.modelRevision]?.kind))) throw new Error('Native identity fields are not compatible with this profile.');
    // The same validation the identity controls run before applying a URI rule.
    const uriConfig = i.uri_mode === 'template' ? { mode: i.uri_mode, template: i.uri_template } as const : { mode: i.uri_mode } as const;
    assertResourceUriIdentityConfig(uriConfig);
    s.setUriConfig(uriConfig); s.setIdentityFields({ GlobalId: i.GlobalId, ...(i.modelRevision ? { modelRevision: i.modelRevision } : {}) }); s.setStrategy(i.strategy); return { strategy: i.strategy, identity_fields: useSemanticSession.getState().identityFields, uri_config: useSemanticSession.getState().uriConfig };
  })),
  coordination('semantic.export', 'Export the same native linked-records evidence bundle as the panel, including generated artifacts and original reference-profile disclaimer.', ['artifact'], emptySchema, async (_, c) => { const s = useSemanticSession.getState(), assets = await generateArtifacts(s.profile), { PILOT_QUERY } = await import('@/lib/semantic/demo'); return c.artifacts.create({ filename: 'semantic-records.json', mimeType: 'application/json', data: JSON.stringify({ document: s.document, ...assets, jsonLd: s.document ? asJsonLd(s.document, s.profile) : undefined, graph: s.graph, graphFormat: s.graphFormat, nquads: s.graphFormat === 'application/n-quads' ? s.graph : undefined, sparqlResults: s.results, selectQuery: PILOT_QUERY, note: 'Original reference profile; no standards conformity claim.' }, null, 2) }); }),
];
