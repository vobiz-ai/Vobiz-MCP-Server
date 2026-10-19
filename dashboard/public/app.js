// Vobiz Ops dashboard: vanilla JS, no build step.
// All data comes from vobiz-ops MCP tools via the local dashboard server.
// Backend values are always rendered with textContent (never innerHTML).

const TOKEN = document.querySelector('meta[name="dashboard-token"]').content;
const AUTH_ID = document.querySelector('meta[name="auth-id"]').content;

// ── Safe local storage (falls back to memory when storage is blocked/read-only) ──
const memoryStore = new Map();
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      if (v !== null) return JSON.parse(v);
    } catch {}
    return memoryStore.has(key) ? memoryStore.get(key) : fallback;
  },
  set(key, value) {
    memoryStore.set(key, value);
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable: memory copy keeps the UI working for this session */
    }
  },
};

// ── DOM helper ────────────────────────────────────────────────
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v; // CSSOM: allowed under the page's strict CSP (inline style attributes are not)
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const $ = (sel) => document.querySelector(sel);

// ── API ───────────────────────────────────────────────────────
class ToolError extends Error {
  constructor(data) {
    super(data?.message || "The request failed.");
    this.kind = data?.error || "unknown";
    this.hint = data?.hint;
    this.status = data?.http_status;
  }
}

