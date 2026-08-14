// ABOUTME: Keeps every query whose size follows the data under D1's bound-parameter ceiling.
// ABOUTME: A statement built from a list of ids runs through here or D1 refuses it outright.

// D1 binds at most 100 parameters per query. The budget stays below that so the predicates
// bound beside a list - an id, a gate's status values, a later filter - always fit too.
export const boundParameterBudget = 80;

export function chunkIds<Item>(ids: Item[], size: number = boundParameterBudget): Item[][] {
  const chunks: Item[][] = [];
  for (let index = 0; index < ids.length; index += size) {
    chunks.push(ids.slice(index, index + size));
  }
  return chunks;
}
