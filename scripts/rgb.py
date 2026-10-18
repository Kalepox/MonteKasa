#!/usr/bin/env python3
"""Kasa RGB helper for the kaleido nodes (works around kaleido-cli 0.1.2 bugs).

  python3 scripts/rgb.py status                       # balance + last transfers
  python3 scripts/rgb.py invoice                      # any-asset invoice (first receive)
  python3 scripts/rgb.py invoice --amount 10          # USDT invoice for 10 USDT
  python3 scripts/rgb.py send --amount 5 'rgb:...'    # decode, check asset, send

Add --node http://localhost:3002 to target another node (default 3001).
"""
import argparse, json, sys, time, urllib.error, urllib.request

USDT = "rgb:lX~ToKsO-Iup7dJ5-UM794sA-9WD21ge-VHYzBGb-E9PA_h0"  # KaleidoSwap Mutinynet USDT
PRECISION = 6
PROXY = "rpcs://proxy.kaleidoswap.com/json-rpc"


def post(node, path, body):
    req = urllib.request.Request(node + path, json.dumps(body).encode(), {"Content-Type": "application/json"})
    try:
        return json.load(urllib.request.urlopen(req, timeout=120))
    except urllib.error.HTTPError as e:
        sys.exit(f"{path} failed: {e.code} {e.read().decode()}")


def raw(usdt):
    return round(usdt * 10**PRECISION)


def status(a):
    try:
        post(a.node, "/refreshtransfers", {"filter": [], "skip_sync": False})
        bal = post(a.node, "/assetbalance", {"asset_id": USDT})
        print(f"USDT settled {bal['settled'] / 10**PRECISION}  spendable {bal['spendable'] / 10**PRECISION}")
        ts = post(a.node, "/listtransfers", {"asset_filter": {"type": "Id", "value": USDT}})["transfers"]
        for t in ts[-5:]:
            amt = sum(x.get("value", 0) for x in t["assignments"]) / 10**PRECISION
            print(f"  #{t['idx']} {t['kind']:<13} {t['status']:<20} {amt} {t['txid'] or ''}")
    except SystemExit as e:
        if "Unknown RGB contract" in str(e):
            print("This node has never received USDT yet. Create one with: rgb.py invoice")
        else:
            raise


def invoice(a):
    body = {"min_confirmations": 1, "witness": False, "transport_endpoints": [PROXY],
            "expiration_timestamp": int(time.time()) + 86400}
    if a.amount is not None:
        body |= {"asset_id": USDT, "assignment": {"type": "Fungible", "value": raw(a.amount)}}
    print(post(a.node, "/rgbinvoice", body)["invoice"])


def send(a):
    d = post(a.node, "/decodergbinvoice", {"invoice": a.invoice})
    if not d["recipient_id"].startswith("sbc:"):
        sys.exit(f"Wrong network: {d['recipient_id']} (expected sbc: = Mutinynet)")
    if d.get("asset_id") not in (None, USDT):
        sys.exit(f"Invoice asks for a different asset: {d['asset_id']}\nAsk for an any-asset invoice instead.")
    r = post(a.node, "/sendrgb", {
        "donation": False, "fee_rate": 2, "min_confirmations": 1,
        "expiration_timestamp": int(time.time()) + 86400,
        "recipient_map": {USDT: [{"recipient_id": d["recipient_id"],
                                  "assignment": {"type": "Fungible", "value": raw(a.amount)},
                                  "transport_endpoints": d["transport_endpoints"]}]},
    })
    print(f"Sent {a.amount} USDT, txid {r['txid']}. Run 'status' every ~30 s until Settled.")


p = argparse.ArgumentParser()
p.add_argument("--node", default="http://localhost:3001")
sub = p.add_subparsers(dest="cmd", required=True)
sub.add_parser("status")
pi = sub.add_parser("invoice"); pi.add_argument("--amount", type=float)
ps = sub.add_parser("send"); ps.add_argument("--amount", type=float, required=True); ps.add_argument("invoice")
a = p.parse_args()
{"status": status, "invoice": invoice, "send": send}[a.cmd](a)