async function tool(name, args = {}) {
  let res;
  try {
    res = await fetch(`/api/tools/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Dashboard-Token": TOKEN },
      body: JSON.stringify(args),
    });
  } catch {
    throw new ToolError({ error: "dashboard_offline", message: "Cannot reach the local dashboard server. Is `npm run dashboard` still running?" });
  }
  let body = {};
  try {
    body = await res.json();
  } catch {}
  if (!res.ok) throw new ToolError({ error: body.error || "dashboard_error", message: body.message || `Dashboard request failed (${res.status}).` });
  if (body.isError) throw new ToolError(body.data);
  return body.data;
}

const FRIENDLY = {
  missing_credentials: ["Credentials not configured", "Set VOBIZ_AUTH_ID and VOBIZ_AUTH_TOKEN in .env and restart the dashboard."],
  auth_failed: ["Authentication failed", "Vobiz rejected the configured credentials. Check or rotate the auth token."],
  forbidden: ["Access denied", "This account is not allowed to view this resource."],
  not_found: ["Not found", null],
  rate_limited: ["Too many requests", "Vobiz is rate limiting this account. Wait a moment and retry."],
  timeout: ["Vobiz is slow to respond", "The request timed out. Try again."],
  network_error: ["Can't reach Vobiz", "Check your internet connection and VOBIZ_BASE_URL."],
  service_unavailable: ["Vobiz service unavailable", "The service is temporarily down. Try again shortly."],
  backend_error: ["Vobiz returned an error", null],
  unexpected_response: ["Unexpected response", "Vobiz answered in a format this dashboard doesn't recognise."],
  account_suspended: ["Account suspended", "Contact Vobiz support."],
  invalid_input: ["Check the filters", null],
  dashboard_offline: ["Dashboard server offline", null],
};

function errorBanner(err, onRetry) {
  const [title, extra] = FRIENDLY[err.kind] || ["Something went wrong", null];
  return h(
    "div",
    { class: "banner error", role: "alert" },
    h("span", { class: "banner-icon", "aria-hidden": "true" }, "!"),
    h("div", { class: "banner-text" }, h("strong", {}, title), err.message, extra && err.message !== extra ? h("div", { class: "muted" }, extra) : null),
    onRetry ? h("button", { class: "btn btn-secondary", type: "button", onclick: onRetry }, "Retry") : null,
  );
}

// ── Toasts ────────────────────────────────────────────────────
function toast(message, type = "info") {
  const el = h("div", { class: `toast ${type}`, role: type === "error" ? "alert" : "status" }, message);
  $("#toasts").append(el);
  setTimeout(() => {
    el.classList.add("leaving");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  }, 3200);
}

// ── Formatting ────────────────────────────────────────────────
const dash = "—";
function fmtDate(v) {
  if (!v) return dash;
  const d = new Date(String(v).replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
function fmtDuration(sec) {
  if (sec === null || sec === undefined || sec === "") return dash;
  const s = Math.round(Number(sec));
  if (!Number.isFinite(s)) return dash;
  const m = Math.floor(s / 60);
  return m ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}
function fmtMoney(v, cur) {
  if (v === null || v === undefined || v === "") return dash;
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: cur || "INR", maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${n.toFixed(2)} ${cur || ""}`.trim();
  }
}
/** Phone numbers stay as-is; long SIP URIs are shortened with the full value in a tooltip. */
function party(v) {
  if (!v) return dash;
  const str = String(v);
  if (str.length <= 26) return str;
  const m = str.match(/^sip:([^@]+)@(.+)$/);
  const short = m ? `sip:${m[1].slice(0, 14)}…@${m[2].split(".")[0]}` : `${str.slice(0, 22)}…`;
  return h("span", { class: "trunc", title: str }, short);
}
function fmtNum(v) {
  return v === null || v === undefined ? dash : Number(v).toLocaleString();
}

const STATUS_TONE = {
  active: "success", enabled: "success", "in-progress": "success", live: "success", completed: "neutral",
  queued: "info", ringing: "info", pending_purchase: "info",
  pending_release: "warning", quarantined: "warning", suspended: "warning", disabled: "warning",
  blocked: "danger", released: "neutral", deleted: "neutral",
};
const HANGUP_TONE = { NORMAL_CLEARING: "success", ORIGINATOR_CANCEL: "warning", NO_ANSWER: "warning", USER_BUSY: "warning", CALL_REJECTED: "danger" };
function badge(text, tone) {
  if (text === null || text === undefined || text === "") return dash;
  return h("span", { class: `badge ${tone || STATUS_TONE[String(text).toLowerCase()] || "neutral"}` }, String(text).replaceAll("_", " "));
}
function hangupBadge(cause) {
  if (!cause) return dash;
  return badge(cause, HANGUP_TONE[cause] || (/FAIL|ERROR|REJECT|UNALLOCATED|INVALID/.test(cause) ? "danger" : "neutral"));
}

function copyable(value, short = true) {
  if (!value) return dash;
  const s = String(value);
  return h(
    "span",
    { class: "id-cell" },
    h("code", { title: s }, short && s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s),
    h(
      "button",
      {
        class: "copy",
        type: "button",
        "aria-label": "Copy",
        onclick: async (e) => {
          e.stopPropagation();
          try {
            await navigator.clipboard.writeText(s);
            toast("Copied to clipboard", "success");
          } catch {
            toast("Couldn't copy (clipboard blocked)", "error");
          }
        },
      },
      "⧉",
    ),
  );
}

// ── Skeletons & empty states ──────────────────────────────────
function skeletonRows(cols, rows = 6) {
  return Array.from({ length: rows }, () =>
    h("tr", {}, Array.from({ length: cols }, (_, i) => h("td", {}, h("span", { class: "skeleton", style: `width:${50 + ((i * 37) % 40)}%` })))),
  );
}
function emptyState(icon, title, text) {
  return h("div", { class: "empty" }, h("div", { class: "empty-icon", "aria-hidden": "true" }, icon), h("h3", {}, title), text ? h("p", {}, text) : null);
}

// ── Drawer ────────────────────────────────────────────────────
let lastFocus = null;
function openDrawer(title, build) {
  lastFocus = document.activeElement;
  $("#drawer-title").textContent = title;
  const body = $("#drawer-body");
  body.replaceChildren(h("div", { class: "empty" }, h("span", { class: "spinner", "aria-label": "Loading" })));
  $("#drawer").hidden = false;
  $("#drawer-backdrop").hidden = false;
  $("#drawer-close").focus();
  Promise.resolve(build(body)).catch((err) => body.replaceChildren(errorBanner(err instanceof ToolError ? err : new ToolError({}))));
}
function closeDrawer() {
  $("#drawer").hidden = true;
  $("#drawer-backdrop").hidden = true;
  $("#drawer-body").replaceChildren();
  lastFocus?.focus?.();
}
function kv(pairs) {
  return h("dl", { class: "kv" }, pairs.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v ?? dash)]));
}
function section(title, ...content) {
  return h("section", {}, h("div", { class: "section-title" }, title), ...content);
}
function audioPlayer(url) {
  if (!url || !/^https:\/\//.test(url)) return h("p", { class: "muted" }, "No playable recording URL.");
  return h("div", {}, h("audio", { controls: true, preload: "none", src: url }), h("p", { class: "muted" }, h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, "Open recording file")));
}

