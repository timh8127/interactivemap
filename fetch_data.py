#!/usr/bin/env python3
"""
fetch_data.py -- Build peaks.json for the Bellinzona-Locarno drone-planning map.

This is the ONLY place peak/lift/airspace data is derived. It pulls everything
LIVE from real sources -- nothing here is hardcoded from memory:

  STEP 1  natural=peak nodes  + aerialway lifts        -> OpenStreetMap Overpass API
  STEP 1b lift upper-terminal elevation                -> swisstopo geo.admin height API
  STEP 2  BAZL drone airspace restrictions             -> api3.geo.admin.ch identify
  STEP 2.5 local/operator restrictions (manual join)   -> data/local_restrictions.json

Run it in an environment WITH outbound internet access:

    python3 fetch_data.py

Outputs:
    data/peaks.json     consumed by the static map
    data-issues.md      every ambiguous / unconfirmed record, for spot-checking

Design rules baked in (do not "improve" these away):
  * A lift is only "confirmed" on a peak when it is <=400 m horizontally AND
    <=100 m in elevation. Anything weaker is "unconfirmed" -- never a yes.
  * BAZL federal airspace status and local/operator status are kept as two
    SEPARATE fields. They are different legal bases and must never be merged.
  * On any lookup failure or silence we degrade to unconfirmed / unknown / error,
    never to "clear" or "allowed".
"""

import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
import urllib.error
from datetime import datetime, timezone

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

# bbox as (south, west, north, east) -- Overpass order.
BBOX = (46.05, 8.65, 46.30, 9.05)

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")
PEAKS_OUT = os.path.join(DATA_DIR, "peaks.json")
ISSUES_OUT = os.path.join(HERE, "data-issues.md")
LOCAL_RESTRICTIONS = os.path.join(DATA_DIR, "local_restrictions.json")

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter",
]
GEOADMIN_IDENTIFY = "https://api3.geo.admin.ch/rest/services/api/MapServer/identify"
GEOADMIN_HEIGHT = "https://api3.geo.admin.ch/rest/services/height"
BAZL_LAYER = "ch.bazl.einschraenkungen-drohnen"

# Matching tolerances (STEP 1).
MATCH_HORIZONTAL_M = 400.0
MATCH_ELEVATION_M = 100.0

# BAZL buffer ring (STEP 2): sample the point plus a ring so a bare point
# cannot miss a zone edge.
BAZL_RING_RADIUS_M = 350.0
BAZL_RING_POINTS = 8

USER_AGENT = "bellinzona-locarno-peaks-map/1.0 (drone planning aid; contact: repo owner)"
HTTP_TIMEOUT = 90
HTTP_RETRIES = 4

# collected as we go, written to data-issues.md
ISSUES = []


def note_issue(peak_name, category, detail):
    ISSUES.append({"peak": peak_name, "category": category, "detail": detail})


# --------------------------------------------------------------------------
# HTTP helpers
# --------------------------------------------------------------------------

def _http(url, data=None, headers=None):
    """One HTTP attempt. `data` (bytes) triggers POST."""
    req = urllib.request.Request(url, data=data, headers=headers or {})
    req.add_header("User-Agent", USER_AGENT)
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
        return resp.read().decode("utf-8", errors="replace")


def http_json(url, data=None, headers=None, label="request", retries=HTTP_RETRIES):
    """HTTP with retry + exponential backoff. Returns parsed JSON or raises.

    4xx client errors (except 429 rate-limit) are deterministic, so we fail
    fast on them instead of wasting the backoff schedule -- retrying a bad
    request just reproduces the same 400."""
    last_err = None
    for attempt in range(retries):
        try:
            body = _http(url, data=data, headers=headers)
            return json.loads(body)
        except urllib.error.HTTPError as e:
            last_err = e
            if 400 <= e.code < 500 and e.code != 429:
                raise RuntimeError(f"{label} failed: HTTP {e.code} {e.reason} "
                                   "(client error, not retried)") from e
            wait = 2 ** (attempt + 1)
            sys.stderr.write(
                f"  [{label}] attempt {attempt + 1}/{retries} failed: {e}; "
                f"retrying in {wait}s\n")
            time.sleep(wait)
        except (urllib.error.URLError, ValueError) as e:
            last_err = e
            wait = 2 ** (attempt + 1)
            sys.stderr.write(
                f"  [{label}] attempt {attempt + 1}/{retries} failed: {e}; "
                f"retrying in {wait}s\n")
            time.sleep(wait)
    raise RuntimeError(f"{label} failed after {retries} attempts: {last_err}")


