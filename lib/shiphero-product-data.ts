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
 * Pick the earliest active expiration (and matching lot name) from a list of
 * ShipHero expiration_lots edges. Kits ship soonest-expiring unit first, so the
 * earliest expiry is what FBA must see to enforce FBA_INB_0181 (≥105 days).
 *
 * Returns nulls if no active lot has a valid expires_at.
 */
function pickEarliestActiveLot(
  edges: any[]
): { expirationDate: string | null; lotNumber: string | null } {
  let bestDate: string | null = null;
  let bestName: string | null = null;
  for (const e of edges || []) {
    const node = e?.node;
    if (!node?.is_active || !node?.expires_at) continue;
    if (bestDate === null || node.expires_at < bestDate) {
      bestDate = node.expires_at;
      bestName = node.name || null;
    }
  }
  return { expirationDate: bestDate, lotNumber: bestName };
}

/**
 * Get full product data from ShipHero including case pack and expiration.
 *
 * Kits/bundles (kit: true) do NOT carry their own expiration lots — lots live
 * on the underlying component SKUs. For kits we resolve expiration by querying
 * lots on each component and picking the earliest active expiry across them
 * (the worst case is what governs Amazon's 105-day requirement, since every
 * component travels with the kit). Without this lookup, kit shipments come
 * back with expirationDate=null and the FBA workflow silently fails at the
 * setPackingInformation step — see TR-00146 (2026-06-12).
 */
export async function getShipHeroProductData(
  shipheroToken: string,
  sku: string
): Promise<ProductData> {
  // Pull product details, kit info, and (if non-kit) lots in one round-trip.
  const productQuery = `{
    products(sku: "${sku}") {
      data(first: 1) {
        edges {
          node {
            sku
            name
            kit
            kit_components {
              sku
              quantity
            }
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
      data(first: 10) {
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

  // Parse case pack from product note (kit's own packaging spec — a kit's
  // box dimensions differ from its components, so we always read this from
  // the kit SKU itself, never from a component).
  const casePack = parseCasePackFromNote(product.product_note);

  // Resolve expiration. For kits, lots live on component SKUs; for non-kits,
  // the top-level expiration_lots query already has what we need.
  let expirationDate: string | null = null;
  let lotNumber: string | null = null;

  const isKit = product.kit === true || product.kit === 'true';
  const components: Array<{ sku: string; quantity: number }> =
    Array.isArray(product.kit_components) ? product.kit_components : [];

  if (isKit && components.length > 0) {
    // Query lots for each component and pick the earliest active expiry
    // across the entire kit. This is the worst-case expiry that FBA must
    // honor — every component ships together inside the kit.
    const componentLots: any[] = [];
    for (const comp of components) {
      if (!comp?.sku) continue;
      const compQuery = `{
        expiration_lots(sku: "${comp.sku}") {
          data(first: 10) {
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
      const compResp = await fetch(SHIPHERO_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${shipheroToken}`,
        },
        body: JSON.stringify({ query: compQuery }),
      });
      const compJson: any = await compResp.json();
      if (compJson.errors) {
        throw new Error(
          `ShipHero kit-component lot query error for ${comp.sku}: ${JSON.stringify(compJson.errors)}`
        );
      }
      const compEdges = compJson.data?.expiration_lots?.data?.edges || [];
      const pick = pickEarliestActiveLot(compEdges);
      if (pick.expirationDate) {
        componentLots.push({ component: comp.sku, ...pick });
        // Track running earliest across all components
        if (expirationDate === null || pick.expirationDate < expirationDate) {
          expirationDate = pick.expirationDate;
          lotNumber = pick.lotNumber;
        }
      }
    }
    if (!expirationDate) {
      throw new Error(
        `Kit ${sku} has no active expiration lot on any component (${components
          .map((c) => c.sku)
          .join(', ')}). FBA requires expiration ≥105 days — block the handoff.`
      );
    }
  } else {
    // Non-kit: use lots on the SKU itself.
    const edges = json.data?.expiration_lots?.data?.edges || [];
    const pick = pickEarliestActiveLot(edges);
    expirationDate = pick.expirationDate;
    lotNumber = pick.lotNumber;
  }

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
