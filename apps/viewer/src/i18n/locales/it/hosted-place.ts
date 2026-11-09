/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const hostedPlaceIt = {
  'hostedPlace.tool.opening': 'Apertura',
  'hostedPlace.tool.door': 'Porta',
  'hostedPlace.tool.window': 'Finestra',
  'hostedPlace.hint.opening': 'Punta un muro e fai clic per ritagliare un’apertura · Esc per uscire',
  'hostedPlace.hint.door': 'Punta un muro e fai clic per posizionare la porta · Esc per uscire',
  'hostedPlace.hint.window': 'Punta un muro e fai clic per posizionare la finestra · Esc per uscire',
  'hostedPlace.field.offset': 'Scostamento',
  'hostedPlace.field.sill': 'Davanzale',
  'hostedPlace.noHost': 'Porte, finestre e aperture vanno in un muro: puntane uno su questo piano',
  'hostedPlace.outsideHost': 'Non entra in questo muro: modificane scostamento, davanzale o dimensioni',
  'commandPalette.tool.opening.label': 'Ritaglia aperture',
  'commandPalette.tool.door.label': 'Posiziona porte',
  'commandPalette.tool.window.label': 'Posiziona finestre',
  'commands.model.opening': 'Ritaglia aperture nei muri (spazio di lavoro Modello)',
  'commands.model.door': 'Posiziona porte nei muri (spazio di lavoro Modello)',
  'commands.model.window': 'Posiziona finestre nei muri (spazio di lavoro Modello)',
  'modelInspector.hosting.host': 'Elemento ospitante',
  'modelInspector.hosting.selectHost': 'Seleziona elemento ospitante',
  'modelInspector.hosting.offset': 'Scostamento',
  'modelInspector.hosting.sill': 'Davanzale',
  'modelInspector.hosting.none': 'Non ospitato: questo elemento non riempie alcuna apertura in un muro.',
  'modelInspector.hosting.invalid': 'Digita una lunghezza in metri',
  'modelInspector.type.noClass': '{schema} non ha {typeClass}, quindi questo elemento non mantiene alcun tipo.',
} satisfies Catalogue;
