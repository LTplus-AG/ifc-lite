// SPDX-License-Identifier: MPL-2.0
// #7955 J4: actual package, module Worker and shared product transaction.
export async function runProductContract({ wasm, api, bytes, keep, assert, rejects }) {
  const model = keep(api.bindRetainedModel(bytes));
  await rejects(() => model.admitProduct(12), /canonical.*product/i, 'a source solid is not a product job');
  const product = keep(model.admitProduct(31));
  await rejects(() => product.witness(), /not completed/i, 'no witness before completion');
  const executor = keep(new wasm.RetainedBrowserExecutor());
  await rejects(() => product.execute(executor, 0, 5, 16 << 20), /invalid.*limits/i, 'invalid limits submit nothing');
  const result = await product.execute(executor, 0.001, 5, 16 << 20);
  assert(result.contract === 'common_product_transaction_only', 'shared product witness contract');
  assert(result.product_id === 31 && result.discharged_operations === 1 && result.occurrences === 1,
    `mapped product consumes one source construction: ${JSON.stringify(result)}`);
  assert(result.final_product_available === false && result.remaining_requirements.length > 0,
    'unresolved product requirements prohibit final publication');
  assert(product.witness().discharged_operations === 1, 'completed receipts remain live');
  await rejects(() => product.execute(executor, 0.001, 5, 16 << 20), /already started/i, 'execution cannot be replayed');

  const sibling = keep(model.admitProduct(38));
  const siblingResult = await sibling.execute(executor, 0.001, 5, 16 << 20);
  assert(siblingResult.product_id === 38 && siblingResult.discharged_operations === 1,
    'a second product executes on the same live Worker');
  assert(product.witness().product_id === 31, 'a second transaction preserves the first receipt');
  model.invalidateSource();
  await rejects(() => product.witness(), /Source|Expired|Invalidated/i, 'source replacement expires completed witnesses');
  await rejects(() => model.admitProduct(31), /Expired|Invalidated/i, 'source replacement refuses new admissions');
  executor.retire();
  return { productId: result.product_id, dischargedOperations: result.discharged_operations,
    occurrences: result.occurrences, finalProductAvailable: false, sourceInvalidationChecked: true };
}