// ── Generic paginated table view ──────────────────────────────
/**
 * cfg: { key, tool, mode: "page"|"offset", pageSizes, maxPageSize, buildArgs(filters), rows(data),
 *        columns: [{label, render(row), class}], filters: [{name,label,type,options,placeholder}], empty, onRow(row) }
 * Pagination is driven only by the tool's has_more / next_page / next_offset fields.
 */
function tableView(cfg) {
  const sizeKey = `vobiz.pageSize.${cfg.key}`;
  const sizes = cfg.pageSizes || [10, 20, 50, 100];
  const state = { page: 1, offset: 0, size: store.get(sizeKey, cfg.defaultSize || 20), filters: {}, history: [] };
  if (!sizes.includes(state.size)) state.size = sizes[1] ?? sizes[0];

  const tbody = h("tbody");
  const thead = h("thead", {}, h("tr", {}, cfg.columns.map((c) => h("th", { scope: "col" }, c.label))));
  const tableWrap = h("div", { class: "table-wrap" }, h("table", {}, thead, tbody));
  const bannerSlot = h("div");
  const emptySlot = h("div");
  const info = h("span", {}, "");
  const prev = h("button", { class: "btn btn-secondary", type: "button", disabled: true }, "← Previous");
  const next = h("button", { class: "btn btn-secondary", type: "button", disabled: true }, "Next →");
  const sizeSelect = h(
    "select",
    { class: "select", "aria-label": "Rows per page", style: "min-width:auto" },
    sizes.map((s) => h("option", { value: s, selected: s === state.size }, `${s} / page`)),
  );
  const pager = h("div", { class: "pager" }, info, h("div", { class: "pager-controls" }, sizeSelect, prev, next));

  // Filters
  const filterEls = {};
  const toolbar = cfg.filters?.length
    ? h(
        "form",
        {
          class: "toolbar",
          onsubmit: (e) => {
            e.preventDefault();
            readFilters();
            resetPaging();
            load();
          },
        },
        cfg.filters.map((f) => {
          const id = `f-${cfg.key}-${f.name}`;
          const input =
            f.type === "select"
              ? h("select", { class: "select", id, name: f.name }, f.options.map(([v, l]) => h("option", { value: v }, l)))
              : h("input", { class: "input", id, name: f.name, type: f.type || "text", placeholder: f.placeholder || "", inputmode: f.inputmode });
          filterEls[f.name] = input;
          return h("label", { class: "field", for: id }, f.label, input);
        }),
        h("span", { class: "spacer" }),
        h("button", { class: "btn btn-ghost", type: "button", onclick: () => { for (const el of Object.values(filterEls)) el.value = ""; readFilters(); resetPaging(); load(); } }, "Clear"),
        h("button", { class: "btn btn-primary", type: "submit" }, "Apply"),
      )
    : null;

  function readFilters() {
    state.filters = {};
    for (const [k, el] of Object.entries(filterEls)) if (el.value.trim()) state.filters[k] = el.value.trim();
  }
  function resetPaging() {
    state.page = 1;
    state.offset = 0;
    state.history = [];
  }

  let reqId = 0;
  async function load() {
    const my = ++reqId;
    bannerSlot.replaceChildren();
    emptySlot.replaceChildren();
    tableWrap.hidden = false;
    tbody.replaceChildren(...skeletonRows(cfg.columns.length, Math.min(state.size, 8)));
    prev.disabled = next.disabled = true;
    info.textContent = "Loading…";

    const paging = cfg.mode === "offset" ? { limit: state.size, offset: state.offset } : { page: state.page, per_page: state.size };
    let data;
    try {
      data = await tool(cfg.tool, { ...cfg.buildArgs(state.filters), ...paging });
    } catch (err) {
      if (my !== reqId) return;
      tbody.replaceChildren();
      tableWrap.hidden = true;
      bannerSlot.replaceChildren(errorBanner(err, load));
      info.textContent = "";
      return;
    }
    if (my !== reqId) return;

    const rows = cfg.rows(data) || [];
    const p = data.pagination || {};
    tbody.replaceChildren(
      ...rows.map((row) =>
        h(
          "tr",
          cfg.onRow
            ? { class: "clickable", tabindex: "0", onclick: () => cfg.onRow(row), onkeydown: (e) => { if (e.key === "Enter") cfg.onRow(row); } }
            : {},
          cfg.columns.map((c) => h("td", { class: c.class }, c.render(row))),
        ),
      ),
    );
    if (!rows.length) {
      tableWrap.hidden = true;
      const filtered = Object.keys(state.filters).length > 0;
      emptySlot.replaceChildren(emptyState(cfg.empty.icon, filtered ? "No matches" : cfg.empty.title, filtered ? "Try different filters." : cfg.empty.text));
    }

    const firstIndex = cfg.mode === "offset" ? state.offset : (state.page - 1) * state.size;
    const total = typeof p.total === "number" ? p.total : null;
    if (rows.length) {
      const range = `${(firstIndex + 1).toLocaleString()}–${(firstIndex + rows.length).toLocaleString()}`;
      info.textContent = total !== null ? `${range} of ${total.toLocaleString()}` : `Showing ${range}`;
    } else info.textContent = total === 0 ? "0 results" : "";

    const canPrev = cfg.mode === "offset" ? state.offset > 0 : state.page > 1;
    prev.disabled = !canPrev;
    next.disabled = !p.has_more;
    next.onclick = () => {
      if (cfg.mode === "offset") {
        state.history.push(state.offset);
        state.offset = p.next_offset ?? state.offset + state.size;
      } else state.page = p.next_page ?? state.page + 1;
      load();
    };
    prev.onclick = () => {
      if (cfg.mode === "offset") state.offset = state.history.pop() ?? Math.max(0, state.offset - state.size);
      else state.page = Math.max(1, state.page - 1);
      load();
    };
  }

  sizeSelect.addEventListener("change", () => {
    state.size = Number(sizeSelect.value);
    store.set(sizeKey, state.size); // never blocks: falls back to memory if storage is read-only
    resetPaging();
    load();
  });

  const card = h(
    "div",
    { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, cfg.title), cfg.headerExtra || null),
    toolbar,
    bannerSlot,
    tableWrap,
    emptySlot,
    pager,
  );
  return { el: card, load };
}

