import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getShipHeroProductData, getShipHeroToken } from '../../lib/shiphero-product-data';
import { lookupSkuMapping, createFbaInboundShipment, fetchFbaLabels } from '../../lib/fba-orchestrator';

export const config = { maxDuration: 300 };

function requireAuth(req: VercelRequest, res: VercelResponse): boolean {
  const auth = req.headers.authorization?.replace('Bearer ', '');
  if (auth !== process.env.CRON_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

/**
 * Fully automated FBA submission.
 * 
 * Takes a CIN7 transfer with SKU + quantity, auto-pulls everything from ShipHero:
 * - Case pack quantity + box dimensions (from product_note)
 * - Expiration date (from expiration_lots)
 * - Amazon MSKU mapping (from sku_master + amazon_products)
 * 
 * Then submits to Amazon FBA and returns labels.
 *
 * POST /api/fba/auto-submit
 * {
 *   cin7_transfer_number: "TR-00029",
 *   items: [{ sku: "CN-DRP-BLOODSUGAR-2OZ", quantity: 90 }]
 * }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  try {
    const { cin7_transfer_number, items } = req.body;

    if (!cin7_transfer_number || !items?.length) {
      return res.status(400).json({
        error: 'Required: cin7_transfer_number, items (array of {sku, quantity})',
      });
    }

    const supabaseUrl = process.env.SUPABASE_URL!;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const warehouseId = process.env.SHIPHERO_WAREHOUSE_ID || '22e17170-af72-4bf8-b77c-d73c86b06765';

    // Get ShipHero token
    const shipheroToken = await getShipHeroToken(supabaseUrl, supabaseKey, warehouseId);

    const results: any[] = [];

    for (const item of items) {
      console.log(`[fba-auto] Processing ${item.sku} x ${item.quantity}...`);

      // 1. Resolve CIN7 SKU → Amazon MSKU
      const skuMapping = await lookupSkuMapping(item.sku);
      if (!skuMapping?.amz_sku) {
        results.push({
          sku: item.sku,
          status: 'failed',
          error: `No Amazon SKU mapping found for ${item.sku}`,
        });
        continue;
      }

      // 2. Pull product data from ShipHero (case dims, expiration)
      const productData = await getShipHeroProductData(shipheroToken, item.sku);
      console.log(`[fba-auto] ShipHero data:`, JSON.stringify({
        casePack: productData.casePack,
        expiration: productData.expirationDate,
        lot: productData.lotNumber,
      }));

      if (!productData.casePack) {
        results.push({
          sku: item.sku,
          status: 'failed',
          error: `No case pack data in ShipHero product_note for ${item.sku}. Add "Box Weight: X Lbs, Box Size: LxWxH inches, Quantity per Case: N" to ShipHero product notes.`,
        });
        continue;
      }

      if (!productData.expirationDate) {
        results.push({
          sku: item.sku,
          status: 'failed',
          error: `No expiration date found in ShipHero for ${item.sku}`,
        });
        continue;
      }

      // 3. Calculate box count
      const casePack = productData.casePack;
      const totalQty = item.quantity;
      const numBoxes = Math.ceil(totalQty / casePack.caseQuantity);
      const unitsPerBox = casePack.caseQuantity;

      console.log(`[fba-auto] ${totalQty} units ÷ ${unitsPerBox} per case = ${numBoxes} boxes`);

      // 4. Submit to Amazon FBA
      console.log(`[fba-auto] Submitting to Amazon: ${skuMapping.amz_sku} x ${totalQty}, ${numBoxes} boxes of ${unitsPerBox} each, exp ${productData.expirationDate}`);

      const fbaResult = await createFbaInboundShipment(
        warehouseId,
        [{
          sellerSku: skuMapping.amz_sku,
          quantity: totalQty,
          casePack: unitsPerBox,
          cases: numBoxes,
          expiration: productData.expirationDate,
        }],
        {
          length: casePack.boxLength,
          width: casePack.boxWidth,
          height: casePack.boxHeight,
        },
        casePack.boxWeightLbs,
        {
          boxQuantity: numBoxes,
          casePack: unitsPerBox,
        }
      );

      // 5. Fetch labels
      const shipmentIds = fbaResult.shipmentIds || fbaResult.amazon_shipment_ids || [];
      const confirmationIds = fbaResult.shipmentConfirmationIds || [];
      let labelsUrl: string | null = null;

      const labelId = confirmationIds[0] || shipmentIds[0];
      if (labelId) {
        const labelResult = await fetchFbaLabels(labelId);
        labelsUrl = labelResult.downloadUrl;
      }

      results.push({
        sku: item.sku,
        amazon_sku: skuMapping.amz_sku,
        status: 'success',
        quantity: totalQty,
        boxes: numBoxes,
        units_per_box: unitsPerBox,
        box_dims: `${casePack.boxLength}x${casePack.boxWidth}x${casePack.boxHeight} in`,
        box_weight: `${casePack.boxWeightLbs} lbs`,
        expiration: productData.expirationDate,
        lot: productData.lotNumber,
        amazon_shipment_ids: shipmentIds,
        labels_url: labelsUrl,
        prep: fbaResult.prepInstructions || fbaResult.prep_instructions,
      });
    }

    res.status(200).json({
      cin7_transfer_number,
      processed: results.length,
      successful: results.filter(r => r.status === 'success').length,
      failed: results.filter(r => r.status === 'failed').length,
      results,
    });
  } catch (error) {
    console.error('[fba-auto] Error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
}
