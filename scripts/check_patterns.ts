import { getLasVegasSkuPatterns } from '../lib/tiktok-routing';
async function main() {
  const p = await getLasVegasSkuPatterns();
  console.log(`${p.length} patterns:`);
  p.forEach(x => console.log(`  ${x}`));
}
main().catch(e => { console.error(e); process.exit(1); });
