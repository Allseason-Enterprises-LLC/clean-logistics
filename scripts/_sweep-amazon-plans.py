"""
GATE 3 — the independent check.

Gate 2 only inspected plans we have in fba_shipments. If a run created a plan on
Amazon but died before persisting the row, that plan is INVISIBLE to us and is a
real duplicate risk. So: list ALL recent inbound plans straight from Amazon and
match them to our transfers by the SKUs/MSKUs they contain.
"""
import os, json, urllib.request, time

tok = open('/tmp/amztok').read().strip()
U = os.environ['SUPABASE_URL']; K = os.environ['SUPABASE_SERVICE_ROLE_KEY']
H = {'apikey': K, 'Authorization': 'Bearer ' + K}

def amz(p):
    r = urllib.request.Request('https://sellingpartnerapi-na.amazon.com' + p,
                               headers={'x-amz-access-token': tok})
    try:
        return json.load(urllib.request.urlopen(r))
    except Exception as e:
        try:
            return json.loads(e.read())
        except Exception as e2:
            return {'_err': str(e2)}

def sb(p):
    return json.load(urllib.request.urlopen(urllib.request.Request(U + p, headers=H)))

TRS = ["TR-00459","TR-00460","TR-00462","TR-00463","TR-00464","TR-00465","TR-00466",
       "TR-00468","TR-00472","TR-00474","TR-00475","TR-00476","TR-00477","TR-00448"]

# CIN7 sku per transfer (from the bridge payload)
skus = {}
for t in TRS:
    br = sb(f'/rest/v1/cin7_transfer_shiphero_orders?cin7_transfer_number=eq.{t}&select=request_payload')
    pl = (br[0].get('request_payload') or {}) if br else {}
    li = pl.get('partnerLineItems') or pl.get('items') or []
    skus[t] = sorted({x.get('sku') for x in li if x.get('sku')})

# map CIN7 sku -> amazon MSKUs
msk = {}
for r in sb('/rest/v1/sku_master?select=cin7_sku,amazon_seller_sku'):
    if r.get('cin7_sku') and r.get('amazon_seller_sku'):
        msk.setdefault(r['cin7_sku'], set()).add(r['amazon_seller_sku'])

watch = {}
for t in TRS:
    for s in skus[t]:
        for m in msk.get(s, {s}):
            watch.setdefault(m, set()).add(t)
print('watching', len(watch), 'MSKUs for', len(TRS), 'transfers')

# Page through ALL recent plans on Amazon
plans = []
tokn = None
for page in range(12):
    q = '/inbound/fba/2024-03-20/inboundPlans?pageSize=30'
    if tokn:
        q += '&paginationToken=' + urllib.parse.quote(tokn)
    d = amz(q)
    got = d.get('inboundPlans') or []
    plans.extend(got)
    tokn = (d.get('pagination') or {}).get('nextToken')
    print(f'  page {page+1}: +{len(got)} (total {len(plans)})', flush=True)
    if not tokn or not got:
        break
    time.sleep(1.4)

known = {r['plan_id'] for r in sb('/rest/v1/fba_shipments?select=plan_id&plan_id=not.is.null')}
print(f'\n{len(plans)} plans on Amazon; {len(known)} plan ids known to us')

suspect = []
for p in plans:
    pid = p.get('inboundPlanId')
    st = p.get('status')
    if st in ('VOIDED', 'CANCELLED'):
        continue
    if pid in known:
        continue
    # unknown, live plan -> inspect its items
    items = amz(f'/inbound/fba/2024-03-20/inboundPlans/{pid}/items?pageSize=30')
    mskus = {i.get('msku') for i in (items.get('items') or [])}
    hit = sorted({t for m in mskus if m in watch for t in watch[m]})
    if hit:
        d = amz(f'/inbound/fba/2024-03-20/inboundPlans/{pid}')
        suspect.append({'plan': pid, 'status': st, 'mskus': sorted(m for m in mskus if m),
                        'ships': len(d.get('shipments') or []), 'transfers': hit,
                        'name': p.get('name')})
        print(f'  !! UNKNOWN LIVE PLAN {pid} status={st} ships={len(d.get("shipments") or [])} '
              f'mskus={sorted(m for m in mskus if m)} -> {hit}', flush=True)
    time.sleep(1.3)

json.dump(suspect, open('/tmp/orphan_plans.json', 'w'), indent=1)
print()
if suspect:
    print(f'*** {len(suspect)} UNTRACKED PLAN(S) TOUCHING OUR SKUS - REVIEW BEFORE RECREATING ***')
else:
    print('NO untracked live plans touching these SKUs. Recreation is safe.')