# --------------------------------------------------------------------------
# Geometry
# --------------------------------------------------------------------------

def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def ring_points(lat, lon, radius_m, n):
    """n points on a circle of radius_m around (lat, lon)."""
    out = []
    for i in range(n):
        ang = 2 * math.pi * i / n
        dlat = (radius_m * math.cos(ang)) / 111320.0
        dlon = (radius_m * math.sin(ang)) / (111320.0 * math.cos(math.radians(lat)))
        out.append((lat + dlat, lon + dlon))
    return out


# --------------------------------------------------------------------------
# STEP 1 -- Overpass: peaks + lifts
# --------------------------------------------------------------------------

def overpass(query):
    last_err = None
    for endpoint in OVERPASS_ENDPOINTS:
        try:
            data = urllib.parse.urlencode({"data": query}).encode("utf-8")
            return http_json(
                endpoint, data=data,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                label=f"overpass:{endpoint}",
            )
        except Exception as e:  # noqa: BLE401 -- try next mirror
            last_err = e
            sys.stderr.write(f"  overpass mirror {endpoint} failed: {e}\n")
    raise RuntimeError(f"all Overpass mirrors failed: {last_err}")


def fetch_peaks():
    s, w, n, e = BBOX
    q = (
        "[out:json][timeout:120];"
        f'node["natural"="peak"]({s},{w},{n},{e});'
        "out body;"
    )
    print("STEP 1: querying Overpass for natural=peak ...")
    res = overpass(q)
    peaks = []
    for el in res.get("elements", []):
        if el.get("type") != "node":
            continue
        tags = el.get("tags", {})
        name = tags.get("name")
        ele_raw = tags.get("ele")
        ele = None
        if ele_raw is not None:
            try:
                ele = float(str(ele_raw).replace(",", ".").split()[0])
            except (ValueError, IndexError):
                ele = None
        peak = {
            "osm_id": el["id"],
            "name": name,
            "lat": el["lat"],
            "lon": el["lon"],
            "ele": ele,
        }
        if not name:
            note_issue(f"osm/node/{el['id']}", "peak-missing-name",
                       "natural=peak node has no name tag; skipped from map "
                       "(cannot label). Coordinate: "
                       f"{el['lat']},{el['lon']}")
            continue
        if ele is None:
            note_issue(name, "peak-missing-ele",
                       "peak has no usable ele tag; elevation-based lift "
                       "matching cannot be verified for it.")
        peaks.append(peak)
    print(f"  found {len(peaks)} named peaks")
    return peaks


def fetch_lifts():
    s, w, n, e = BBOX
    q = (
        "[out:json][timeout:120];"
        "("
        f'  way["aerialway"~"cable_car|gondola|chair_lift"]({s},{w},{n},{e});'
        f'  relation["aerialway"~"cable_car|gondola|chair_lift"]({s},{w},{n},{e});'
        ");"
        "out body geom;"
    )
    print("STEP 1: querying Overpass for aerialway lifts ...")
    res = overpass(q)
    lifts = []
    for el in res.get("elements", []):
        geom = el.get("geometry")
        tags = el.get("tags", {})
        if not geom:
            # relations may need member geometry; note and skip cleanly
            if el.get("type") == "relation":
                note_issue(tags.get("name", f"osm/relation/{el.get('id')}"),
                           "lift-no-geometry",
                           "aerialway relation returned without geometry; "
                           "terminal could not be determined.")
            continue
        endpoints = [(geom[0]["lat"], geom[0]["lon"]),
                     (geom[-1]["lat"], geom[-1]["lon"])]
        lifts.append({
            "osm_id": el["id"],
            "osm_type": el["type"],
            "name": tags.get("name"),
            "aerialway": tags.get("aerialway"),
            "endpoints": endpoints,
        })
    print(f"  found {len(lifts)} lifts (cable_car/gondola/chair_lift)")
    return lifts


# --------------------------------------------------------------------------
# STEP 1b -- terminal elevation via swisstopo height API
# --------------------------------------------------------------------------

def wgs84_to_lv95(lat, lon):
    """swisstopo approximate transform WGS84 -> LV95 (EPSG:2056), ~1 m accuracy.
    The height service only accepts Swiss projected coordinates, so we must
    project lon/lat before querying it (passing raw WGS84 returns HTTP 400)."""
    phi = (lat * 3600.0 - 169028.66) / 10000.0   # latitude in the auxiliary unit
    lam = (lon * 3600.0 - 26782.5) / 10000.0     # longitude in the auxiliary unit
    e = (2600072.37
         + 211455.93 * lam
         - 10938.51 * lam * phi
         - 0.36 * lam * phi ** 2
         - 44.54 * lam ** 3)
    n = (1200147.07
         + 308807.95 * phi
         + 3745.25 * lam ** 2
         + 76.63 * phi ** 2
         - 194.56 * lam ** 2 * phi
         + 119.79 * phi ** 3)
    return e, n