// ── Views ─────────────────────────────────────────────────────
function openCall(uuid) {
  openDrawer("Call details", async (body) => {
    const [details, recs] = await Promise.allSettled([tool("get_call_details", { call_uuid: uuid }), tool("get_call_recording", { call_uuid: uuid })]);
    const parts = [];
    if (details.status === "fulfilled") {
      const r = details.value.record || {};
      parts.push(
        section(
          "Call",
          kv([
            ["Call UUID", copyable(r.uuid || uuid, false)],
            ["Direction", badge(r.call_direction, r.call_direction === "inbound" ? "info" : "neutral")],
            ["From", r.caller_id_number || dash],
            ["To", r.destination_number || dash],
            ["Hangup cause", hangupBadge(r.hangup_cause)],
            ["Hangup source", r.hangup_source || dash],
            ["Context", r.context || dash],
          ]),
        ),
        section(
          "Timing & cost",
          kv([
            ["Started", fmtDate(r.start_time)],
            ["Answered", fmtDate(r.answer_time)],
            ["Ended", fmtDate(r.end_time)],
            ["Duration", fmtDuration(r.duration)],
            ["Billed", fmtDuration(r.billsec)],
            ["Ring time", fmtDuration(r.ring_time)],
            ["Total cost", fmtMoney(r.total_cost ?? r.cost, r.currency)],
          ]),
        ),
        section("Quality", kv([["MOS", r.mos ?? dash], ["Jitter", r.jitter ?? dash], ["Packet loss", r.packet_loss ?? dash], ["Codec", r.codec || dash]])),
      );
    } else parts.push(errorBanner(details.reason));

    if (recs.status === "fulfilled") {
      const list = recs.value.recordings || [];
      parts.push(
        section(
          "Recording",
          list.length ? list.map((rec) => h("div", {}, audioPlayer(rec.recording_url), kv([["Recording ID", copyable(rec.recording_id, false)], ["Length", fmtDuration((rec.recording_duration_ms || 0) / 1000)], ["Format", rec.recording_format || dash]])))
            : h("p", { class: "muted" }, "This call was not recorded."),
        ),
      );
    } else parts.push(section("Recording", errorBanner(recs.reason)));
    body.replaceChildren(...parts);
  });
}

