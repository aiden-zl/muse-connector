#!/usr/bin/env python3
"""Keep the applicant's company spreadsheet (the master tracker) and the bridge in agreement.

  tracker.py export   read the sheet -> private/tracker_export.json (companies to exclude, board URLs to source)
  tracker.py sync     write bridge job states back into the sheet (updates rows, appends new companies)
  tracker.py check    skip any queued bridge job at a company the sheet says is Submitted / In flight / Skipped
                      or on the "Skip - Excludes 2029" sheet

Master file: ~/Desktop/company_list_300.xlsx (override with MUSE_TRACKER). Needs openpyxl.
"""
import json, os, re, shutil, sys, urllib.request
from datetime import date
from pathlib import Path

import openpyxl
from openpyxl.worksheet.datavalidation import DataValidation

ROOT = Path(__file__).resolve().parent.parent
MASTER = Path(os.environ.get("MUSE_TRACKER", Path.home() / "Desktop" / "company_list_300.xlsx"))
EXPORT = ROOT / "private" / "tracker_export.json"
CFG = json.loads((Path(os.environ.get("MUSE_BRIDGE_CONFIG", Path.home() / ".config/muse-bridge/config.json"))).read_text())
STATUSES = ["To apply", "Submitted", "In flight", "Skipped"]
RANK = {"Skipped": 0, "To apply": 1, "In flight": 2, "Submitted": 3}
DONE = {"Submitted", "In flight", "Skipped"}
SUFFIX = r"\b(inc|llc|ltd|corp|corporation|co|company|group|holdings|technologies|technology|labs|the|usa|us|careers|jobs)\b"


def norm(s):
    s = re.sub(r"[^a-z0-9 ]", " ", str(s or "").lower().replace("&", " and "))
    return " ".join(re.sub(SUFFIX, " ", s).split())


def names(company):
    """'EA (Electronic Arts)' -> {'ea', 'electronic arts'}"""
    c = str(company or "")
    out = {norm(re.sub(r"\(.*?\)", "", c))}
    out |= {norm(x) for x in re.findall(r"\((.*?)\)", c)}
    return {x for x in out if x}