def terminal_elevation(lat, lon):
    """Return elevation (m) at a point from the swisstopo height service, or None.
    Best-effort: on any failure we return None and the caller degrades the lift
    match to 'unconfirmed' rather than guessing."""
    e, n = wgs84_to_lv95(lat, lon)
    url = GEOADMIN_HEIGHT + "?" + urllib.parse.urlencode({
        "easting": round(e, 2), "northing": round(n, 2),
    })
    try:
        res = http_json(url, label="height", retries=2)
        h = res.get("height")
        return float(h) if h is not None else None
    except Exception as ex:  # noqa: BLE401
        sys.stderr.write(f"  height lookup failed at {lat},{lon}: {ex}\n")
        return None


# --------------------------------------------------------------------------
# STEP 1 -- match lifts to peaks
# --------------------------------------------------------------------------

def match_lifts(peaks, lifts):
    """Assign each peak a gondola status from the best matching lift terminal."""
    print("STEP 1: matching lift upper terminals to peaks ...")
    for p in peaks:
        p["gondola"] = {"status": "none", "lift_name": None, "lift_type": None,
                        "distance_m": None, "ele_diff_m": None, "terminal": None}

    for lift in lifts:
        # Evaluate BOTH endpoints; the "upper terminal" is whichever endpoint
        # produces the strongest match to a nearby peak.
        best = None  # (rank, distance, peak, terminal, term_ele, ele_diff)
        for term in lift["endpoints"]:
            tlat, tlon = term
            # nearest peak to this terminal
            near = min(peaks, key=lambda pk: haversine_m(tlat, tlon, pk["lat"], pk["lon"]),
                       default=None)
            if near is None:
                continue
            dist = haversine_m(tlat, tlon, near["lat"], near["lon"])
            if dist > MATCH_HORIZONTAL_M:
                continue
            term_ele = terminal_elevation(tlat, tlon)
            ele_diff = None
            if term_ele is not None and near["ele"] is not None:
                ele_diff = abs(term_ele - near["ele"])
            # rank: 0 = confirmed (both criteria), 1 = unconfirmed
            if ele_diff is not None and ele_diff <= MATCH_ELEVATION_M:
                rank = 0
            else:
                rank = 1
            cand = (rank, dist, near, term, term_ele, ele_diff)
            if best is None or (cand[0], cand[1]) < (best[0], best[1]):
                best = cand

        if best is None:
            continue
        rank, dist, peak, term, term_ele, ele_diff = best
        status = "confirmed" if rank == 0 else "unconfirmed"
        # keep the strongest lift already recorded on this peak
        prev = peak["gondola"]["status"]
        prev_rank = {"confirmed": 0, "unconfirmed": 1, "none": 2}[prev]
        if rank < prev_rank:
            peak["gondola"] = {
                "status": status,
                "lift_name": lift["name"],
                "lift_type": lift["aerialway"],
                "distance_m": round(dist, 1),
                "ele_diff_m": round(ele_diff, 1) if ele_diff is not None else None,
                "terminal": [round(term[0], 6), round(term[1], 6)],
                "lift_osm": f"{lift['osm_type']}/{lift['osm_id']}",
            }
        if status == "unconfirmed":
            reason = ("terminal within %sm horizontally but " % round(dist)) + (
                "elevation difference %sm exceeds %sm" % (round(ele_diff), MATCH_ELEVATION_M)
                if ele_diff is not None
                else "terminal or peak elevation unavailable, so the 100m "
                     "elevation check could not be applied")
            note_issue(peak["name"], "gondola-unconfirmed",
                       f"lift {lift['name'] or lift['aerialway']} "
                       f"({lift['osm_type']}/{lift['osm_id']}): {reason}. Marked "
                       "unconfirmed rather than guessed.")


# --------------------------------------------------------------------------
# STEP 2 -- BAZL drone airspace restrictions
# --------------------------------------------------------------------------

def classify_restriction(text):
    """Best-effort blanket-ban vs authorization-required from returned text.
    Falls back to 'see_source' rather than guessing."""
    if not text:
        return "see_source"
    t = text.lower()
    if any(k in t for k in ["verboten", "verbot", "interdit", "prohibited", "no drone", "ban"]):
        return "blanket_ban"
    if any(k in t for k in ["bewilligung", "autorisation", "authoriz", "authoris", "permit", "genehmigung"]):
        return "authorization_required"
    return "see_source"


