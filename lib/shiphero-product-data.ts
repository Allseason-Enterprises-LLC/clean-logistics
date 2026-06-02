/**
 * Pull case pack dims, expiration, and product data from ShipHero.
 * Parses product_note field for box dimensions.
 */

const SHIPHERO_API = 'https://public-api.shiphero.com/graphql';

interface CasePackData {
  caseQuantity: number;
  boxLength: number;
  boxWidth: number;
  boxHeight: number;
  boxWeightLbs: number;
}

interface ProductData {
  sku: string;
  name: string;
  unitWeight: number;
  casePack: CasePackData | null;
  expirationDate: string | null;
  lotNumber: string | null;
}

/**
 * Parse ShipHero product_note for case pack dimensions.
 *
 * Accepts both common label formats observed in the wild:
 *
 *   Format A:                          Format B (Case Spec):
 *     Box Weight: 22 Lbs                 Case Spec:
 *     Box Size: 16 x 20 x 5 inches       Qty per case: 60
 *     Quantity per Case: 90 bottles      Weight: 35 lbs
 *                                        Dims: 20 x 14 x 6
 *
 * Match is case-insensitive, tolerates extra/missing units, and only requires
 * that we end up with both a positive case quantity and a length dimension.
 */
function parseCasePackFromNote(note: string | null): CasePackData | null {
  if (!note) return null;

  let boxWeight = 0;
  let boxLength = 0;
  let boxWidth = 0;
  let boxHeight = 0;
  let caseQuantity = 0;

  // Box Weight  /  Weight
  const weightMatch =
    note.match(/Box\s*Weight[:\s]*(\d+\.?\d*)\s*(Lbs?|pounds?)?/i) ||
    note.match(/(?:^|\n)\s*Weight[:\s]*(\d+\.?\d*)\s*(Lbs?|pounds?)?/i);
  if (weightMatch) {
    boxWeight = parseFloat(weightMatch[1]);
  }

  // Box Size  /  Dims  /  Dimensions  (L x W x H)
  const sizeMatch =
    note.match(/Box\s*Size[:\s]*(\d+\.?\d*)\s*x\s*(\d+\.?\d*)\s*x\s*(\d+\.?\d*)\s*(inches?|in)?/i) ||
    note.match(/Dim(?:ension)?s?[:\s]*(\d+\.?\d*)\s*x\s*(\d+\.?\d*)\s*x\s*(\d+\.?\d*)\s*(inches?|in)?/i);
  if (sizeMatch) {
    boxLength = parseFloat(sizeMatch[1]);
    boxWidth = parseFloat(sizeMatch[2]);
    boxHeight = parseFloat(sizeMatch[3]);
  }

  // Quantity per Case  /  Qty per case  /  Case Qty
  const qtyMatch =
    note.match(/Quantity\s*per\s*Case[:\s]*(\d+)\s*(bottles?|units?|pcs?|ea)?/i) ||
    note.match(/Qty\s*per\s*case[:\s]*(\d+)\s*(bottles?|units?|pcs?|ea)?/i) ||
    note.match(/Case\s*Qty[:\s]*(\d+)\s*(bottles?|units?|pcs?|ea)?/i);
  if (qtyMatch) {
    caseQuantity = parseInt(qtyMatch[1]);
  }

  if (caseQuantity > 0 && boxLength > 0) {
    return { caseQuantity, boxLength, boxWidth, boxHeight, boxWeightLbs: boxWeight };
  }

  return null;
}

/**
 * Get full product data from ShipHero including case pack and expiration.
 */
export async function getShipHeroProductData(
  shipheroToken: string,
  sku: string
): Promise<ProductData> {
  // Query product details + expiration lots
  const productQuery = `{
    products(sku: "${sku}") {
      data(first: 1) {
        edges {
          node {
            sku
            name
            product_note
            dimensions {
              length
              width
              height
              weight
            }
          }
        }
      }
    }
    expiration_lots(sku: "${sku}") {
      data(first: 5) {
        edges {
          node {
            name
            sku
            expires_at
            is_active
          }
        }
      }
    }
  }`;

  const response = await fetch(SHIPHERO_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${shipheroToken}`,
    },
    body: JSON.stringify({ query: productQuery }),
  });

  const json: any = await response.json();
  if (json.errors) {
    throw new Error(`ShipHero query error: ${JSON.stringify(json.errors)}`);
  }

  const product = json.data?.products?.data?.edges?.[0]?.node;
  if (!product) {
    throw new Error(`Product ${sku} not found in ShipHero`);
  }

  // Parse case pack from product note
  const casePack = parseCasePackFromNote(product.product_note);

  // Get expiration from active lots
  const lots = json.data?.expiration_lots?.data?.edges || [];
  const activeLot = lots.find((e: any) => e.node.is_active);
  const expirationDate = activeLot?.node?.expires_at || null;
  const lotNumber = activeLot?.node?.name || null;

  // Unit weight
  const weight = product.dimensions?.weight;
  const unitWeight = weight ? parseFloat(weight.replace(/[^\d.]/g, '')) : 0;

  return {
    sku: product.sku,
    name: product.name,
    unitWeight,
    casePack,
    expirationDate,
    lotNumber,
  };
}

/**
 * Get ShipHero access token from Supabase warehouse record.
 */
export async function getShipHeroToken(
  supabaseUrl: string,
  supabaseKey: string,
  warehouseId: string
): Promise<string> {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/warehouses?id=eq.${warehouseId}&select=api_credentials`,
    {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
    }
  );

  const data: any = await response.json();
  if (!data?.[0]?.api_credentials?.accessToken) {
    throw new Error('Failed to get ShipHero token from Supabase');
  }
  return data[0].api_credentials.accessToken;
}
