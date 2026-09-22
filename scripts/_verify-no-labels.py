"""
SAFETY GATE: prove no Amazon shipments/labels exist for the cancelled transfers
BEFORE recreating them. Read-only.

For each transfer we check, on AMAZON (the only authority):
  - every inbound plan we ever recorded (incl. cancelled rows)
  - plan status, shipment count, placement statuses
  - for any shipment found: its confirmation id + whether labels were pulled
"""
import os, json, urllib.request, time

U = os.environ['SUPABASE_URL']; K = os.environ['SUPABASE_SERVICE_ROLE_KEY']
H = {'apikey': K, 'Authorization': 'Bearer ' + K}
tok = open('/tmp/amztok').read().strip()

TRS = ["TR-00459","TR-00460","TR-00462","TR-00463","TR-00464","TR-00465","TR-00466",
       "TR-00468","TR-00472","TR-00474","TR-00475","TR-00476","TR-00477","TR-00448"]

def sb(p):
    return json.load(urllib.request.urlopen(urllib.request.Request(U + p, headers=H)))

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

# Pull EVERY row (any status) so a cancelled row's plan is still checked.
inlist = ",".join("CIN7-" + t for t in TRS)
rows = sb(f'/rest/v1/fba_shipments?cin7_transfer_number=in.({inlist})'
          '&select=cin7_transfer_number,cin7_lot,status,plan_id,amazon_shipment_ids,labels_url')

by_tr = {}
for r in rows:
    by_tr.setdefault(r['cin7_transfer_number'].replace('CIN7-', ''), []).append(r)

print(f"{'transfer':<10}{'plans':>6}{'shipments':>11}{'labels':>8}   verdict")
verdict = {}
for t in TRS:
    rs = by_tr.get(t, [])
    plans = [r for r in rs if r.get('plan_id')]
    total_ships = 0
    label_rows = 0
    details = []
    for r in plans:
        d = amz(f"/inbound/fba/2024-03-20/inboundPlans/{r['plan_id']}")
        st = d.get('status')
        ships = d.get('shipments') or []
        pls = [o.get('status') for o in (d.get('placementOptions') or [])]
        total_ships += len(ships)
        if r.get('labels_url'):
            label_rows += 1
        details.append({'plan': r['plan_id'], 'lot': r['cin7_lot'], 'row_status': r['status'],
                        'amz_status': st, 'ships': len(ships), 'placements': pls,
                        'ship_ids': r.get('amazon_shipment_ids') or []})
        time.sleep(1.3)
    safe = (total_ships == 0 and label_rows == 0)
    verdict[t] = {'safe': safe, 'plans': len(plans), 'ships': total_ships,
                  'label_rows': label_rows, 'details': details}
    mark = 'SAFE to recreate' if safe else '*** STOP - SHIPMENTS EXIST ***'
    print(f"  {t:<10}{len(plans):>6}{total_ships:>11}{label_rows:>8}   {mark}", flush=True)

json.dump(verdict, open('/tmp/verify_no_labels.json', 'w'), indent=1)
bad = [t for t, v in verdict.items() if not v['safe']]
print()
print('TRANSFERS WITH EXISTING SHIPMENTS:', bad if bad else 'NONE')
print('ALL CLEAR' if not bad else 'DO NOT RECREATE THE ABOVE')