def identify_bazl(lat, lon):
    """One identify call at a point. Returns list of raw feature attribute dicts."""
    s, w, n, e = BBOX
    params = {
        "geometryType": "esriGeometryPoint",
        "geometry": f"{lon},{lat}",
        "sr": 4326,
        "layers": f"all:{BAZL_LAYER}",
        "tolerance": 5,
        "mapExtent": f"{w},{s},{e},{n}",
        "imageDisplay": "1000,1000,96",
        "returnGeometry": "false",
        "lang": "en",
    }
    url = GEOADMIN_IDENTIFY + "?" + urllib.parse.urlencode(params)
    res = http_json(url, label="bazl-identify")
    out = []
    for feat in res.get("results", []):
        out.append(feat.get("attributes", {}) or feat.get("properties", {}) or {})
    return out


def fetch_bazl_for_peak(peak):
    """Query the BAZL layer at the peak plus a buffer ring; aggregate zones."""
    fetched = datetime.now(timezone.utc).isoformat(timespec="seconds")
    sample_points = [(peak["lat"], peak["lon"])] + ring_points(
        peak["lat"], peak["lon"], BAZL_RING_RADIUS_M, BAZL_RING_POINTS)
    zones = {}
    errors = 0
    for (plat, plon) in sample_points:
        try:
            for attrs in identify_bazl(plat, plon):
                # Build a human label + stable key from whatever fields exist.
                label = (attrs.get("name") or attrs.get("label")
                         or attrs.get("bezeichnung") or attrs.get("description")
                         or attrs.get("beschreibung") or "")
                key = attrs.get("id") or attrs.get("featureId") or label or json.dumps(attrs, sort_keys=True)
                blob = " ".join(str(v) for v in attrs.values())
                zones[key] = {
                    "name": label or "(unnamed BAZL zone)",
                    "type": classify_restriction(blob),
                    "raw": attrs,
                }
        except Exception as e:  # noqa: BLE401
            errors += 1
            sys.stderr.write(f"  BAZL identify failed near {peak['name']} "
                             f"at {plat},{plon}: {e}\n")

    if errors and not zones:
        peak["bazl"] = {"status": "error", "zones": [], "fetched_utc": fetched,
                        "queried_points": len(sample_points), "errors": errors}
        note_issue(peak["name"], "bazl-error",
                   f"all {errors} BAZL identify calls failed; airspace status "
                   "could not be determined (shown as error, not clear).")
        return

    zone_list = list(zones.values())
    if zone_list:
        status = "restricted"
    else:
        status = "clear"  # no zone returned = no restriction IN THIS LAYER only
    peak["bazl"] = {
        "status": status,
        "zones": zone_list,
        "fetched_utc": fetched,
        "queried_points": len(sample_points),
        "errors": errors,
    }
    if any(z["type"] == "see_source" for z in zone_list):
        note_issue(peak["name"], "bazl-unclassified",
                   "a BAZL zone was returned but its ban/authorization type "
                   "could not be classified from the attributes; see raw data "
                   "and verify on geo.admin.ch.")


# --------------------------------------------------------------------------
# STEP 2.5 -- local / operator restrictions (manual data, joined here)
# --------------------------------------------------------------------------

def load_local_restrictions():
    if not os.path.exists(LOCAL_RESTRICTIONS):
        return []
    with open(LOCAL_RESTRICTIONS, encoding="utf-8") as f:
        return json.load(f).get("entries", [])


def apply_local_restrictions(peaks, entries):
    print("STEP 2.5: joining manual local/operator restrictions ...")
    by_name = {}
    by_osm = {}
    for ent in entries:
        m = ent.get("match", {})
        if m.get("name"):
            by_name[m["name"].strip().lower()] = ent
        if m.get("osm_id"):
            by_osm[int(m["osm_id"])] = ent
    for p in peaks:
        ent = by_osm.get(p["osm_id"]) or by_name.get((p["name"] or "").strip().lower())
        if ent:
            p["local_restriction"] = {
                "status": ent.get("status", "unknown"),
                "source_url": ent.get("source_url"),
                "note": ent.get("note"),
                "checked_date": ent.get("checked_date"),
            }
        else:
            p["local_restriction"] = {
                "status": "unknown", "source_url": None,
                "note": "No operator/cantonal drone policy researched for this "
                        "peak yet. Defaults to unknown (never 'allowed').",
                "checked_date": None,
            }
        if p["local_restriction"]["status"] == "unknown":
            note_issue(p["name"], "local-unknown",
                       "local/operator drone policy not confirmed; defaulted to "
                       "unknown. Check the cable-car/tourism operator directly.")


