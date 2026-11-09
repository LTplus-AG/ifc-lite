/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render';
import { editedRegistryModel } from '@/test/registry-model-fixture';
import { registerEnglish } from '@/i18n';
import { registryEn } from '@/i18n/catalogues/registry.en';
import { useHandoffWorkspace } from '@/lib/registry/handoff-workspace';
import { resourceSession } from '@/lib/registry/handoff-auth';
import { startServer, closeAll } from '../../../../../packages/oci/test/fake-registry.js';
import { pushRegistry } from '../../../../../packages/oci/test/push-registry.js';
import { OciPushTo } from './OciPushTo';
registerEnglish(registryEn);
afterEach(async () => { cleanup(); useHandoffWorkspace.setState({ handoff:undefined, sourceSession:undefined, destinationSession:undefined, saved:undefined, loadedModelId:undefined }); await closeAll(); });
async function waitFor(predicate: () => boolean) { for (let i=0;i<100;i++) { if (predicate()) return; await act(async () => { await new Promise(r => setTimeout(r,10)); }); } assert(predicate(),'operation should complete'); }

test('Push to publishes a real edited model without any preceding launch and returns a pinned reopen link', async () => {
  const model=await editedRegistryModel(), fixture=pushRegistry({repository:'project/model',accept:a => a==='Bearer destination-only'}), server=await startServer((req,res) => { res.setHeader('Access-Control-Allow-Origin',window.location.origin); res.setHeader('Access-Control-Allow-Headers','authorization,content-type'); res.setHeader('Access-Control-Allow-Methods','GET,HEAD,POST,PUT,OPTIONS'); res.setHeader('Access-Control-Expose-Headers','Location,Docker-Content-Digest'); if (req.method==='OPTIONS') { res.writeHead(204); res.end(); return; } return fixture.handler(req,res); });
  const scope='repository:project/model:pull repository:project/model:push';
  useHandoffWorkspace.setState({destinationSession:resourceSession({access_token:'destination-only',token_type:'Bearer',expires_in:300,scope},server.origin,scope)});
  const ui=render(<OciPushTo connections={[{registry:server.origin,authorization_server:'https://identity.example.test',client_id:'ifc-lite'}]} onBusyChange={() => {}} />);
  const button=Array.from(ui.querySelectorAll('button')).find(b => b.textContent==='Push to…');assert(button);click(button);
  await waitFor(() => Boolean(useHandoffWorkspace.getState().saved));
  const saved=useHandoffWorkspace.getState().saved!;
  assert.equal(saved.registry,server.origin);
  const manifest=fixture.store.manifests.get(saved.digest);assert(manifest);
  const descriptor=JSON.parse(new TextDecoder().decode(manifest.bytes)).layers[0];
  const bytes=fixture.store.blobs.get(descriptor.digest);assert(bytes);
  const reopened=await model.parser.parseColumnar(new Uint8Array(bytes).buffer,{disableWorkerScan:true});
  assert.equal(reopened.entities.getName(model.wall),'Registry persisted wall');
  const link=ui.querySelector('a');assert(link);
  const encoded=new URL(link.href).hash.slice('#handoff='.length);
  assert.deepEqual(JSON.parse(Buffer.from(encoded,'base64url').toString()).source,saved);
  assert(server.requests.filter(r => r.authorization).every(r => r.authorization==='Bearer destination-only'));
});