function callsTable(opts = {}) {
  return tableView({
    key: opts.key || "calls",
    title: opts.title || "Call logs",
    tool: "list_call_records",
    mode: "page",
    defaultSize: opts.size || 20,
    pageSizes: opts.pageSizes,
    buildArgs: (f) => {
      const a = {};
      if (f.call_direction) a.call_direction = f.call_direction;
      if (f.hangup_cause) a.hangup_cause = f.hangup_cause.toUpperCase();
      if (f.to_number) a.to_number = f.to_number;
      if (f.start_date || f.end_date) {
        a.start_date = f.start_date || f.end_date;
        a.end_date = f.end_date || f.start_date;
      }
      a.include_summary = false;
      return a;
    },
    rows: (d) => d.records,
    filters: opts.noFilters
      ? []
      : [
          { name: "start_date", label: "From", type: "date" },
          { name: "end_date", label: "To", type: "date" },
          { name: "call_direction", label: "Direction", type: "select", options: [["", "All"], ["outbound", "Outbound"], ["inbound", "Inbound"]] },
          { name: "to_number", label: "To number", placeholder: "+91…", inputmode: "tel" },
          { name: "hangup_cause", label: "Hangup cause", type: "select", options: [["", "Any"], ["NORMAL_CLEARING", "Normal clearing"], ["NO_ANSWER", "No answer"], ["USER_BUSY", "Busy"], ["ORIGINATOR_CANCEL", "Caller cancelled"], ["CALL_REJECTED", "Rejected"]] },
        ],
    columns: [
      { label: "Started", render: (r) => fmtDate(r.start_time) },
      { label: "Direction", render: (r) => badge(r.call_direction, r.call_direction === "inbound" ? "info" : "neutral") },
      { label: "From", render: (r) => party(r.caller_id_number) },
      { label: "To", render: (r) => party(r.destination_number) },
      { label: "Duration", class: "num", render: (r) => fmtDuration(r.duration) },
      { label: "Result", render: (r) => hangupBadge(r.hangup_cause) },
      { label: "Cost", class: "num", render: (r) => fmtMoney(r.total_cost ?? r.cost, r.currency) },
    ],
    empty: { icon: "☏", title: "No call records yet", text: "Calls placed or received on this account will appear here." },
    onRow: (r) => openCall(r.uuid),
  });
}

function statCard(label) {
  const value = h("div", { class: "stat-value" }, h("span", { class: "skeleton lg" }));
  const sub = h("div", { class: "stat-sub" }, h("span", { class: "skeleton sm" }));
  const extra = h("div");
  const el = h("div", { class: "card stat" }, h("div", { class: "stat-label" }, label), value, sub, extra);
  return {
    el,
    set(v, s, x) {
      value.replaceChildren(v);
      sub.replaceChildren(s || "");
      extra.replaceChildren(x || "");
    },
    fail(err) {
      value.replaceChildren(dash);
      sub.replaceChildren(h("span", { class: "stat-error" }, (FRIENDLY[err.kind] || ["Unavailable"])[0]));
      extra.replaceChildren();
    },
  };
}

