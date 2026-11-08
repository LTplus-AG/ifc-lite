// Modelling parity SDK probe: dimensions-tags (#9296). Documentation capability: drawings are made in the
// viewer's 2D drawing workspace. The headless SDK cannot cut them from the model (bim.drawing
// exposes presets, symbols and SVG export of a drawing the caller builds), so the SDK level
// reports skip with that reason, never pass. The UI probe (lane L4) measures it.
const P = await import(process.env.PARITY_LIB);
P.probe(bim, 'dimensions-tags').skip('documentation capability: the headless SDK has no operation that cuts plans, sections or elevations from the model or lays out sheets (bim.drawing only offers presets, symbols and SVG export of a caller-built drawing); measured by the UI probe (L4)');
