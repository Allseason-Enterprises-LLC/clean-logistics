/**
 * Render the kitting barcode, upload it to storage, attach it to the ShipHero
 * order. Production implementation of GateDeps.attachBarcode.
 * Returns the public URL, or null if anything failed (caller is fail-open).
 *
 * Storage path mirrors labels: shipment-labels/TR-XXXXX/barcode/<KIND>-<value>.png
 * Attachment is idempotent (attachToShipHero pre-flights by filename).
 */
import { renderBarcodePng, type KitProductIdentity } from './kit-product-identity';
import { uploadToSupabase, attachToShipHero, findShipheroOrder } from './fba-post-process';
import { SHIPHERO_CUSTOMER_ACCOUNT_ID } from './kit-work-order-gate';

export async function attachKitBarcode(
  shipheroToken: string,
  args: { identity: KitProductIdentity; orderNumber: string; transferNumber: string; shipheroOrderId?: string | null }
): Promise<string | null> {
  const bc = args.identity.barcode;
  if (!bc) return null;
  // Caption = what the scanner reads + which kind. Never the order number —
  // the human-readable line under a barcode must be the code itself.
  const png = await renderBarcodePng(bc, bc.kind);
  const filename = `${bc.kind}-${bc.value}.png`;
  const url = await uploadToSupabase(`${args.transferNumber}/barcode/${filename}`, png, 'image/png');

  // Attach to the ShipHero order so it sits next to the labels later. Prefer
  // the order id we were handed (the gate has it); findShipheroOrder is a
  // fallback only — a Reference-derived name like REF_B0HJN6KKVK_00484 carries
  // no "TR-" token, so the TR scan cannot resolve it (found 2026-09-27).
  try {
    let orderId = args.shipheroOrderId || null;
    let accountId = SHIPHERO_CUSTOMER_ACCOUNT_ID;
    if (!orderId) {
      const found = await findShipheroOrder(shipheroToken, args.transferNumber);
      if (found) { orderId = found.orderId; accountId = found.accountId; }
    }
    if (orderId) {
      const r = await attachToShipHero(shipheroToken, orderId, accountId, url,
        `Kitting barcode — ${bc.kind} ${bc.value} (apply one per finished pack)`, filename, 'image/png');
      console.log(`[kit-barcode] ${args.transferNumber}: attached ${filename} to ${orderId} (created=${r.created})`);
    } else {
      console.warn(`[kit-barcode] ${args.transferNumber}: no ShipHero order id for attachment; barcode still at ${url}`);
    }
  } catch (e: any) {
    console.warn(`[kit-barcode] ${args.transferNumber}: attach failed (non-fatal): ${e?.message || e}`);
  }
  return url;
}
