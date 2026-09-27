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

export async function attachKitBarcode(
  shipheroToken: string,
  args: { identity: KitProductIdentity; orderNumber: string; transferNumber: string; shipheroOrderId?: string | null }
): Promise<string | null> {
  const bc = args.identity.barcode;
  if (!bc) return null;
  const png = await renderBarcodePng(bc, `${bc.kind} · ${args.orderNumber}`);
  const filename = `${bc.kind}-${bc.value}.png`;
  const url = await uploadToSupabase(`${args.transferNumber}/barcode/${filename}`, png, 'image/png');

  // Attach to the ShipHero order so it sits next to the labels later.
  try {
    const found = await findShipheroOrder(shipheroToken, args.transferNumber);
    if (found) {
      await attachToShipHero(shipheroToken, found.orderId, found.accountId, url,
        `Kitting barcode — ${bc.kind} ${bc.value} (apply one per finished pack)`, filename);
    } else {
      console.warn(`[kit-barcode] ${args.transferNumber}: ShipHero order not found for attachment; barcode still at ${url}`);
    }
  } catch (e: any) {
    console.warn(`[kit-barcode] ${args.transferNumber}: attach failed (non-fatal): ${e?.message || e}`);
  }
  return url;
}
