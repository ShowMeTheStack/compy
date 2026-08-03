// Bundle budget gate: the whole static site (excluding the lazily loaded
// AI model, which never ships in the bundle) must stay small enough to load
// fast on a classroom network.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BUDGET_BYTES = 3 * 1024 * 1024;
const dist = new URL('../packages/ide/dist/', import.meta.url).pathname;

function walk(dir) {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    total += st.isDirectory() ? walk(p) : st.size;
  }
  return total;
}
const total = walk(dist);
console.log(`dist size: ${(total / 1024).toFixed(0)} KB (budget ${(BUDGET_BYTES / 1024).toFixed(0)} KB)`);
if (total > BUDGET_BYTES) {
  console.error('Bundle exceeds the budget.');
  process.exit(1);
}