const views = {
  overview: {
    title: "Overview",
    subtitle: "Live account health and recent activity",
    render(root) {
      const balance = statCard("Available balance");
      const conc = statCard("Concurrent calls");
      const live = statCard("Live calls");
      const totals = statCard("All-time calls");
      root.append(h("div", { class: "stats" }, balance.el, conc.el, live.el, totals.el));
      const recent = callsTable({ key: "overview-calls", title: "Recent calls", noFilters: true, size: 10, pageSizes: [5, 10, 20] });
      root.append(recent.el);
      recent.load();

      tool("get_account_balance", { currency: store.get("vobiz.currency", "INR") })
        .then((d) => {
          const b = d.balance || {};
          balance.set(fmtMoney(b.available_balance ?? b.balance, b.currency), `Balance ${fmtMoney(b.balance, b.currency)}${b.is_postpaid ? " · postpaid" : ""}`, b.status ? badge(b.status) : null);
        })
        .catch((e) => balance.fail(e));
      tool("get_concurrency")
        .then((d) => {
          const c = d.concurrency || {};
          const pct = Math.min(100, Number(c.utilization_pct ?? (c.max_concurrent ? (100 * c.concurrent_calls) / c.max_concurrent : 0)) || 0);
          conc.set(`${fmtNum(c.concurrent_calls)} / ${fmtNum(c.max_concurrent)}`, `${pct}% of limit in use`, h("div", { class: "meter", role: "progressbar", "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100 }, h("span", { style: `width:${pct}%` })));
        })
        .catch((e) => conc.fail(e));
      tool("list_live_calls", { include_queued: true })
        .then((d) => live.set(fmtNum(d.live_count), `${fmtNum(d.queued_count ?? 0)} queued`, d.live_count ? badge("live") : null))
        .catch((e) => live.fail(e));
      tool("list_call_records", { per_page: 1 })
        .then((d) => {
          const s = d.summary || {};
          const rate = typeof s.answerRate === "number" ? `${s.answerRate.toFixed(1)}% answered` : "";
          const avgVal = typeof s.avgCallDuration === "number" ? fmtDuration(s.avgCallDuration) : s.avgCallDuration;
          const avg = avgVal ? ` · avg ${avgVal}` : "";
          totals.set(fmtNum(s.totalCalls ?? d.pagination?.total), rate + avg || "No summary available");
        })
        .catch((e) => totals.fail(e));
    },
  },

  calls: {
    title: "Call logs",
    subtitle: "Completed call detail records",
    render(root) {
      const t = callsTable();
      root.append(t.el);
      t.load();
    },
  },

  numbers: {
    title: "Phone numbers",
    subtitle: "Numbers on this account and its sub-accounts",
    render(root) {
      const t = tableView({
        key: "numbers",
        title: "Phone numbers",
        tool: "list_phone_numbers",
        mode: "page",
        buildArgs: (f) => ({ status: f.status || undefined, search: f.search ? f.search.replace(/[^\d+]/g, "") : undefined }),
        rows: (d) => d.numbers,
        filters: [
          { name: "search", label: "Search", placeholder: "+91 98…", inputmode: "tel" },
          { name: "status", label: "Status", type: "select", options: [["", "All"], ["active", "Active"], ["pending_release", "Pending release"], ["quarantined", "Quarantined"], ["blocked", "Blocked"], ["released", "Released"]] },
        ],
        columns: [
          { label: "Number", render: (n) => h("strong", {}, n.e164 || dash) },
          { label: "Status", render: (n) => badge(n.status) },
          { label: "Country", render: (n) => [n.country, n.region].filter(Boolean).join(" · ") || dash },
          { label: "Voice", render: (n) => (n.voice_enabled === false || n.capabilities?.voice === false ? badge("off", "neutral") : badge("on", "success")) },
          { label: "Monthly fee", class: "num", render: (n) => fmtMoney(n.monthly_fee, n.currency) },
          { label: "Next billing", render: (n) => fmtDate(n.next_billing_date) },
        ],
        empty: { icon: "#", title: "No phone numbers", text: "Numbers purchased on this account will appear here." },
        onRow: (n) =>
          openDrawer(n.e164 || "Phone number", async (body) => {
            const parts = [
              section(
                "Number",
                kv([
                  ["Number", copyable(n.e164, false)],
                  ["Status", badge(n.status)],
                  ["Type", n.number_type || dash],
                  ["Application", n.application_id ? copyable(n.application_id) : dash],
                  ["Sub-account", n.sub_account_id || dash],
                  ["Purchased", fmtDate(n.purchased_at)],
                  ["Setup / monthly fee", `${fmtMoney(n.setup_fee, n.currency)} / ${fmtMoney(n.monthly_fee, n.currency)}`],
                ]),
              ),
            ];
            try {
              const d = await tool("get_number_health", { phone_number: n.e164, days: 30 });
              const hl = d.health || {};
              const s = hl.summary || {};
              parts.push(
                section(
                  "Health (30 days)",
                  kv([
                    ["Spam flagged", hl.is_spam ? badge("flagged", "danger") : badge("clean", "success")],
                    ["Usage status", hl.usage_status || dash],
                    ["Total calls", fmtNum(s.total_calls)],
                    ["Answer rate", s.answer_rate !== undefined ? `${Number(s.answer_rate).toFixed(1)}%` : dash],
                    ["Minutes", fmtNum(s.total_minutes)],
                  ]),
                ),
              );
            } catch (err) {
              parts.push(section("Health", errorBanner(err)));
            }
            body.replaceChildren(...parts);
          }),
      });
      root.append(t.el);
      t.load();
    },
  },

  trunks: {
    title: "SIP trunks",
    subtitle: "Trunk configuration (credentials hidden)",
    render(root) {
      const t = tableView({
        key: "trunks",
        title: "SIP trunks",
        tool: "list_sip_trunks",
        mode: "offset",
        buildArgs: (f) => ({ direction: f.direction || undefined }),
        rows: (d) => d.trunks,
        filters: [{ name: "direction", label: "Direction", type: "select", options: [["", "All"], ["outbound", "Outbound"], ["inbound", "Inbound"], ["both", "Both"]] }],
        columns: [
          { label: "Name", render: (t) => h("strong", {}, t.name || dash) },
          { label: "Status", render: (t) => badge(t.trunk_status) },
          { label: "Direction", render: (t) => badge(t.trunk_direction, "info") },
          { label: "Domain", render: (t) => h("code", {}, t.trunk_domain || dash) },
          { label: "Concurrency", class: "num", render: (t) => fmtNum(t.concurrent_calls_limit) },
          { label: "CPS", class: "num", render: (t) => fmtNum(t.cps_limit) },
        ],
        empty: { icon: "⇄", title: "No SIP trunks found", text: "This account has no SIP trunks configured." },
        onRow: (row) =>
          openDrawer(row.name || "SIP trunk", async (body) => {
            const d = await tool("get_sip_trunk", { trunk_id: row.trunk_id });
            const tr = d.trunk || row;
            body.replaceChildren(
              section(
                "Trunk",
                kv([
                  ["Trunk ID", copyable(tr.trunk_id, false)],
                  ["Status", badge(tr.trunk_status)],
                  ["Direction", tr.trunk_direction || dash],
                  ["Domain", h("code", {}, tr.trunk_domain || dash)],
                  ["Transport", tr.transport || dash],
                  ["Secure", tr.secure ? "Yes" : "No"],
                  ["Recording", tr.recording ? "On" : "Off"],
                  ["Transcription", tr.enable_transcription ? "On" : "Off"],
                  ["Concurrent calls", fmtNum(tr.concurrent_calls_limit)],
                  ["CPS limit", fmtNum(tr.cps_limit)],
                  ["Created", fmtDate(tr.created_at)],
                ]),
              ),
              h("div", { class: "banner info" }, h("span", { class: "banner-icon" }, "i"), h("div", { class: "banner-text" }, "SIP usernames and passwords are hidden by the MCP server. Vobiz has no live trunk health API.")),
            );
          }),
      });
      root.append(t.el);
      t.load();
    },
  },

  recordings: {
    title: "Recordings",
    subtitle: "Call recordings on this account",
    render(root) {
      const t = tableView({
        key: "recordings",
        title: "Recordings",
        tool: "list_recordings",
        mode: "offset",
        pageSizes: [5, 10, 20],
        defaultSize: 20,
        buildArgs: (f) => ({ from_date: f.from_date || undefined, to_date: f.to_date || undefined }),
        rows: (d) => d.recordings,
        filters: [
          { name: "from_date", label: "From", type: "date" },
          { name: "to_date", label: "To", type: "date" },
        ],
        columns: [
          { label: "Recorded", render: (r) => fmtDate(r.add_time) },
          { label: "From", render: (r) => party(r.from_number) },
          { label: "To", render: (r) => party(r.to_number) },
          { label: "Length", class: "num", render: (r) => fmtDuration((r.recording_duration_ms || 0) / 1000) },
          { label: "Type", render: (r) => badge(r.recording_type, "info") },
          { label: "Call", render: (r) => copyable(r.call_uuid) },
        ],
        empty: { icon: "●", title: "No recordings", text: "Recorded calls will appear here. Not every call is recorded." },
        onRow: (r) =>
          openDrawer("Recording", (body) =>
            body.replaceChildren(
              section("Playback", audioPlayer(r.recording_url)),
              section("Details", kv([["Recording ID", copyable(r.recording_id, false)], ["Call UUID", copyable(r.call_uuid, false)], ["Format", r.recording_format || dash], ["Expires", fmtDate(r.expires_at)]])),
              h("div", {}, h("button", { class: "btn btn-secondary", type: "button", onclick: () => r.call_uuid && openCall(r.call_uuid) }, "View call details")),
            ),
          ),
      });
      root.append(t.el);
      t.load();
    },
  },
};

// ── Router, theme, connection ─────────────────────────────────
let current = null;
function show(name) {
  if (!views[name]) name = "overview";
  current = name;
  const v = views[name];
  for (const b of document.querySelectorAll(".nav-item")) {
    if (b.dataset.view === name) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  $("#page-title").textContent = v.title;
  $("#page-subtitle").textContent = v.subtitle;
  document.title = `${v.title} · Vobiz Ops`;
  const root = $("#view");
  root.replaceChildren();
  v.render(root);
  if (location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
}

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $("#theme-toggle").setAttribute("aria-label", t === "dark" ? "Switch to light mode" : "Switch to dark mode");
}

async function checkConnection() {
  const conn = $("#conn");
  try {
    const res = await fetch("/api/health", { headers: { "X-Dashboard-Token": TOKEN } });
    const d = await res.json();
    conn.classList.toggle("ok", !!d.connected);
    conn.classList.toggle("bad", !d.connected);
    $("#conn-text").textContent = d.connected ? `Connected · ${d.server} ${d.version}` : "MCP server disconnected";
    if (!d.connected) $("#global-banner").replaceChildren(errorBanner(new ToolError({ error: "service_unavailable", message: "The vobiz-ops MCP server stopped. Restart `npm run dashboard`." })));
  } catch {
    conn.classList.add("bad");
    $("#conn-text").textContent = "Dashboard offline";
  }
}

// Error boundary: never show raw browser errors; keep the page usable.
window.addEventListener("error", () => toast("Something went wrong in the dashboard. Try refreshing the view.", "error"));
window.addEventListener("unhandledrejection", (e) => {
  e.preventDefault();
  toast(e.reason instanceof ToolError ? e.reason.message : "An unexpected error occurred.", "error");
});

function init() {
  $("#account-id").textContent = AUTH_ID;
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  applyTheme(store.get("vobiz.theme", prefersDark ? "dark" : "light"));
  $("#theme-toggle").addEventListener("click", () => {
    const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(t);
    store.set("vobiz.theme", t);
  });
  $("#nav").addEventListener("click", (e) => {
    const b = e.target.closest(".nav-item");
    if (b) show(b.dataset.view);
  });
  $("#refresh").addEventListener("click", () => {
    show(current);
    toast("Refreshed", "success");
  });
  $("#drawer-close").addEventListener("click", closeDrawer);
  $("#drawer-backdrop").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#drawer").hidden) closeDrawer();
  });
  window.addEventListener("hashchange", () => show(location.hash.slice(1)));
  checkConnection();
  show(location.hash.slice(1) || "overview");
}

init();