# --------------------------------------------------------------------------
# geo.admin deep link for manual verification
# --------------------------------------------------------------------------

def geoadmin_url(lat, lon):
    # map.geo.admin.ch accepts lon/lat via the mapcrs=4326 + E/N-free crosshair query.
    params = {
        "lang": "en",
        "layers": BAZL_LAYER,
        "zoom": 9,
        "crosshair": "marker",
        "swisssearch": f"{lat},{lon}",
    }
    return "https://map.geo.admin.ch/?" + urllib.parse.urlencode(params)


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def main():
    os.makedirs(DATA_DIR, exist_ok=True)

    peaks = fetch_peaks()
    lifts = fetch_lifts()
    match_lifts(peaks, lifts)

    print(f"STEP 2: BAZL airspace identify for {len(peaks)} peaks "
          f"(point + {BAZL_RING_POINTS}-point ring) ...")
    for i, p in enumerate(peaks, 1):
        print(f"  [{i}/{len(peaks)}] {p['name']}")
        fetch_bazl_for_peak(p)
        p["geoadmin_url"] = geoadmin_url(p["lat"], p["lon"])

    apply_local_restrictions(peaks, load_local_restrictions())

    peaks.sort(key=lambda pk: (-(pk["ele"] or 0), pk["name"]))

    out = {
        "_meta": {
            "generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "bbox_south_west_north_east": list(BBOX),
            "status": "OK",
            "sources": {
                "peaks_and_lifts": "OpenStreetMap Overpass API (natural=peak, aerialway=cable_car|gondola|chair_lift)",
                "terminal_elevation": "swisstopo geo.admin height API",
                "airspace": f"api3.geo.admin.ch identify, layer {BAZL_LAYER}",
                "local_restrictions": "manual (data/local_restrictions.json)",
            },
            "match_tolerances": {"horizontal_m": MATCH_HORIZONTAL_M,
                                 "elevation_m": MATCH_ELEVATION_M},
            "counts": {
                "peaks": len(peaks),
                "lifts": len(lifts),
                "gondola_confirmed": sum(1 for p in peaks if p["gondola"]["status"] == "confirmed"),
                "gondola_unconfirmed": sum(1 for p in peaks if p["gondola"]["status"] == "unconfirmed"),
                "bazl_restricted": sum(1 for p in peaks if p["bazl"]["status"] == "restricted"),
                "bazl_error": sum(1 for p in peaks if p["bazl"]["status"] == "error"),
            },
            "disclaimer": ("Planning aid only. The BAZL layer does NOT include "
                           "DABS daily/NOTAM restrictions. Verify against DABS "
                           "and the local operator before any flight."),
        },
        "peaks": peaks,
    }
    with open(PEAKS_OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"\nwrote {PEAKS_OUT} ({len(peaks)} peaks)")

    write_issues(out["_meta"])
    print(f"wrote {ISSUES_OUT} ({len(ISSUES)} issues)")


def write_issues(meta):
    lines = []
    lines.append("# Data issues — spot-check before trusting the map\n")
    lines.append(f"_Generated {meta['generated_utc']} from live sources._\n")
    lines.append("Every record below was **ambiguous or unconfirmed** during the "
                 "fetch. Nothing here is presented as flight-cleared. Verify each "
                 "against [DABS](https://dabs.bazl.admin.ch/) and the local "
                 "operator before flying.\n")
    if not ISSUES:
        lines.append("\n_No issues recorded in this run — but still verify "
                     "independently before flying._\n")
    else:
        by_cat = {}
        for it in ISSUES:
            by_cat.setdefault(it["category"], []).append(it)
        titles = {
            "peak-missing-name": "Peaks skipped (no name tag)",
            "peak-missing-ele": "Peaks with no elevation (lift ele-check impossible)",
            "gondola-unconfirmed": "Gondola matches left UNCONFIRMED",
            "lift-no-geometry": "Lifts with no usable geometry",
            "bazl-error": "BAZL airspace lookup FAILED",
            "bazl-unclassified": "BAZL zone type could not be classified",
            "local-unknown": "Local / operator policy UNKNOWN (default)",
        }
        for cat, items in by_cat.items():
            lines.append(f"\n## {titles.get(cat, cat)} ({len(items)})\n")
            for it in items:
                lines.append(f"- **{it['peak']}** — {it['detail']}")
    with open(ISSUES_OUT, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
