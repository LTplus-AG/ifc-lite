// Modelling parity SDK probe: typed-input-temp-dims (#9296). UI-only capability: there is no SDK surface by
// design (a script passes exact coordinates), so the SDK level reports skip, never pass.
// The UI probe (lane L4, tests/modelling-parity/ui) measures it on the real GPU.
const P = await import(process.env.PARITY_LIB);
P.probe(bim, 'typed-input-temp-dims').skip('UI-only capability: a headless script passes exact coordinates, so there is nothing to probe at the SDK level; measured by the UI probe (L4)');
