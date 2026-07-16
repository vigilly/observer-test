// The entire web UI as a self-contained HTML string. No framework, no build
// step, no external assets — the server sends this verbatim at GET /.
// NOTE: the embedded client script intentionally avoids template literals so
// this outer template literal doesn't need escaping.

export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>vigilly observer</title>
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --panel2: #1c2330; --border: #2a3140;
    --text: #e6edf3; --muted: #8b949e; --accent: #4c9aff;
    --log: #58a6ff; --trace: #a371f7; --exception: #f85149; --metric: #3fb950;
    --sentry: #8957e5; --otlp: #2dd4bf; --datadog: #6366f1; --prometheus: #e6a23c;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    background: var(--bg); color: var(--text); display: flex; flex-direction: column; height: 100vh;
    font: 13px/1.5 ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  header {
    display: flex; align-items: center; gap: 14px; padding: 10px 16px;
    background: var(--panel); border-bottom: 1px solid var(--border); flex-wrap: wrap;
  }
  .brand { font-weight: 700; font-size: 15px; letter-spacing: .3px; display: flex; align-items: center; gap: 8px; }
  .brand .eye { color: var(--accent); }
  .status { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); box-shadow: 0 0 6px transparent; }
  .dot.on { background: var(--metric); box-shadow: 0 0 8px var(--metric); }
  .dot.off { background: var(--exception); box-shadow: 0 0 8px var(--exception); }
  .spacer { flex: 1; }
  .endpoints { color: var(--muted); font-size: 11px; display: flex; gap: 12px; flex-wrap: wrap; }
  .endpoints b { color: var(--text); font-weight: 600; }
  button {
    background: var(--panel2); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 5px 10px; cursor: pointer; font: inherit;
  }
  button:hover { border-color: var(--accent); }
  .toolbar {
    display: flex; align-items: center; gap: 8px; padding: 8px 16px;
    background: var(--panel); border-bottom: 1px solid var(--border); flex-wrap: wrap;
  }
  .tabs { display: flex; gap: 6px; flex-wrap: wrap; }
  .tab {
    padding: 4px 11px; border-radius: 999px; border: 1px solid var(--border);
    background: transparent; color: var(--muted); cursor: pointer; font-size: 12px; display: flex; gap: 6px; align-items: center;
  }
  .tab.active { color: var(--text); border-color: var(--accent); background: var(--panel2); }
  .tab .n { color: var(--muted); font-size: 11px; }
  .tab.active .n { color: var(--accent); }
  select, input[type=text] {
    background: var(--panel2); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 5px 8px; font: inherit;
  }
  input[type=text] { min-width: 200px; flex: 1; }
  main { flex: 1; overflow-y: auto; }
  .row {
    display: grid; grid-template-columns: 96px 92px 96px 150px 1fr; gap: 10px; align-items: baseline;
    padding: 5px 16px; border-bottom: 1px solid #171d27; cursor: pointer; white-space: nowrap;
  }
  .row:hover { background: #131a24; }
  .row .time { color: var(--muted); font-size: 11px; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; text-align: center; }
  .sig-log { color: var(--log); border: 1px solid var(--log); }
  .sig-trace { color: var(--trace); border: 1px solid var(--trace); }
  .sig-exception { color: var(--exception); border: 1px solid var(--exception); background: rgba(248,81,73,.08); }
  .sig-metric { color: var(--metric); border: 1px solid var(--metric); }
  .src { font-size: 11px; padding: 1px 6px; border-radius: 4px; }
  .src-sentry { color: var(--sentry); } .src-otlp { color: var(--otlp); }
  .src-datadog { color: var(--datadog); } .src-prometheus { color: var(--prometheus); }
  .svc { color: var(--muted); overflow: hidden; text-overflow: ellipsis; }
  .summary { overflow: hidden; text-overflow: ellipsis; }
  .detail { padding: 10px 16px 14px 122px; background: #0b0f16; border-bottom: 1px solid var(--border); white-space: normal; }
  .detail table { border-collapse: collapse; margin-bottom: 8px; }
  .detail td { padding: 2px 12px 2px 0; vertical-align: top; }
  .detail td.k { color: var(--accent); }
  .detail td.v { color: var(--text); word-break: break-word; }
  .detail pre {
    margin: 0; padding: 10px; background: #060910; border: 1px solid var(--border); border-radius: 6px;
    max-height: 320px; overflow: auto; color: #c9d1d9; white-space: pre-wrap; word-break: break-word;
  }
  .empty { color: var(--muted); text-align: center; padding: 60px 20px; }
  .empty code { color: var(--accent); }
</style>
</head>
<body>
<header>
  <div class="brand"><span class="eye">◉</span> vigilly observer</div>
  <div class="status"><span class="dot" id="dot"></span><span id="statusText">connecting…</span></div>
  <div class="spacer"></div>
  <div class="endpoints" id="endpoints"></div>
</header>
<div class="toolbar">
  <div class="tabs" id="tabs"></div>
  <div class="spacer"></div>
  <select id="sourceSel"><option value="all">all sources</option></select>
  <select id="serviceSel"><option value="all">all services</option></select>
  <input type="text" id="search" placeholder="filter… (message, service, attribute)" />
  <button id="pauseBtn">Pause</button>
  <button id="clearBtn">Clear</button>
</div>
<main id="main">
  <div class="empty" id="empty">
    Waiting for telemetry… point an app at this collector, or run <code>vigilly-observer demo</code>.
  </div>
  <div id="list"></div>
</main>
<script>
(function () {
  var MAX_EVENTS = 5000, MAX_ROWS = 800;
  var events = [], paused = false, pendingCount = 0;
  var counts = { all: 0, log: 0, trace: 0, exception: 0, metric: 0 };
  var services = {}, sources = {};
  var filter = { signal: "all", source: "all", service: "all", q: "" };

  var SIGNALS = ["all", "log", "trace", "exception", "metric"];
  var listEl = document.getElementById("list");
  var emptyEl = document.getElementById("empty");
  var dot = document.getElementById("dot");
  var statusText = document.getElementById("statusText");
  var sourceSel = document.getElementById("sourceSel");
  var serviceSel = document.getElementById("serviceSel");
  var searchEl = document.getElementById("search");
  var pauseBtn = document.getElementById("pauseBtn");
  var tabsEl = document.getElementById("tabs");

  // Build signal tabs
  var tabEls = {};
  SIGNALS.forEach(function (sig) {
    var t = document.createElement("div");
    t.className = "tab" + (sig === "all" ? " active" : "");
    var label = document.createElement("span");
    label.textContent = sig === "all" ? "all" : sig + "s";
    var n = document.createElement("span");
    n.className = "n"; n.textContent = "0";
    t.appendChild(label); t.appendChild(n);
    t.onclick = function () {
      filter.signal = sig;
      Object.keys(tabEls).forEach(function (k) { tabEls[k].el.classList.toggle("active", k === sig); });
      rerender();
    };
    tabEls[sig] = { el: t, n: n };
    tabsEl.appendChild(t);
  });

  function two(x) { return x < 10 ? "0" + x : "" + x; }
  function three(x) { return x < 10 ? "00" + x : x < 100 ? "0" + x : "" + x; }
  function fmtTime(ev) {
    var d = new Date(ev.timestamp || ev.receivedAt);
    return two(d.getHours()) + ":" + two(d.getMinutes()) + ":" + two(d.getSeconds()) + "." + three(d.getMilliseconds());
  }

  function matches(ev) {
    if (filter.signal !== "all" && ev.signal !== filter.signal) return false;
    if (filter.source !== "all" && ev.source !== filter.source) return false;
    if (filter.service !== "all" && (ev.service || "") !== filter.service) return false;
    if (filter.q) {
      var hay = (ev.summary + " " + (ev.service || "") + " " + ev.source + " " + ev.signal + " " +
        JSON.stringify(ev.attributes || {})).toLowerCase();
      if (hay.indexOf(filter.q) === -1) return false;
    }
    return true;
  }

  function kv(k, v) {
    var tr = document.createElement("tr");
    var tk = document.createElement("td"); tk.className = "k"; tk.textContent = k;
    var tv = document.createElement("td"); tv.className = "v";
    tv.textContent = (typeof v === "object") ? JSON.stringify(v) : String(v);
    tr.appendChild(tk); tr.appendChild(tv); return tr;
  }

  function buildDetail(ev) {
    var d = document.createElement("div");
    d.className = "detail";
    var table = document.createElement("table");
    var attrs = ev.attributes || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === undefined || v === null || v === "") return;
      table.appendChild(kv(k, v));
    });
    if (table.childNodes.length) d.appendChild(table);
    var pre = document.createElement("pre");
    pre.textContent = JSON.stringify(ev.raw !== undefined ? ev.raw : ev, null, 2);
    d.appendChild(pre);
    return d;
  }

  function buildRow(ev) {
    var row = document.createElement("div");
    row.className = "row";
    var time = document.createElement("span"); time.className = "time"; time.textContent = fmtTime(ev);
    var sig = document.createElement("span"); sig.className = "badge sig-" + ev.signal; sig.textContent = ev.signal;
    var src = document.createElement("span"); src.className = "src src-" + ev.source; src.textContent = ev.source;
    var svc = document.createElement("span"); svc.className = "svc"; svc.textContent = ev.service || "—";
    var sum = document.createElement("span"); sum.className = "summary"; sum.textContent = ev.summary;
    row.appendChild(time); row.appendChild(sig); row.appendChild(src); row.appendChild(svc); row.appendChild(sum);
    var detail = null;
    row.onclick = function () {
      if (detail) { detail.remove(); detail = null; return; }
      detail = buildDetail(ev);
      row.parentNode.insertBefore(detail, row.nextSibling);
    };
    return row;
  }

  function updateCounts() {
    SIGNALS.forEach(function (s) { tabEls[s].n.textContent = String(counts[s] || 0); });
    emptyEl.style.display = counts.all ? "none" : "";
  }

  function refreshSelect(sel, map, label) {
    var current = sel.value;
    var keys = Object.keys(map).sort();
    // rebuild only if option set changed
    if (sel.options.length - 1 === keys.length) return;
    sel.innerHTML = "";
    var all = document.createElement("option"); all.value = "all"; all.textContent = label; sel.appendChild(all);
    keys.forEach(function (k) {
      var o = document.createElement("option"); o.value = k; o.textContent = k; sel.appendChild(o);
    });
    sel.value = current && (current === "all" || map[current]) ? current : "all";
  }

  function trimRows() {
    while (listEl.childNodes.length > MAX_ROWS) listEl.removeChild(listEl.lastChild);
  }

  function rerender() {
    listEl.innerHTML = "";
    var shown = 0;
    for (var i = events.length - 1; i >= 0 && shown < MAX_ROWS; i--) {
      if (matches(events[i])) { listEl.appendChild(buildRow(events[i])); shown++; }
    }
  }

  function onEvent(ev) {
    events.push(ev);
    if (events.length > MAX_EVENTS) events.shift();
    counts.all++; counts[ev.signal] = (counts[ev.signal] || 0) + 1;
    if (ev.service) services[ev.service] = 1;
    sources[ev.source] = 1;
    updateCounts();
    refreshSelect(sourceSel, sources, "all sources");
    refreshSelect(serviceSel, services, "all services");
    if (paused) { if (matches(ev)) { pendingCount++; pauseBtn.textContent = "Resume (" + pendingCount + ")"; } return; }
    if (matches(ev)) { listEl.insertBefore(buildRow(ev), listEl.firstChild); trimRows(); }
  }

  // Controls
  sourceSel.onchange = function () { filter.source = sourceSel.value; rerender(); };
  serviceSel.onchange = function () { filter.service = serviceSel.value; rerender(); };
  searchEl.oninput = function () { filter.q = searchEl.value.trim().toLowerCase(); rerender(); };
  pauseBtn.onclick = function () {
    paused = !paused;
    if (!paused) { pendingCount = 0; pauseBtn.textContent = "Pause"; rerender(); }
    else pauseBtn.textContent = "Resume";
  };
  document.getElementById("clearBtn").onclick = function () {
    events = []; counts = { all: 0, log: 0, trace: 0, exception: 0, metric: 0 };
    pendingCount = 0; paused = false; pauseBtn.textContent = "Pause";
    listEl.innerHTML = ""; updateCounts();
  };

  // Endpoints banner
  fetch("/config").then(function (r) { return r.json(); }).then(function (c) {
    var el = document.getElementById("endpoints");
    var parts = [];
    if (c.httpPort) parts.push("<b>OTLP/HTTP + Sentry + Datadog</b> :" + c.httpPort);
    if (c.grpcPort) parts.push("<b>OTLP/gRPC</b> :" + c.grpcPort);
    if (c.ddPort && c.ddPort !== c.httpPort) parts.push("<b>Datadog agent</b> :" + c.ddPort);
    if (c.scrape && c.scrape.length) parts.push("<b>scraping</b> " + c.scrape.length + " target(s)");
    el.innerHTML = parts.join("");
  }).catch(function () {});

  // SSE
  function connect() {
    var es = new EventSource("/events");
    es.onopen = function () { dot.className = "dot on"; statusText.textContent = "live"; };
    es.onmessage = function (e) { try { onEvent(JSON.parse(e.data)); } catch (err) {} };
    es.onerror = function () { dot.className = "dot off"; statusText.textContent = "reconnecting…"; };
  }
  connect();
})();
</script>
</body>
</html>`;
