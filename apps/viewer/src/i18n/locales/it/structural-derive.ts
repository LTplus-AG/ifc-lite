/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const structuralDeriveIt = {
  "structuralDerive.hint": "Travi, pilastri e aste diventano elementi lineari; solai e muri diventano elementi superficiali sul piano medio; le estremità che si incontrano condividono un nodo; le fondazioni portano i vincoli. Ogni elemento derivato è collegato al suo elemento fisico. Vengono creati record IFC; il progetto non viene verificato.",
  "structuralDerive.prepare": "Deriva e verifica",
  "structuralDerive.acknowledgement": "Ho verificato gli elementi saltati e i vincoli ipotizzati.",
  "structuralDerive.counts": "{curveMembers} elementi lineari · {surfaceMembers} elementi superficiali · {nodes} nodi · {supports} vincoli, di cui {guessedSupports} ipotizzati · {created} record IFC da creare",
  "structuralDerive.assumed": "{count} elementi non hanno un valore LoadBearing e sono considerati portanti.",
  "structuralDerive.skipped": "Elementi saltati ({count})",
  "structuralDerive.guessed": "Vincoli ipotizzati ai nodi più bassi, perché nessuna fondazione ne porta uno ({count})",
  "structuralDerive.unconnected": "Nodi che toccano un elemento o una superficie senza esservi collegati ({count})",
  "structuralDerive.existing": "Questo modello ha già un modello di analisi ({ids}). Non viene derivato nulla accanto.",
  "structuralDerive.nothing": "Niente da derivare: nessun elemento portante è stato idealizzato, oppure ognuno ha già un corrispondente strutturale.",
  "structuralDerive.noModel": "Carica un modello per derivarne il modello di analisi strutturale.",
  "structuralDerive.nodeAt": "Nodo {node}: {position} m",
  "structuralDerive.endAt": "Nodo {node}: {position} m, {landsOn} #{element}",
  "structuralDerive.more": "Altri {count} non mostrati",
  "structuralDerive.model": "Modello: {name}",
  "structuralDerive.moved": "Estremità di aste spostate lungo il loro asse per formare un nodo ({count})",
  "structuralDerive.movedRow": "#{element} {end}: {distance} m fino a #{to}",
  "structuralDerive.free": "Estremità libere, senza altre aste né vincoli ({count})",
  "structuralDerive.end.start": "inizio",
  "structuralDerive.end.end": "fine",
  "structuralDerive.reason.already-idealised": "ha già un corrispondente strutturale",
  "structuralDerive.reason.not-load-bearing": "non portante",
  "structuralDerive.reason.load-bearing-unknown": "nessun valore LoadBearing",
  "structuralDerive.reason.no-idealisable-shape": "forma non idealizzabile",
  "structuralDerive.reason.shorter-than-tolerance": "più corto della tolleranza",
  "structuralDerive.reason.footing-without-member-end": "nessuna estremità su questa fondazione",
  "structuralDerive.landsOn.member-interior": "su elemento lineare",
  "structuralDerive.landsOn.surface-member": "su elemento superficiale",
} satisfies Catalogue;
