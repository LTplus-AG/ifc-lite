// Modelling parity output probe helper (#9296): run as `ifc-lite run reopen.js <file.ifc>`.
// Prints the reopened model's product census and, with PARITY_REEXPORT set, writes a second
// IFC4 export of the reopened model there. Lines are tagged for tests/modelling-parity/output/run.mjs.
const P = await import(process.env.PARITY_LIB);
const fs = await import('node:fs');
console.log(`@@CENSUS@@${JSON.stringify(P.census(bim))}`);
if (process.env.PARITY_REEXPORT) fs.writeFileSync(process.env.PARITY_REEXPORT, String(bim.export.ifc(null, { schema: 'IFC4' })));
