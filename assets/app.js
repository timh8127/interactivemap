/* Ticino peaks — drone planning aid.
   Renders data/peaks.json produced by fetch_data.py. Shows THREE independent
   badges per peak (gondola / BAZL airspace / local operator) and never merges
   them into a single verdict.

   Adds: peak search, and an admin edit view whose corrections persist as
   data/overrides.json (a separate layer applied on top of the fetched data,
   so manual edits never contaminate the live-derived values). */

(function () {
  "use strict";

  var BBOX = [45.80, 8.35, 46.65, 9.20]; // S,W,N,E fallback (Canton Ticino)
  var LS_KEY = "ticino_overrides";       // browser-local, in-progress edits

  // ---- map ----------------------------------------------------------------
  var map = L.map("map", {
    zoomControl: true,
    zoomSnap: 1,
    zoomDelta: 1,
    scrollWheelZoom: false // replaced with a one-notch-per-level handler below
  });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
  map.fitBounds([[BBOX[0], BBOX[1]], [BBOX[2], BBOX[3]]]);

  // Discrete wheel zoom: exactly one level per notch, centered on the cursor.
  // Leaflet's built-in scroll zoom accumulates raw wheel deltas, so a
  // high-resolution mouse/trackpad jumps many levels in a single notch.
  (function () {
    var lock = false;
    map.getContainer().addEventListener("wheel", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (lock) return;
      lock = true;
      setTimeout(function () { lock = false; }, 90);
      var dir = e.deltaY < 0 ? 1 : -1;
      map.setZoomAround(map.mouseEventToContainerPoint(e), map.getZoom() + dir);
    }, { passive: false, capture: true });
  })();

  // ---- colour mappings (kept per-signal, never combined) ------------------
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

  // ---- overrides ----------------------------------------------------------
  var fileOverrides = {};   // from committed data/overrides.json
  var localOverrides = {};  // from localStorage (this browser only)
  var adminMode = false;

  function loadLocal() {
    try { localOverrides = JSON.parse(localStorage.getItem(LS_KEY) || "{}"); }
    catch (e) { localOverrides = {}; }
  }
  function saveLocal() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(localOverrides)); } catch (e) {}
  }
  function effectiveOverride(id) {
    var f = fileOverrides[id], l = localOverrides[id];
    if (!f && !l) return null;
    return Object.assign({}, f || {}, l || {});
  }
  function snapshot(p) {
    if (!p._orig) {
      p._orig = {
        gondola_status: p.gondola.status,
        local_status: p.local_restriction.status,
        local_source_url: p.local_restriction.source_url || "",
        local_note: p.local_restriction.note || ""
      };
    }
  }
  function applyOverrides(p) {
    snapshot(p);
    // start from original live-derived values
    p.gondola.status = p._orig.gondola_status;
    p.gondola.override_note = null;
    p.local_restriction.status = p._orig.local_status;
    p.local_restriction.source_url = p._orig.local_source_url;
    p.local_restriction.note = p._orig.local_note;
    p._overridden = false;
    var ov = effectiveOverride(p.osm_id);
    if (ov) {
      if (ov.gondola_status) { p.gondola.status = ov.gondola_status; p._overridden = true; }
      if (ov.gondola_note) { p.gondola.override_note = ov.gondola_note; p._overridden = true; }
      if (ov.local_status) { p.local_restriction.status = ov.local_status; p._overridden = true; }
      if (ov.local_source_url) { p.local_restriction.source_url = ov.local_source_url; p._overridden = true; }
      if (ov.local_note) { p.local_restriction.note = ov.local_note; p._overridden = true; }
    }
  }

  // ---- marker + popup -----------------------------------------------------
  function markerIcon(peak) {
    var g = pick(GONDOLA, peak.gondola.status);
    var a = pick(BAZL, peak.bazl.status);
    var l = pick(LOCAL, peak.local_restriction.status);
    var edited = peak._overridden ? " is-edited" : "";
    var html =
      '<div class="peak-marker' + edited + '" title="' + esc(peak.name) + '">' +
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
    var out = "";
    if (g.status === "none") out = "No lift terminal within 400 m.";
    else {
      var bits = [];
      if (g.lift_name || g.lift_type) bits.push("Lift: " + esc(g.lift_name || g.lift_type));
      if (g.distance_m != null) bits.push(g.distance_m + " m horizontal");
      if (g.ele_diff_m != null) bits.push("Δ" + g.ele_diff_m + " m elevation");
      else bits.push("elevation check not applied");
      out = bits.join(" · ");
    }
    if (g.override_note) out += '<br><em>Note: ' + esc(g.override_note) + "</em>";
    return out;
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

  function editForm(p) {
    function opt(val, cur, label) {
      return '<option value="' + val + '"' + (val === cur ? " selected" : "") + ">" +
             esc(label) + "</option>";
    }
    return '' +
      '<div class="edit">' +
        "<h4>Admin — edit this peak</h4>" +
        "<label>Gondola status</label>" +
        '<select class="ed-gondola">' +
          opt("none", p.gondola.status, "none") +
          opt("unconfirmed", p.gondola.status, "unconfirmed") +
          opt("confirmed", p.gondola.status, "confirmed") +
        "</select>" +
        '<input class="ed-gnote" type="text" placeholder="Gondola note (e.g. funicular)" value="' +
          esc((effectiveOverride(p.osm_id) || {}).gondola_note || "") + '">' +
        "<label>Local / operator status</label>" +
        '<select class="ed-local">' +
          opt("unknown", p.local_restriction.status, "unknown") +
          opt("confirmed_allowed", p.local_restriction.status, "confirmed allowed") +
          opt("confirmed_banned", p.local_restriction.status, "confirmed banned") +
        "</select>" +
        "<label>Local source URL</label>" +
        '<input class="ed-src" type="text" placeholder="https://operator.example/…" value="' +
          esc(p.local_restriction.source_url || "") + '">' +
        "<label>Local note</label>" +
        '<textarea class="ed-note" placeholder="What the source says">' +
          esc(p.local_restriction.note || "") + "</textarea>" +
        '<div class="btns">' +
          '<button type="button" class="save">Save</button>' +
          '<button type="button" class="reset">Reset this peak</button>' +
        "</div>" +
      "</div>";
  }

  function popupHtml(p) {
    var editedFlag = p._overridden ? '<span class="edited-flag">edited</span>' : "";
    return '' +
      '<div class="popup" data-osm="' + esc(p.osm_id) + '">' +
        "<h3>" + esc(p.name) + editedFlag + "</h3>" +
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
        ' <a class="verify" style="background:#6b4e00" href="https://www.skybriefing.com/de/dabs"' +
          ' target="_blank" rel="noopener">Check DABS →</a>' +
        (adminMode ? editForm(p) : "") +
      "</div>";
  }

  // ---- registry + rendering ----------------------------------------------
  var peaksById = {};    // osm_id -> peak
  var markersById = {};  // osm_id -> L.marker
  var allPeaks = [];

  function refreshPeak(p) {
    var m = markersById[p.osm_id];
    if (!m) return;
    m.setIcon(markerIcon(p));
    m.setPopupContent(popupHtml(p));
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

    allPeaks = data.peaks;
    var bounds = [];
    data.peaks.forEach(function (p) {
      applyOverrides(p);
      peaksById[p.osm_id] = p;
      var m = L.marker([p.lat, p.lon], { icon: markerIcon(p) });
      // bind as a function so each open reflects current admin mode + overrides
      m.bindPopup((function (peak) { return function () { return popupHtml(peak); }; })(p),
                  { maxWidth: 340 });
      m.addTo(map);
      markersById[p.osm_id] = m;
      bounds.push([p.lat, p.lon]);
    });
    if (bounds.length) map.fitBounds(bounds, { padding: [40, 40] });

    var overridden = data.peaks.filter(function (p) { return p._overridden; }).length;
    metaBox.innerHTML =
      "Data fetched: " + esc(meta.generated_utc || "n/a") + "<br>" +
      "Peaks: " + data.peaks.length +
      " · gondola confirmed: " + (meta.counts ? meta.counts.gondola_confirmed : "?") +
      " · BAZL restricted: " + (meta.counts ? meta.counts.bazl_restricted : "?") +
      (overridden ? "<br>Manual overrides applied: " + overridden : "") + "<br>" +
      "Sources: OSM Overpass + swisstopo/BAZL geo.admin. Local column is manual.";
  }

  // ---- admin: edit form handling (event delegation) -----------------------
  function readFormInto(id, popupEl) {
    var g = popupEl.querySelector(".ed-gondola");
    var gn = popupEl.querySelector(".ed-gnote");
    var l = popupEl.querySelector(".ed-local");
    var src = popupEl.querySelector(".ed-src");
    var note = popupEl.querySelector(".ed-note");
    var ov = {
      gondola_status: g ? g.value : undefined,
      gondola_note: gn ? gn.value.trim() : "",
      local_status: l ? l.value : undefined,
      local_source_url: src ? src.value.trim() : "",
      local_note: note ? note.value.trim() : "",
      edited_utc: new Date().toISOString()
    };
    // drop empty strings so they don't count as overrides
    Object.keys(ov).forEach(function (k) { if (ov[k] === "") delete ov[k]; });
    localOverrides[id] = ov;
    saveLocal();
  }

  document.addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest(".edit .save, .edit .reset") : null;
    if (!btn) return;
    var popupEl = btn.closest(".popup");
    if (!popupEl) return;
    var id = popupEl.getAttribute("data-osm");
    var peak = peaksById[id];
    if (!peak) return;
    if (btn.classList.contains("save")) {
      readFormInto(id, popupEl);
    } else { // reset this peak (clears the browser-local edit)
      delete localOverrides[id];
      saveLocal();
    }
    applyOverrides(peak);
    refreshPeak(peak);
  });

  // ---- admin toggle + export ---------------------------------------------
  document.getElementById("adminToggle").addEventListener("click", function () {
    adminMode = !adminMode;
    this.setAttribute("aria-pressed", String(adminMode));
    document.getElementById("exportBtn").classList.toggle("hidden", !adminMode);
    // refresh any open popup so the form appears/disappears immediately
    Object.keys(markersById).forEach(function (id) {
      var m = markersById[id];
      if (m.isPopupOpen && m.isPopupOpen()) m.setPopupContent(popupHtml(peaksById[id]));
    });
  });

  document.getElementById("exportBtn").addEventListener("click", function () {
    // merge committed file overrides with this browser's edits (local wins)
    var merged = {};
    Object.keys(fileOverrides).forEach(function (k) { merged[k] = Object.assign({}, fileOverrides[k]); });
    Object.keys(localOverrides).forEach(function (k) {
      merged[k] = Object.assign({}, merged[k] || {}, localOverrides[k]);
    });
    var blob = new Blob([JSON.stringify(merged, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "overrides.json";
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(a.href);
  });

  // ---- search -------------------------------------------------------------
  var searchInput = document.getElementById("search");
  var resultsEl = document.getElementById("searchResults");
  var activeIdx = -1, currentMatches = [];

  function hideResults() { resultsEl.classList.add("hidden"); activeIdx = -1; }

  function runSearch() {
    var q = searchInput.value.trim().toLowerCase();
    if (!q) { hideResults(); return; }
    currentMatches = allPeaks
      .filter(function (p) { return (p.name || "").toLowerCase().indexOf(q) !== -1; })
      .sort(function (a, b) {
        var as = a.name.toLowerCase().indexOf(q) === 0 ? 0 : 1;
        var bs = b.name.toLowerCase().indexOf(q) === 0 ? 0 : 1;
        if (as !== bs) return as - bs;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 12);
    if (!currentMatches.length) {
      resultsEl.innerHTML = '<li class="none">No peak found</li>';
      resultsEl.classList.remove("hidden");
      return;
    }
    resultsEl.innerHTML = currentMatches.map(function (p, i) {
      return '<li data-i="' + i + '"><span>' + esc(p.name) + "</span>" +
             '<span class="el">' + (p.ele != null ? esc(p.ele) + " m" : "") + "</span></li>";
    }).join("");
    activeIdx = -1;
    resultsEl.classList.remove("hidden");
  }

  function selectPeak(p) {
    hideResults();
    searchInput.value = p.name;
    map.setView([p.lat, p.lon], Math.max(map.getZoom(), 14), { animate: true });
    var m = markersById[p.osm_id];
    if (m) m.openPopup();
  }

  searchInput.addEventListener("input", runSearch);
  searchInput.addEventListener("focus", function () { if (searchInput.value.trim()) runSearch(); });
  searchInput.addEventListener("keydown", function (e) {
    var items = resultsEl.querySelectorAll("li[data-i]");
    if (e.key === "ArrowDown") { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, items.length - 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); }
    else if (e.key === "Enter") {
      e.preventDefault();
      var p = currentMatches[activeIdx >= 0 ? activeIdx : 0];
      if (p) selectPeak(p);
      return;
    } else if (e.key === "Escape") { hideResults(); return; }
    items.forEach(function (li, i) { li.classList.toggle("active", i === activeIdx); });
  });
  resultsEl.addEventListener("mousedown", function (e) {
    var li = e.target.closest("li[data-i]");
    if (!li) return;
    e.preventDefault();
    selectPeak(currentMatches[+li.getAttribute("data-i")]);
  });
  document.addEventListener("click", function (e) {
    if (!e.target.closest(".search-wrap")) hideResults();
  });

  // ---- legend toggle ------------------------------------------------------
  document.getElementById("legendToggle").addEventListener("click", function () {
    var lg = document.getElementById("legend");
    var open = lg.classList.toggle("hidden");
    this.setAttribute("aria-expanded", String(!open));
  });

  window.__ticinoMap = map; // exposed for debugging / tests

  // ---- load: overrides first (optional), then peaks -----------------------
  loadLocal();
  fetch("data/overrides.json", { cache: "no-store" })
    .then(function (r) { return r.ok ? r.json() : {}; })
    .catch(function () { return {}; })
    .then(function (ov) { fileOverrides = ov || {}; })
    .then(function () { return fetch("data/peaks.json", { cache: "no-store" }); })
    .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(render)
    .catch(function (e) {
      var nf = document.getElementById("notFetched");
      nf.classList.remove("hidden");
      document.getElementById("notFetchedMsg").textContent =
        "Could not load data/peaks.json (" + e.message + ").";
    });
})();