def api(method, path, body=None):
    req = urllib.request.Request(CFG["url"].rstrip("/") + path, method=method,
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {CFG['admin_token']}", "Content-Type": "application/json", "User-Agent": "muse-bridge-guardian/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def load():
    wb = openpyxl.load_workbook(MASTER)
    ws = wb["Companies"]
    hdr = [c.value for c in ws[1]]
    col = {h: i for i, h in enumerate(hdr)}
    return wb, ws, col


def skip_names(wb):
    out = set()
    if "Skip - Excludes 2029" not in wb.sheetnames:
        return out
    for r in list(wb["Skip - Excludes 2029"].iter_rows(values_only=True))[1:]:
        if not r[0]:
            continue
        cell = str(r[0])
        if "(" in cell and "," in cell:  # e.g. "Defense contractors (RTX, Northrop Grumman, ...)" -> not a hard skip
            continue
        if "," in cell:  # "Meta University, Citadel Launch, ..." are program names, not whole companies
            continue
        if re.search(r"regular internship|program", cell, re.I):  # only one program is excluded, not the company
            continue
        out |= names(cell)
    return out


def excluded(status, notes):
    """Submitted/Skipped always exclude the company; In flight only when the applicant started it (not Muse)."""
    if status in ("Submitted", "Skipped"):
        return True
    return status == "In flight" and "Muse (" not in str(notes or "")


def export():
    wb, ws, col = load()
    excl, urls_excl, urls_src = set(), [], []
    for row in ws.iter_rows(min_row=2, values_only=True):
        if not row[col["Company"]]:
            continue
        status = row[col["Status"]]
        found = re.findall(r"https?://\S+", str(row[col["Notes"]] or ""))
        if excluded(status, row[col["Notes"]]):
            excl |= names(row[col["Company"]])
            urls_excl += found
        else:
            urls_src += found
    data = {"exclude_names": sorted(excl | skip_names(wb)), "exclude_urls": urls_excl, "source_urls": urls_src,
            "master": str(MASTER)}
    EXPORT.parent.mkdir(exist_ok=True)
    EXPORT.write_text(json.dumps(data, indent=1))
    print(json.dumps({"exclude_names": len(data["exclude_names"]), "exclude_urls": len(urls_excl), "source_urls": len(urls_src)}))


def bridge_jobs():
    return api("GET", "/admin/jobs?limit=5000")["jobs"]


def check():
    wb, ws, col = load()
    excl = set(skip_names(wb))
    for row in ws.iter_rows(min_row=2, values_only=True):
        if row[col["Company"]] and excluded(row[col["Status"]], row[col["Notes"]]):
            excl |= names(row[col["Company"]])
    skipped = []
    for j in bridge_jobs():
        if j["status"] in ("pending", "ready") and names(j["company"]) & excl:
            api("PATCH", f"/admin/jobs/{j['id']}", {"status": "skipped", "reason": "tracker: applicant already applied to this company, or it excludes 2029"})
            skipped.append(f"{j['id']} {j['company']} | {j['title']}")
    print(json.dumps({"skipped": skipped}, indent=1))


def bridge_status(j):
    s = j["status"]
    if s == "submitted":
        return "Submitted"
    if s in ("leased", "submitting", "waiting", "needs_human", "possibly_submitted"):
        return "In flight"
    if s in ("pending", "ready"):
        return "To apply"
    return "Skipped"


FIT = {"explicit_2029": "Fits 2029 grad (confirmed)", "range_includes_2029": "Fits 2029 grad (confirmed)",
       "unstated": "Posting seen, grad-year cutoff unchecked"}


def sync():
    if not MASTER.exists():
        sys.exit(f"master tracker not found: {MASTER}")
    shutil.copy2(MASTER, MASTER.with_suffix(".backup.xlsx"))
    wb, ws, col = load()
    index = {}
    for r in range(2, ws.max_row + 1):
        for n in names(ws.cell(r, col["Company"] + 1).value):
            index.setdefault(n, r)
    groups = {}
    for j in bridge_jobs():
        groups.setdefault(norm(j["company"]), []).append(j)
    updated = added = 0
    today = date.today().isoformat()
    for key, jobs in groups.items():
        best = max((bridge_status(j) for j in jobs), key=RANK.get)
        parts = []
        for j in sorted(jobs, key=lambda j: j["id"]):
            label = {"submitted": "submitted", "skipped": "skipped"}.get(j["status"], j["status"])
            why = f" ({j['status_reason'][:60]})" if j["status"] == "skipped" and j.get("status_reason") else ""
            parts.append(f"{j['title']} [{label}{why}] {j['url']}")
        muse_note = f"Muse ({today}): " + " | ".join(parts)
        live = [j for j in jobs if j["status"] != "skipped"] or jobs
        fit = next((FIT[j.get("eligibility")] for j in live if j.get("eligibility") in ("explicit_2029", "range_includes_2029")), None) \
            or "Posting seen, grad-year cutoff unchecked"
        if best == "Skipped":
            fit = "Posting seen, grad-year cutoff unchecked"
        r = next((index[n] for n in names(jobs[0]["company"]) if n in index), None)
        if r:
            cur = ws.cell(r, col["Status"] + 1).value
            if cur not in DONE or RANK[best] > RANK.get(cur, 0):
                ws.cell(r, col["Status"] + 1).value = best
            notes = str(ws.cell(r, col["Notes"] + 1).value or "")
            notes = re.sub(r"\s*\|\|\s*Muse \(\d{4}-\d\d-\d\d\):.*$", "", notes)
            notes = re.sub(r"^Muse \(\d{4}-\d\d-\d\d\):.*$", "", notes)
            ws.cell(r, col["Notes"] + 1).value = (notes + " || " if notes else "") + muse_note
            if ws.cell(r, col["2029-grad fit"] + 1).value in ("Not checked", None) and fit:
                ws.cell(r, col["2029-grad fit"] + 1).value = fit
            updated += 1
        else:
            r = ws.max_row + 1
            vals = {"#": r - 1, "Company": jobs[0]["company"], "Tier": "Unrated", "HQ": "Unknown", "Status": best,
                    "2029-grad fit": fit, "Notes": muse_note, "Live posting (Simplify list, Nov 9)": "Yes (from bridge)"}
            for h, i in col.items():
                src = ws.cell(r - 1, i + 1)
                c = ws.cell(r, i + 1, vals.get(h))
                if src.has_style:
                    c._style = src._style
            for n in names(jobs[0]["company"]):
                index[n] = r
            added += 1
    last = ws.max_row
    # keep summary formulas, filter and status dropdown covering the new rows
    s = wb["Summary"]
    for row in s.iter_rows():
        for c in row:
            if isinstance(c.value, str) and c.value.startswith("="):
                c.value = re.sub(r"(Companies!\$[A-Z]\$2:\$[A-Z]\$)\d+", lambda m: f"{m.group(1)}{max(last, 5000)}", c.value)
    ws.auto_filter.ref = f"A1:{openpyxl.utils.get_column_letter(ws.max_column)}{last}"
    ws.data_validations.dataValidation = []
    dv = DataValidation(type="list", formula1='"' + ",".join(STATUSES) + '"', allow_blank=True)
    dv.add(f"E2:E{max(last, 5000)}")
    ws.add_data_validation(dv)
    wb.save(MASTER)
    print(json.dumps({"master": str(MASTER), "companies_updated": updated, "companies_added": added, "rows": last - 1}))


if __name__ == "__main__":
    {"export": export, "sync": sync, "check": check}.get(sys.argv[1] if len(sys.argv) > 1 else "", lambda: sys.exit(__doc__))()
