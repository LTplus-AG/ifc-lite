// Modelling parity SDK probe: snapping-inference (#9296). UI-only capability: there is no SDK surface by
// design (a script passes exact coordinates), so the SDK level reports skip, never pass.
// The UI probe (lane L4, tests/modelling-parity/ui) measures it on the real GPU.
const P = await import(process.env.PARITY_LIB);
P.probe(bim, 'snapping-inference').skip('UI-only capability: a headless script passes exact coordinates, so there is nothing to probe at the SDK level; measured by the UI probe (L4)');
