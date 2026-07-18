/* Bellinzona–Locarno peaks — drone planning aid.
   Renders data/peaks.json produced by fetch_data.py. Shows THREE independent
   badges per peak (gondola / BAZL airspace / local operator) and never merges
   them into a single verdict. */

(function () {
  "use strict";

  var BBOX = [46.05, 8.65, 46.30, 9.05]; // S,W,N,E fallback

  var map = L.map("map", { zoomControl: true });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
  map.fitBounds([[BBOX[0], BBOX[1]], [BBOX[2], BBOX[3]]]);

  // ---- colour mappings (kept per-signal, never combined) ----
  var GONDOLA = {
    confirmed:   { cls: "p-green", badge: "b-green", label: "confirmed" },
    unconfirmed: { cls: "p-amber", badge: "b-amber", label: "unconfirmed" },
    none:        { cls: "p-grey",  badge: "b-grey",  label: "none" }
  };
  var BAZL = {
    restricted: { cls: "p-red",   badge: "b-red",   label: "restricted" },
    clear:      { cls: "p-green", badge: "b-green", label: "clear (this layer)" },
    error:      { cls: "p-grey",  badge: "b-grey",  label: "error / unknown" }
  };
  var LOCAL = {
    confirmed_banned:  { cls: "p-red",   badge: "b-red",   label: "confirmed banned" },
    confirmed_allowed: { cls: "p-green", badge: "b-green", label: "confirmed allowed" },
    unknown:           { cls: "p-grey",  badge: "b-grey",  label: "unknown" }
  };

  function esc(s) {
    if (s === null || s === undefined) return "";
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function pick(mapObj, key) { return mapObj[key] || mapObj[Object.keys(mapObj).pop()]; }

  function markerIcon(peak) {
    var g = pick(GONDOLA, peak.gondola.status);
    var a = pick(BAZL, peak.bazl.status);
    var l = pick(LOCAL, peak.local_restriction.status);
    var html =
      '<div class="peak-marker" title="' + esc(peak.name) + '">' +
        '<span class="pill ' + g.cls + '">G</span>' +
        '<span class="pill ' + a.cls + '">A</span>' +
        '<span class="pill ' + l.cls + '">L</span>' +
      '</div>';
    return L.divIcon({ className: "", html: html, iconSize: [0, 0] });
  }

  function badge(mapObj, key) {
    var m = pick(mapObj, key);
    return '<span class="badge ' + m.badge + '">' + esc(m.label) + '</span>';
  }

  function gondolaDetail(g) {
    if (g.status === "none") return "No lift terminal within 400 m.";
    var bits = [];
    if (g.lift_name || g.lift_type) bits.push("Lift: " + esc(g.lift_name || g.lift_type));
    if (g.distance_m != null) bits.push(g.distance_m + " m horizontal");
    if (g.ele_diff_m != null) bits.push("Δ" + g.ele_diff_m + " m elevation");
    else bits.push("elevation check not applied");
    return bits.join(" · ");
  }

  function bazlDetail(b) {
    var out = '<div class="detail">Fetched: ' + esc(b.fetched_utc || "n/a") +
              " · " + esc(b.queried_points || 0) + " sample points</div>";
    if (b.zones && b.zones.length) {
      out += '<ul class="zones">';
      b.zones.forEach(function (z) {
        var t = z.type === "blanket_ban" ? "blanket ban"
              : z.type === "authorization_required" ? "authorization required"
              : "type unclassified — check source";
        out += "<li>" + esc(z.name) + " — <em>" + esc(t) + "</em></li>";
      });
      out += "</ul>";
    } else if (b.status === "clear") {
      out += '<div class="detail">No zone returned in this layer. This is NOT a ' +
             'clearance — DABS/NOTAM and local rules still apply.</div>';
    } else {
      out += '<div class="detail">Airspace status could not be determined.</div>';
    }
    return out;
  }

  function localDetail(l) {
    var out = "";
    if (l.note) out += '<div class="detail">' + esc(l.note) + "</div>";
    if (l.source_url) out += '<div class="detail">Source: <a href="' + esc(l.source_url) +
      '" target="_blank" rel="noopener">' + esc(l.source_url) + "</a>" +
      (l.checked_date ? " (checked " + esc(l.checked_date) + ")" : "") + "</div>";
    return out;
  }

  function popupHtml(p) {
    return '' +
      '<div class="popup">' +
        "<h3>" + esc(p.name) + "</h3>" +
        '<p class="ele">' + (p.ele != null ? esc(p.ele) + " m" : "elevation unknown") +
          " · " + esc(p.lat.toFixed(5)) + ", " + esc(p.lon.toFixed(5)) + "</p>" +

        '<div class="row"><div class="label"><span class="tag tag-g">G</span>Gondola ' +
          badge(GONDOLA, p.gondola.status) + "</div>" +
          '<div class="detail">' + gondolaDetail(p.gondola) + "</div></div>" +

        '<div class="row"><div class="label"><span class="tag tag-a">A</span>BAZL airspace ' +
          badge(BAZL, p.bazl.status) + "</div>" + bazlDetail(p.bazl) + "</div>" +

        '<div class="row"><div class="label"><span class="tag tag-l">L</span>Local / operator ' +
          badge(LOCAL, p.local_restriction.status) + "</div>" +
          localDetail(p.local_restriction) + "</div>" +

        '<a class="verify" href="' + esc(p.geoadmin_url ||
          ("https://map.geo.admin.ch/?lang=en&layers=ch.bazl.einschraenkungen-drohnen&swisssearch=" +
           p.lat + "," + p.lon)) +
          '" target="_blank" rel="noopener">Verify on geo.admin.ch →</a>' +
        ' <a class="verify" style="background:#6b4e00" href="https://dabs.bazl.admin.ch/"' +
          ' target="_blank" rel="noopener">Check DABS →</a>' +
      "</div>";
  }

  function render(data) {
    var meta = data._meta || {};
    var metaBox = document.getElementById("metaBox");
    if (meta.status === "NOT_FETCHED" || !data.peaks || data.peaks.length === 0) {
      var nf = document.getElementById("notFetched");
      nf.classList.remove("hidden");
      document.getElementById("notFetchedMsg").textContent =
        (meta.note ||
         "Run `python3 fetch_data.py` in an environment with internet access to populate real peaks.");
      metaBox.textContent = "Status: " + (meta.status || "empty");
      return;
    }

    var bounds = [];
    data.peaks.forEach(function (p) {
      var m = L.marker([p.lat, p.lon], { icon: markerIcon(p) });
      m.bindPopup(popupHtml(p), { maxWidth: 320 });
      m.addTo(map);
      bounds.push([p.lat, p.lon]);
    });
    if (bounds.length) map.fitBounds(bounds, { padding: [40, 40] });

    metaBox.innerHTML =
      "Data fetched: " + esc(meta.generated_utc || "n/a") + "<br>" +
      "Peaks: " + data.peaks.length +
      " · gondola confirmed: " + (meta.counts ? meta.counts.gondola_confirmed : "?") +
      " · BAZL restricted: " + (meta.counts ? meta.counts.bazl_restricted : "?") + "<br>" +
      "Sources: OSM Overpass + swisstopo/BAZL geo.admin. Local column is manual.";
  }

  // Legend toggle
  document.getElementById("legendToggle").addEventListener("click", function () {
    var lg = document.getElementById("legend");
    var open = lg.classList.toggle("hidden");
    this.setAttribute("aria-expanded", String(!open));
  });

  fetch("data/peaks.json", { cache: "no-store" })
    .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(render)
    .catch(function (e) {
      var nf = document.getElementById("notFetched");
      nf.classList.remove("hidden");
      document.getElementById("notFetchedMsg").textContent =
        "Could not load data/peaks.json (" + e.message + ").";
    });
})();
