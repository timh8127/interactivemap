# Ticino Peaks — drone-flight planning aid

Interactive Leaflet map of mountain peaks in the **Canton of Ticino**,
Switzerland. Peaks and lifts are clipped to the real cantonal administrative
boundary (not a rectangle), so neighbouring Italian / Graubünden / Valais
summits are excluded.

> Scope is configurable: `python3 fetch_data.py` covers the whole canton by
> default; `SCOPE=bbox python3 fetch_data.py` restricts to the original
> Bellinzona–Locarno rectangle (`46.05,8.65` → `46.30,9.05`).

**This is a planning aid, not a flight clearance.** Every peak shows three
*independent* signals that are deliberately never merged into one verdict:

| Badge | Signal | Source |
|-------|--------|--------|
| **G** | Gondola/lift match confidence | OpenStreetMap (Overpass) |
| **A** | BAZL federal drone-airspace status | `api3.geo.admin.ch` layer `ch.bazl.einschraenkungen-drohnen` |
| **L** | Local / cable-car-operator / cantonal status | manual research (`data/local_restrictions.json`) |

A peak can be **airspace-clear (A)** and still **operator-banned (L)** — the two
are different legal bases. Always verify against
[DABS](https://dabs.bazl.admin.ch/) (daily/NOTAM restrictions, **not** in the
static layer) and the operator directly before flying.

## How the data is produced

Nothing is hardcoded from memory. All peak/lift/airspace data is derived live by
`fetch_data.py`:

1. **Peaks + lifts** — Overpass API: `natural=peak` nodes (with `ele`+`name`) and
   `aerialway=cable_car|gondola|chair_lift` ways/relations in the bbox.
2. **Lift → peak matching** — each lift's upper terminal is matched to the nearest
   peak within **400 m horizontal AND 100 m elevation** (terminal elevation from
   the swisstopo height API). Weaker matches are marked **unconfirmed** — never a
   guessed yes.
3. **BAZL airspace** — the zone polygons are fetched **once** for the whole scope
   (tiled `identify` with `returnGeometry`), then each peak is tested locally by
   point-in-polygon, sampling the peak **plus an 8-point ~350 m buffer ring** so a
   bare point can't miss a zone edge. This keeps a canton-wide run to a few dozen
   HTTP calls instead of thousands. If the bulk fetch fails, it falls back to the
   original per-point `identify` (`esriGeometryPoint`) automatically. Records zone
   name, ban-vs-authorization type, and fetch timestamp.
4. **Local restrictions** — manual, from `data/local_restrictions.json`; defaults
   to `unknown` on silence, never `allowed`.

Outputs: `data/peaks.json` (consumed by the map) and `data-issues.md` (everything
ambiguous/unconfirmed, for spot-checking).

### Run the fetch (needs internet access)

```bash
python3 fetch_data.py     # stdlib only, no pip installs
```

The site ships with `data/peaks.json` in `status: "NOT_FETCHED"` and shows no
markers until you run this — so nothing fabricated is ever displayed.

> Note: this repository was built in a sandbox whose network policy blocked
> `overpass-api.de` and `api3.geo.admin.ch`, so the live fetch has **not** been
> run here. Run it in an environment with outbound internet to populate the map.

## Using the map

- **Search** — type a peak name in the top-bar box; pick a result to fly there and
  open its popup.
- **Three badges per peak** — G (gondola), A (BAZL airspace), L (local/operator),
  shown separately and never merged.
- **Admin edit view** — click **Admin** to edit any peak's gondola status, local /
  operator status, source URL and notes. Edits are saved in your browser
  (`localStorage`) and marked with an orange "edited" outline. Click **Export** to
  download `overrides.json`; commit it as `data/overrides.json` and everyone sees
  the corrections. Overrides are a **separate layer** applied on top of the fetched
  data, so manual edits never overwrite the live-derived values, and a re-fetch
  keeps them. Example use: San Salvatore's lift is a funicular the base map draws
  but the matcher may miss — set its gondola status by hand here.

## Local preview

```bash
python3 -m http.server 8000    # then open http://localhost:8000
```

The map (Leaflet, vendored under `assets/leaflet/`, no CDN dependency) loads
OpenStreetMap tiles client-side — no API key required.

## Deploy (Netlify)

`netlify.toml` sets `publish = "."` with no build command. After a one-time
`netlify init` (which needs a manual browser OAuth step for first-time site
creation), every push to the production branch auto-deploys.
