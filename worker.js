var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var ENV = {};
var TURSO_URL = "";
var TURSO_TOKEN = "";
var PAYPAL_CLIENT_ID = "";
var PAYPAL_CLIENT_SECRET = "";
var PAYPAL_API = "";
var _apiCache = /* @__PURE__ */ new Map();
var DASHBOARD_TTL = 6e4;
var VENDORS_TTL = 8e3;
var STORE_TTL = 1e4;
var STORE_ITEM_TTL = 1e4;
var STORE_REVIEWS_TTL = 1e4;
var VISITORS_TTL = 6e4;
function allowedOrigin(env, reqOrigin) {
  const allowed = env.ORIGIN;
  if (!allowed) return reqOrigin || "*";
  const set = allowed.split(",").map((s) => s.trim()).filter(Boolean);
  return set.includes(reqOrigin) ? reqOrigin : set[0];
}
__name(allowedOrigin, "allowedOrigin");
var CORS = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};
var SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(self)"
};
function buildCors(env, reqOrigin) {
  const origin = allowedOrigin(env, reqOrigin);
  return Object.assign({}, CORS, { "Access-Control-Allow-Origin": origin, "Vary": "Origin" });
}
__name(buildCors, "buildCors");
function jsonResponse(status, obj, extra) {
  const reqOrigin = extra && extra.__reqOrigin || null;
  const headers = Object.assign(
    { "Content-Type": "application/json" },
    buildCors(ENV, reqOrigin),
    SECURITY_HEADERS,
    extra || {}
  );
  delete headers.__reqOrigin;
  return new Response(JSON.stringify(obj), { status, headers });
}
__name(jsonResponse, "jsonResponse");
var SESSION_TTL_MS = 1e3 * 60 * 60 * 12;
function sessionSecret() {
  return ENV.SESSION_SECRET || ENV.ADMIN_PASS || "insecure-dev-secret";
}
__name(sessionSecret, "sessionSecret");
function b64urlEncode(str) {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(b64urlEncode, "b64urlEncode");
function b64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return atob(str);
}
__name(b64urlDecode, "b64urlDecode");
async function hmacSign(message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(sessionSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return b64urlEncode(String.fromCharCode(...new Uint8Array(sig)));
}
__name(hmacSign, "hmacSign");
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
__name(timingSafeEqual, "timingSafeEqual");
async function createSession() {
  const iat = Date.now();
  const exp = iat + SESSION_TTL_MS;
  const payload = b64urlEncode(JSON.stringify({ iat, exp }));
  const sig = await hmacSign(payload);
  return payload + "." + sig;
}
__name(createSession, "createSession");
async function verifySession(header) {
  if (!header || !header.startsWith("Bearer ")) return false;
  const token = header.slice(7);
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const expected = await hmacSign(payload);
  if (!timingSafeEqual(sig, expected)) return false;
  try {
    const data = JSON.parse(b64urlDecode(payload));
    if (!data.exp || data.exp < Date.now()) return false;
    return true;
  } catch (e) {
    return false;
  }
}
__name(verifySession, "verifySession");
function isValidSession(header) {
  return verifySession(header);
}
__name(isValidSession, "isValidSession");
var LOGIN_ATTEMPTS = /* @__PURE__ */ new Map();
var LOGIN_MAX_ATTEMPTS = 5;
var LOGIN_WINDOW_MS = 1e3 * 60 * 10;
function loginThrottled(key) {
  const now = Date.now();
  const rec = LOGIN_ATTEMPTS.get(key);
  if (!rec || now - rec.first > LOGIN_WINDOW_MS) {
    LOGIN_ATTEMPTS.set(key, { count: 1, first: now });
    return false;
  }
  rec.count += 1;
  if (rec.count > LOGIN_MAX_ATTEMPTS) return true;
  return false;
}
__name(loginThrottled, "loginThrottled");
function toTursoArgs(args) {
  return (args || []).map((a) => {
    if (a && typeof a === "object" && a.type && "value" in a) return a;
    if (a === null || a === void 0) return { type: "null", value: "" };
    if (typeof a === "number") return { type: "float", value: a };
    return { type: "text", value: String(a) };
  });
}
__name(toTursoArgs, "toTursoArgs");
async function tursoRequest(bodyObj) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15e3);
  try {
    const res = await fetch(TURSO_URL + "/v2/pipeline", {
      method: "POST",
      headers: { "Authorization": "Bearer " + TURSO_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(bodyObj),
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error("Turso " + res.status + ": " + await res.text());
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
__name(tursoRequest, "tursoRequest");
async function tursoPipeline(statements) {
  const body = { requests: statements.map((s) => ({ type: "execute", stmt: { sql: s.sql, args: toTursoArgs(s.args) } })) };
  const data = await tursoRequest(body);
  return data.results.map((r) => {
    if (r.type === "error") throw new Error(r.error.message);
    const result = r.response && r.response.result;
    if (!result || !result.rows) return [];
    return result.rows.map((row) => {
      const cells = Array.isArray(row) ? row : row.value || row;
      const obj = {};
      result.cols.forEach((col, i) => {
        const cell = cells[i];
        if (!cell || cell.type === "null") {
          obj[col.name] = null;
          return;
        }
        try {
          obj[col.name] = JSON.parse(cell.value);
        } catch (e) {
          obj[col.name] = cell.value;
        }
      });
      return obj;
    });
  });
}
__name(tursoPipeline, "tursoPipeline");
async function tursoExecute(sql, args) {
  await tursoRequest({ requests: [{ type: "execute", stmt: { sql, args: toTursoArgs(args) } }] });
}
__name(tursoExecute, "tursoExecute");
function cachedJson(key, ttlMs, builder) {
  const hit = _apiCache.get(key), nowTs = Date.now();
  if (hit && nowTs - hit.ts < ttlMs) return jsonResponse(200, hit.data);
  return builder().then((data) => {
    _apiCache.set(key, { ts: Date.now(), data });
    return jsonResponse(200, data);
  }).catch((err) => hit ? jsonResponse(200, hit.data) : jsonResponse(500, { error: err.message }));
}
__name(cachedJson, "cachedJson");
async function buildDashboard() {
  const now = /* @__PURE__ */ new Date(), currentMonth = now.toISOString().slice(0, 7);
  const last = new Date(now);
  last.setMonth(last.getMonth() - 1);
  const lastMonthStr = last.toISOString().slice(0, 7);
  const r = await tursoPipeline([
    { sql: "SELECT COUNT(CASE WHEN status IN ('Available','Listed') THEN 1 END) as active, COALESCE(SUM(cost),0) as cost, COALESCE(SUM(price),0) as listed, COUNT(CASE WHEN status='Processing' THEN 1 END) as pending FROM items" },
    { sql: "SELECT item_number, sku, title, category, condition, status, cost, price, quantity, date_listed, date_sold FROM items ORDER BY date_listed DESC LIMIT 15" },
    { sql: "SELECT COUNT(*) as sold FROM items WHERE status='Sold' AND date_sold LIKE ?", args: [currentMonth + "%"] },
    { sql: "SELECT COALESCE(SUM(price-cost-fees),0) as profit FROM items WHERE status='Sold' AND date_sold LIKE ?", args: [currentMonth + "%"] },
    { sql: "SELECT items, profit FROM monthly_goals WHERE month = ?", args: [currentMonth] },
    { sql: "SELECT COUNT(*) as sold FROM items WHERE status='Sold' AND date_sold LIKE ?", args: [lastMonthStr + "%"] },
    { sql: "SELECT COALESCE(SUM(price-cost-fees),0) as profit FROM items WHERE status='Sold' AND date_sold LIKE ?", args: [lastMonthStr + "%"] },
    { sql: "SELECT date_sold as day, COUNT(*) as count, SUM(price-cost-fees) as profit FROM items WHERE date_sold >= date('now', '-30 days') AND status='Sold' GROUP BY date_sold ORDER BY day" },
    { sql: "SELECT condition, COUNT(*) as count FROM items WHERE condition IS NOT NULL GROUP BY condition" },
    { sql: "SELECT v.name, v.vendor_id, COUNT(i.item_number) as items_sold, COALESCE(SUM(i.price - i.cost - i.fees),0) as profit FROM vendors v LEFT JOIN items i ON i.vendor_id = v.vendor_id AND i.status='Sold' GROUP BY v.vendor_id, v.name ORDER BY profit DESC LIMIT 5" },
    { sql: "SELECT COALESCE(SUM(amount),0) as total, type FROM expenses WHERE expense_date >= date('now', '-30 days') GROUP BY type ORDER BY total DESC LIMIT 1" },
    { sql: "SELECT item_number, title FROM items WHERE status IN ('Available','Listed') AND date_listed <= date('now', '-45 days') LIMIT 3" },
    { sql: "SELECT item_number, title, price, cost FROM items WHERE status='Available' AND (price - cost) <= 0 LIMIT 3" },
    { sql: "SELECT item_number, title FROM items WHERE has_photos=0 AND status IN ('Available','Listed') LIMIT 3" },
    // KPI additions
    { sql: "SELECT COALESCE(AVG(price - cost - fees),0) as avg_margin, COALESCE(SUM(cost),0) as sold_cost FROM items WHERE status='Sold' AND date_sold LIKE ?", args: [currentMonth + "%"] },
    { sql: "SELECT COALESCE(SUM(price - cost - fees),0) as ytd_profit FROM items WHERE status='Sold' AND date_sold >= ?", args: [currentMonth.slice(0, 4) + "-01-01"] },
    // Operating expenses for the same periods — subtracted from net profit so the
    // dashboard reflects true financials (packaging, shipping supplies, platform
    // subscriptions, ad spend, etc. logged in the expenses table).
    { sql: "SELECT COALESCE(SUM(amount),0) as expenses FROM expenses WHERE expense_date LIKE ?", args: [currentMonth + "%"] },
    { sql: "SELECT COALESCE(SUM(amount),0) as expenses FROM expenses WHERE expense_date >= ?", args: [currentMonth.slice(0, 4) + "-01-01"] },
    // Top 10 selling brands by items sold (extracted from SKU first segment or item title first word)
    { sql: "SELECT CASE WHEN sku IS NOT NULL AND sku != '' AND instr(sku, '-') > 0 THEN substr(sku, 1, instr(sku, '-') - 1) WHEN title IS NOT NULL AND title != '' THEN substr(title, 1, instr(title || ' ', ' ') - 1) ELSE 'Unknown' END as brand, COUNT(*) as items_sold, COALESCE(SUM(price),0) as revenue FROM items WHERE status='Sold' GROUP BY brand ORDER BY items_sold DESC LIMIT 10" },
    // Top 5 selling item titles by units sold
    { sql: "SELECT title, COUNT(*) as items_sold, COALESCE(SUM(price),0) as revenue FROM items WHERE status='Sold' AND title IS NOT NULL AND title != '' GROUP BY title ORDER BY items_sold DESC LIMIT 5" },
    // Top 5 selling sizes by units sold (derived from title text without relying on a missing size column)
    { sql: "SELECT CASE WHEN title IS NOT NULL AND title != '' THEN trim(replace(replace(replace(title, 'Size:', ''), 'Size', ''), ':', '')) ELSE 'Unknown' END as size, COUNT(*) as items_sold, COALESCE(SUM(price),0) as revenue FROM items WHERE status='Sold' GROUP BY size ORDER BY items_sold DESC LIMIT 5" },
    // Lifetime performance data (all sold items, all time)
    { sql: "SELECT (SELECT COALESCE(SUM(price),0) FROM items WHERE status='Sold') as total_revenue, (SELECT COALESCE(SUM(cost),0) FROM items WHERE status='Sold') as total_cost, (SELECT COALESCE(SUM(fees),0) FROM items WHERE status='Sold') as total_fees, (SELECT COALESCE(SUM(amount),0) FROM expenses) as total_expenses, (SELECT COALESCE(SUM(price-cost-fees),0) FROM items WHERE status='Sold') - (SELECT COALESCE(SUM(amount),0) FROM expenses) as lifetime_profit" },
    { sql: "SELECT category, COUNT(*) as count, COALESCE(SUM(price),0) as revenue, COALESCE(SUM(price-cost-fees),0) as profit FROM items WHERE status='Sold' GROUP BY category ORDER BY profit DESC" }
  ]);
  const kpis = r[0][0] || { active: 0, cost: 0, listed: 0, pending: 0 };
  const goalRow = r[4][0];
  const goal = goalRow ? { items: goalRow.items || 0, profit: goalRow.profit || 0 } : { items: 0, profit: 0 };
  const marginRow = r[14][0] || { avg_margin: 0, sold_cost: 0 };
  const monthlyItemProfit = r[3][0] ? r[3][0].profit || 0 : 0;
  const monthlyExpenses = r[16][0] ? r[16][0].expenses || 0 : 0;
  const monthlyProfitVal = monthlyItemProfit - monthlyExpenses;
  const soldCost = marginRow.sold_cost || 0;
  const avgMargin = marginRow.avg_margin || 0;
  const monthlyRoi = soldCost > 0 ? monthlyProfitVal / soldCost * 100 : 0;
  const ytdItemProfit = r[15][0] ? r[15][0].ytd_profit || 0 : 0;
  const ytdExpenses = r[17][0] ? r[17][0].expenses || 0 : 0;
  const ytdProfit = ytdItemProfit - ytdExpenses;
  kpis.avgMargin = avgMargin;
  kpis.monthlyRoi = monthlyRoi;
  kpis.ytdProfit = ytdProfit;
  kpis.monthlyItemProfit = monthlyItemProfit;
  kpis.monthlyExpenses = monthlyExpenses;
  kpis.ytdItemProfit = ytdItemProfit;
  kpis.ytdExpenses = ytdExpenses;
  const stale = r[11], low = r[12], nophotos = r[13];
  const alerts = stale.map((i) => ({ type: "stale", item: i.item_number, text: i.title })).concat(low.map((i) => ({ type: "margin", item: i.item_number, text: i.title }))).concat(nophotos.map((i) => ({ type: "photos", item: i.item_number, text: i.title })));
  return { kpis: [kpis], items: r[1], orders: [], soldItems: r[2][0] ? r[2][0].sold : 0, monthlyProfit: monthlyProfitVal, goal, lastMonthSold: r[5][0] ? r[5][0].sold : 0, lastMonthProfit: r[6][0] ? r[6][0].profit : 0, salesTrend: r[7], health: r[8], vendors: r[9], expenses30: r[10][0] || { total: 0, type: "\u2014" }, alerts, topBrands: (r[18] || []).map(function(row) {
    return { name: row.brand || "Unknown", items_sold: row.items_sold || 0, revenue: row.revenue || 0 };
  }), topTitles: (r[19] || []).map(function(row) {
    return { name: row.title || "Untitled", items_sold: row.items_sold || 0, revenue: row.revenue || 0 };
  }), topSizes: (r[20] || []).map(function(row) {
    return { name: row.size || "\u2014", items_sold: row.items_sold || 0, revenue: row.revenue || 0 };
  }), lifetime: r[21] && r[21][0] ? r[21][0] : { total_revenue: 0, total_cost: 0, total_fees: 0, total_expenses: 0, lifetime_profit: 0 }, lifetimeCategories: r[22] || [] };
}
__name(buildDashboard, "buildDashboard");
async function buildVendors() {
  const r = await tursoPipeline([
    { sql: "SELECT * FROM vendors ORDER BY name" },
    { sql: "SELECT v.vendor_id, v.name, COUNT(DISTINCT i.item_number) as items_purchased, COALESCE(SUM(i.cost),0) as total_spent, COALESCE(AVG(i.price - i.cost - i.fees),0) as avg_profit_per_item, COALESCE(SUM(i.price - i.cost - i.fees),0) as total_profit, AVG(julianday(i.date_sold) - julianday(i.date_listed)) as avg_days_to_sell FROM vendors v LEFT JOIN items i ON i.vendor_id = v.vendor_id GROUP BY v.vendor_id, v.name" }
  ]);
  return { vendors: r[0], performance: r[1] };
}
__name(buildVendors, "buildVendors");
async function buildInventory() {
  const r = await tursoPipeline([{ sql: "SELECT item_number, sku, title, category, condition, status, cost, price, quantity, date_listed, date_sold FROM items ORDER BY date_listed DESC LIMIT 500" }]);
  return { items: r[0] };
}
__name(buildInventory, "buildInventory");
async function buildOrders() {
  const r = await tursoPipeline([{ sql: "SELECT orders.*, items.date_sold FROM orders LEFT JOIN items INDEXED BY idx_items_itemnum_datesold ON orders.item_number = items.item_number ORDER BY orders.rowid DESC LIMIT 500" }]);
  return { orders: r[0] };
}
__name(buildOrders, "buildOrders");
async function buildExpenses() {
  const r = await tursoPipeline([{ sql: "SELECT e.*, i.sku as item_sku FROM expenses e LEFT JOIN items i ON e.item_number = i.item_number ORDER BY expense_date DESC LIMIT 500" }]);
  return { expenses: r[0] };
}
__name(buildExpenses, "buildExpenses");
async function buildReviews() {
  const r = await tursoPipeline([{ sql: "SELECT * FROM reviews ORDER BY created_at DESC LIMIT 500" }]);
  return { reviews: r[0] };
}
__name(buildReviews, "buildReviews");
async function buildStore() {
  const r = await tursoPipeline([
    { sql: "SELECT item_number, sku, title, category, condition, status, price, quantity, date_listed, featured FROM items WHERE status = 'Listed' ORDER BY date_listed DESC" },
    { sql: "SELECT item_number, sku, title, category, condition, status, price, quantity, date_listed, featured FROM items WHERE status = 'Sold' ORDER BY date_sold DESC LIMIT 12" },
    { sql: "SELECT review_id, item_number, customer_name, rating, comment, platform, status, created_at FROM reviews WHERE status = 'Approved' ORDER BY created_at DESC LIMIT 6" },
    { sql: "SELECT COUNT(*) as total, COALESCE(AVG(rating),0) as avg_rating FROM reviews WHERE status = 'Approved'" }
  ]);
  const s = r[3][0] || {};
  return { items: r[0], soldItems: r[1], reviews: r[2], reviewStats: { total: s.total || 0, avgRating: parseFloat(s.avg_rating || 0).toFixed(1) } };
}
__name(buildStore, "buildStore");
async function buildStoreFeatured() {
  const r = await tursoPipeline([
    { sql: "SELECT item_number, sku, title, category, condition, status, price, quantity, date_listed, featured FROM items WHERE status = 'Listed' AND featured = 1 ORDER BY date_listed DESC" }
  ]);
  return { items: r[0] };
}
__name(buildStoreFeatured, "buildStoreFeatured");
async function buildStoreItem(itemNumber) {
  if (!itemNumber) return { item: null };
  const r = await tursoPipeline([{ sql: "SELECT item_number, sku, title, category, condition, status, price, quantity, description, photos FROM items WHERE item_number = ?", args: [itemNumber] }]);
  return { item: r[0][0] || null };
}
__name(buildStoreItem, "buildStoreItem");
async function buildStoreReviews(page, limit) {
  const p = Math.max(1, parseInt(page) || 1), l = Math.max(1, parseInt(limit) || 9), offset = (p - 1) * l;
  const r = await tursoPipeline([
    { sql: "SELECT review_id, item_number, customer_name, rating, comment, platform, created_at FROM reviews WHERE status = 'Approved' ORDER BY created_at DESC LIMIT ? OFFSET ?", args: [{ type: "integer", value: String(l) }, { type: "integer", value: String(offset) }] },
    { sql: "SELECT COUNT(*) as cnt FROM reviews WHERE status = 'Approved'", args: [] }
  ]);
  return { reviews: r[0], total: r[1][0] && r[1][0].cnt || 0 };
}
__name(buildStoreReviews, "buildStoreReviews");
function getPayPalAccessToken() {
  return fetch(PAYPAL_API + "/v1/oauth2/token", {
    method: "POST",
    headers: { "Authorization": "Basic " + btoa(PAYPAL_CLIENT_ID + ":" + PAYPAL_CLIENT_SECRET), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials"
  }).then((res) => res.json());
}
__name(getPayPalAccessToken, "getPayPalAccessToken");
function b64ToBytes(b64) {
  const bin = atob(b64), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
__name(b64ToBytes, "b64ToBytes");
async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}
__name(readJson, "readJson");
async function sha256Hex(text) {
  try {
    const data = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return "fallback-" + text.length.toString(16);
  }
}
__name(sha256Hex, "sha256Hex");
async function dailyIpHash(ip) {
  const day = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const salt = ENV.VISIT_SALT || "mulligan-visit";
  return sha256Hex((ip || "unknown") + "|" + day + "|" + salt);
}
__name(dailyIpHash, "dailyIpHash");
function escapeHtmlEmail(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
__name(escapeHtmlEmail, "escapeHtmlEmail");
async function sendEmail(env, opts) {
  if (!env.RESEND_API_KEY || !env.FROM_EMAIL || !opts || !opts.to) return { ok: false, skipped: true };
  try {
    const payload = {
      from: env.FROM_EMAIL,
      to: Array.isArray(opts.to) ? opts.to : [opts.to],
      subject: opts.subject || "",
      html: opts.html || ""
    };
    if (opts.replyTo) payload.reply_to = opts.replyTo;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
__name(sendEmail, "sendEmail");
async function sendOrderStatusEmail(env, opts) {
  const to = opts.to;
  if (!to) return { ok: false, skipped: true };
  const status = (opts.status || "").toLowerCase();
  let subject, heading, message;
  if (status === "shipped") {
    subject = "Your Mulligan Market order has shipped";
    heading = "Your order is on the way!";
    message = "Good news \u2014 your Mulligan Market order has been shipped and is headed your way.";
  } else if (status === "delivered") {
    subject = "Your Mulligan Market order has been delivered";
    heading = "Your order has arrived!";
    message = "Your Mulligan Market order has been delivered. We hope it hits the course as hard as you do.";
  } else {
    return { ok: false, skipped: true };
  }
  const itemLines = Array.isArray(opts.items) ? opts.items.map(function(it) {
    const nm = it.name || it.item_number || "Item";
    return '<li style="margin:2px 0">' + escapeHtmlEmail(nm) + (it.item_number ? ' <span style="color:#888;font-size:12px">(' + escapeHtmlEmail(it.item_number) + ")</span>" : "") + "</li>";
  }).join("") : "";
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;color:#111;line-height:1.5;max-width:520px"><h2 style="color:#dc2626;margin:0 0 8px">' + escapeHtmlEmail(heading) + "</h2><p>" + escapeHtmlEmail(message) + "</p>" + (opts.orderLabel ? '<p style="font-size:13px;color:#666">Order: ' + escapeHtmlEmail(opts.orderLabel) + "</p>" : "") + (itemLines ? '<ul style="font-size:14px;padding-left:18px;margin:8px 0">' + itemLines + "</ul>" : "") + (opts.tracking ? '<p style="font-size:13px;color:#444"><b>Tracking #:</b> ' + escapeHtmlEmail(opts.tracking) + "</p>" : "") + `<p style="margin-top:16px;color:#666;font-size:13px">Questions? Reply to this email and we'll help.</p><p style="margin-top:8px;color:#666;font-size:13px">\u2014 Mr. Mulligan<br>Mulligan Market \u2014 Where Every Item Deserves a Second Shot<br><a href="https://www.mulliganmarket.com">www.mulliganmarket.com</a></p></div>`;
  return sendEmail(env, { to, subject, html, replyTo: env.NOTIFY_EMAIL || void 0 });
}
__name(sendOrderStatusEmail, "sendOrderStatusEmail");
var worker_default = {
  async fetch(request, env, ctx) {
    ENV = env;
    TURSO_URL = env.TURSO_URL || "";
    TURSO_TOKEN = env.TURSO_TOKEN || "";
    PAYPAL_CLIENT_ID = env.PAYPAL_CLIENT_ID || "";
    PAYPAL_CLIENT_SECRET = env.PAYPAL_CLIENT_SECRET || "";
    PAYPAL_API = env.PAYPAL_API || "https://api-m.sandbox.paypal.com";
    const url = new URL(request.url), path = url.pathname;
    const reqOrigin = request.headers.get("Origin");
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: Object.assign({}, buildCors(env, reqOrigin), SECURITY_HEADERS) });
    }
    if (request.method === "POST" && path === "/api/admin/login") {
      try {
        const clientIp = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
        const throttleKey = "login:" + clientIp;
        if (loginThrottled(throttleKey)) {
          return jsonResponse(429, { ok: false, error: "Too many attempts. Try again later." }, { __reqOrigin: reqOrigin });
        }
        const { username, password } = await readJson(request);
        if (username === env.ADMIN_USER && password === env.ADMIN_PASS) {
          LOGIN_ATTEMPTS.delete(throttleKey);
          const token = await createSession();
          return jsonResponse(200, { ok: true, token, expiresIn: SESSION_TTL_MS }, { __reqOrigin: reqOrigin });
        }
        return jsonResponse(401, { ok: false, error: "Invalid credentials" }, { __reqOrigin: reqOrigin });
      } catch (err) {
        return jsonResponse(500, { ok: false, error: err.message }, { __reqOrigin: reqOrigin });
      }
    }
    if (request.method === "GET" && path === "/api/admin/login-page") {
      try {
        const assetReq = new Request(new URL("/admin.html", request.url).toString(), request);
        const assetResp2 = await env.ASSETS.fetch(assetReq, { redirect: "follow" });
        if (!assetResp2.ok) return new Response("Not found", { status: 404 });
        const body = await assetResp2.text();
        const headers = new Headers(assetResp2.headers);
        headers.set("Content-Type", "text/html; charset=utf-8");
        headers.set("Content-Security-Policy", "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com https://unpkg.com; script-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com https://cdn.tailwindcss.com https://unpkg.com; connect-src 'self'; font-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; frame-ancestors 'none'; base-uri 'self'");
        headers.set("Cache-Control", "no-store");
        return new Response(body, { status: 200, headers });
      } catch (err) {
        return new Response("Admin page error", { status: 500 });
      }
    }
    if (request.method === "GET" && (path === "/app" || path === "/hq")) {
      const target = new URL("/api/admin/login-page", request.url).toString();
      return Response.redirect(target, 302);
    }
    if (request.method === "POST" && path === "/api/admin/logout") {
      return jsonResponse(200, { ok: true }, { __reqOrigin: reqOrigin });
    }
    if (request.method === "POST" && path === "/api/admin/extend") {
      const auth = request.headers.get("Authorization") || "";
      if (!await verifySession(auth)) return jsonResponse(401, { error: "Unauthorized" }, { __reqOrigin: reqOrigin });
      let remaining = 0;
      try {
        const data = JSON.parse(b64urlDecode(auth.replace(/^Bearer /, "").split(".")[0]));
        remaining = data.exp ? Math.max(0, data.exp - Date.now()) : 0;
      } catch (e) {
      }
      return jsonResponse(200, { ok: true, expiresIn: remaining }, { __reqOrigin: reqOrigin });
    }
    if (request.method === "GET" && path.startsWith("/api/image")) {
      const itemNumber = url.searchParams.get("item");
      if (!itemNumber) return new Response("Missing item", { status: 400 });
      try {
        const data = await tursoRequest({ requests: [{ type: "execute", stmt: { sql: "SELECT photos FROM items WHERE item_number = ?", args: [{ type: "text", value: itemNumber }] } }] });
        const row = data.results?.[0]?.response?.result?.rows?.[0];
        const photoCell = row ? row[0] : null;
        let photos = [];
        if (photoCell && photoCell.value) {
          try {
            photos = JSON.parse(photoCell.value);
          } catch {
          }
        }
        const photo = Array.isArray(photos) ? photos[0] : "";
        if (!photo) return new Response("", { status: 204 });
        const m = photo.match(/^data:([^;]+);base64,(.+)$/);
        if (!m) return new Response("", { status: 204 });
        const bytes = b64ToBytes(m[2]);
        if (!bytes || bytes.length < 100) return new Response("", { status: 204 });
        return new Response(bytes, { status: 200, headers: { "Content-Type": m[1], "Cache-Control": "public, max-age=3600" } });
      } catch {
        return new Response("Image error", { status: 500 });
      }
    }
    if (request.method === "GET" && path.startsWith("/api/dashboard")) return cachedJson("dashboard", DASHBOARD_TTL, buildDashboard);
    if (request.method === "GET" && path.startsWith("/api/vendors")) return cachedJson("vendors", VENDORS_TTL, buildVendors);
    if (request.method === "GET" && path.startsWith("/api/inventory")) return cachedJson("inventory", 8e3, buildInventory);
    if (request.method === "GET" && path.startsWith("/api/orders")) return cachedJson("orders", 8e3, buildOrders);
    if (request.method === "GET" && path.startsWith("/api/expenses")) return cachedJson("expenses", 8e3, buildExpenses);
    if (request.method === "GET" && path.startsWith("/api/reviews")) return cachedJson("reviews", 8e3, buildReviews);
    if (request.method === "GET" && path.startsWith("/api/store/item")) {
      const item = url.searchParams.get("item");
      return cachedJson("store-item:" + (item || ""), STORE_ITEM_TTL, () => buildStoreItem(item));
    }
    if (request.method === "GET" && path.startsWith("/api/store/reviews")) {
      const page = parseInt(url.searchParams.get("page")) || 1, limit = parseInt(url.searchParams.get("limit")) || 9;
      return cachedJson("store-reviews:" + page + ":" + limit, STORE_REVIEWS_TTL, () => buildStoreReviews(page, limit));
    }
    if (request.method === "GET" && path.startsWith("/api/store/review-stats")) return cachedJson("store-review-stats", STORE_REVIEWS_TTL, async () => {
      const r = await tursoPipeline([{ sql: "SELECT COUNT(*) as total, COALESCE(AVG(rating),0) as avg_rating FROM reviews WHERE status = 'Approved'" }]);
      const s = r[0][0] || {};
      return { total: s.total || 0, avgRating: parseFloat(s.avg_rating || 0).toFixed(1) };
    });
    if (request.method === "GET" && path.startsWith("/api/store/featured")) return cachedJson("store-featured", STORE_TTL, buildStoreFeatured);
    if (request.method === "GET" && path.startsWith("/api/store")) return cachedJson("store", STORE_TTL, buildStore);
    if (request.method === "GET" && path.startsWith("/api/config")) {
      return jsonResponse(200, {
        paypalClientId: PAYPAL_CLIENT_ID,
        paypalCurrency: PAYPAL_API.includes("sandbox") ? "USD" : "USD",
        paypalConfigured: !!PAYPAL_CLIENT_ID && PAYPAL_CLIENT_ID !== "YOUR_PAYPAL_CLIENT_ID"
      });
    }
    if (request.method === "POST" && path === "/api/admin/generate-description") {
      const auth = request.headers.get("Authorization") || "";
      if (!await isValidSession(auth)) return jsonResponse(401, { error: "Unauthorized" });
      try {
        if (!env.AI || typeof env.AI.run !== "function") {
          return jsonResponse(502, { description: "", error: "AI binding unavailable" });
        }
        const body = await readJson(request);
        const clean = /* @__PURE__ */ __name((v) => String(v == null ? "" : v).replace(/[\r\n]+/g, " ").trim(), "clean");
        const name = clean(body.name || body.title || body.type);
        const size = clean(body.size);
        const category = clean(body.category);
        const condition = clean(body.condition);
        const details = [
          name && "Item name: " + name + ".",
          size && "Size: " + size + ".",
          category && "Category: " + category + ".",
          condition && "Condition: " + condition + "."
        ].filter(Boolean).join(" ");
        const hooks = ["on-course performance", "everyday comfort", "style and confidence", "durability and feel", "fit and freedom of movement", "tour-inspired design", "weather-ready play", "premium touch and finish"];
        const hook = hooks[Math.floor(Math.random() * hooks.length)];
        const system = `You are a creative golf retail copywriter. Write product descriptions. Rules: exactly 2 sentences, 25-40 words. Describe only the item's features and the golfer's benefit. No mention of vendor, seller, price, cost, or sourcing/inspection. Each description must be unique \u2014 never reuse the same phrasing across items. Reply with ONLY the final description text. Never show drafts, revisions, or "Changed to:" steps.`;
        const user = "Write a short product description for this golf item, emphasizing " + hook + ". " + details + " Start with the item name" + (size ? " and size" : "") + ". Be specific, original, and varied \u2014 avoid generic filler.";
        const models = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct"];
        let out = null, lastErr = "";
        for (const model of models) {
          try {
            out = await env.AI.run(model, { messages: [{ role: "system", content: system }, { role: "user", content: user }] });
            break;
          } catch (e) {
            lastErr = e.message;
          }
        }
        if (!out) return jsonResponse(502, { description: "", error: lastErr || "AI model unavailable" });
        let text = "";
        if (out != null) {
          if (typeof out === "string") text = out;
          else text = out.response || out.result || out.text || out.output_text || "";
        }
        text = String(text);
        const segments = text.split(/\n|changed to:|revised to:|->|→/i).map((s) => s.trim()).filter(Boolean);
        text = segments.length ? segments[segments.length - 1] : text.trim();
        text = text.replace(/^(description|final|result)\s*[:\-]\s*/i, "").trim();
        text = text.replace(/^["']|["']$/g, "").trim();
        if (text.length > 400) text = text.slice(0, 400).trim().replace(/[.,;:]+$/, "") + ".";
        return jsonResponse(200, { description: text });
      } catch (err) {
        return jsonResponse(502, { description: "", error: err.message });
      }
    }
    if (request.method === "POST" && path === "/api/visit") {
      try {
        const body = await readJson(request);
        const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "";
        const ipHash = await dailyIpHash(ip);
        const pathVal = String(body.path || "/").slice(0, 256);
        const ua = (request.headers.get("User-Agent") || "").slice(0, 512);
        const ref = (request.headers.get("Referer") || "").slice(0, 512);
        await tursoExecute("CREATE TABLE IF NOT EXISTS visits (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT, ip_hash TEXT, user_agent TEXT, referrer TEXT, created_at TEXT DEFAULT (datetime('now')))");
        await tursoExecute("INSERT INTO visits (path, ip_hash, user_agent, referrer, created_at) VALUES (?, ?, ?, ?, datetime('now'))", [pathVal, ipHash, ua, ref]);
        return new Response(null, { status: 204, headers: Object.assign({}, buildCors(env, reqOrigin), SECURITY_HEADERS) });
      } catch (e) {
        console.warn("Visit tracking insert failed:", e && e.message);
        return new Response(null, { status: 204, headers: Object.assign({}, buildCors(env, reqOrigin), SECURITY_HEADERS) });
      }
    }
    if (request.method === "GET" && path === "/api/admin/visitors") {
      const auth = request.headers.get("Authorization") || "";
      if (!await isValidSession(auth)) return jsonResponse(401, { error: "Unauthorized" }, { __reqOrigin: reqOrigin });
      return cachedJson("admin-visitors", VISITORS_TTL, async () => {
        await tursoExecute("CREATE TABLE IF NOT EXISTS visits (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT, ip_hash TEXT, user_agent TEXT, referrer TEXT, created_at TEXT DEFAULT (datetime('now')))");
        const r = await tursoPipeline([
          { sql: "SELECT COUNT(*) as visits, COUNT(DISTINCT ip_hash) as unique_visitors FROM visits WHERE created_at >= datetime('now', '-4 hours')" },
          { sql: "SELECT date(created_at) as day, COUNT(*) as visits FROM visits WHERE created_at >= date('now', '-6 days') GROUP BY date(created_at) ORDER BY day" }
        ]);
        const last4hrs = r[0][0] || { visits: 0, unique_visitors: 0 };
        const last7 = (r[1] || []).map((row) => ({ day: row.day, visits: row.visits }));
        return { today: { visits: last4hrs.visits || 0, uniqueVisitors: last4hrs.unique_visitors || 0 }, last7 };
      });
    }
    if (request.method === "POST" && path === "/api/turso") {
      const auth = request.headers.get("Authorization") || "";
      if (!await isValidSession(auth)) return jsonResponse(401, { error: "Unauthorized" });
      try {
        const payload = JSON.parse(await request.text());
        const stmts = Array.isArray(payload) ? payload : payload && Array.isArray(payload.requests) ? payload.requests : null;
        if (stmts) {
          for (const s of stmts) {
            const sql = (s && (s.sql || s.stmt && s.stmt.sql || "") || "").toString();
            if (/;\s*\S/.test(sql)) return jsonResponse(400, { error: "Multiple statements are not allowed" });
            if (/(--|\/\*|\*\/)/.test(sql)) return jsonResponse(400, { error: "SQL comments are not allowed" });
            if (/\b(DROP|TRUNCATE|ATTACH|DETACH|PRAGMA)\b/i.test(sql)) return jsonResponse(400, { error: "Destructive/structural statements are not allowed" });
            if (/\bALTER\b/i.test(sql) && !/^\s*ALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN\b/i.test(sql)) return jsonResponse(400, { error: "Only ALTER TABLE ... ADD COLUMN is allowed" });
          }
        }
        const data = await tursoRequest(payload);
        return jsonResponse(200, data);
      } catch (err) {
        return jsonResponse(500, { error: err.message });
      }
    }
    if (request.method === "POST" && path === "/api/paypal/create-order") {
      try {
        const accessToken = await getPayPalAccessToken();
        const cartItems = (await readJson(request)).items || [];
        const itemCount = cartItems.reduce((s, i) => s + (parseInt(i.quantity) || 1), 0);
        const subtotal = cartItems.reduce((s, i) => s + (parseFloat(i.price) || 0) * (parseInt(i.quantity) || 1), 0);
        const shipping = itemCount > 0 ? 8.35 + Math.max(0, itemCount - 1) * 4.99 : 0;
        const tax = subtotal * 0.088;
        const total = subtotal + shipping + tax;
        const payload = { intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: total.toFixed(2), breakdown: { item_total: { currency_code: "USD", value: subtotal.toFixed(2) }, shipping: { currency_code: "USD", value: shipping.toFixed(2) }, tax_total: { currency_code: "USD", value: tax.toFixed(2) } } }, items: cartItems.map((i) => ({ name: (i.title || "Item").slice(0, 127), unit_amount: { currency_code: "USD", value: (parseFloat(i.price) || 0).toFixed(2) }, quantity: String(parseInt(i.quantity) || 1), category: "PHYSICAL_GOODS", sku: i.item_number || "" })) }] };
        const resPay = await fetch(PAYPAL_API + "/v2/checkout/orders", { method: "POST", headers: { "Authorization": "Bearer " + accessToken.access_token, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        const data = await resPay.json();
        return jsonResponse(resPay.status, data);
      } catch (err) {
        return jsonResponse(500, { error: err.message });
      }
    }
    if (request.method === "POST" && path.startsWith("/api/paypal/capture-order")) {
      const orderId = path.split("/").pop();
      if (!orderId) return new Response("Missing order id", { status: 400 });
      try {
        const accessToken = await getPayPalAccessToken();
        const reqBody = await readJson(request);
        const clientItems = Array.isArray(reqBody.items) ? reqBody.items : [];
        const resPay = await fetch(PAYPAL_API + "/v2/checkout/orders/" + orderId + "/capture", { method: "POST", headers: { "Authorization": "Bearer " + accessToken.access_token, "Content-Type": "application/json" } });
        const data = await resPay.json();
        try {
          const payer = data && data.payer;
          const pu = data && data.purchase_units && data.purchase_units[0];
          const capture = pu && pu.payments && pu.payments.captures && pu.payments.captures[0];
          const total = capture && capture.amount && capture.amount.value || pu && pu.amount && pu.amount.value || "0.00";
          const items = clientItems.length ? clientItems.map(function(it) {
            return { item_number: it.item_number || null, name: it.title || "", quantity: parseInt(it.quantity) || 1, price: (parseFloat(it.price) || 0).toFixed(2) };
          }) : pu && pu.items ? pu.items.map(function(it) {
            return { item_number: it.sku || null, name: it.name || "", quantity: parseInt(it.quantity) || 1, price: it.unit_amount && it.unit_amount.value || "0.00" };
          }) : [];
          const customerName = payer && payer.name ? ((payer.name.given_name || "") + " " + (payer.name.surname || "")).trim() : "";
          const customerEmail = payer && payer.email_address || clientItems[0] && clientItems[0].email || "";
          const ship = pu && pu.shipping && pu.shipping.address;
          const shippingAddress = ship ? [ship.address_line_1, ship.address_line_2, (ship.admin_area_1 || "") + " " + (ship.postal_code || ""), ship.city, ship.country_code].filter(Boolean).join(", ") : "";
          const primarySku = items[0] && items[0].item_number || null;
          let skuAlias = null;
          if (primarySku) {
            try {
              const skuRows = await tursoPipeline([{ sql: "SELECT sku FROM items WHERE item_number = ?", args: [primarySku] }]);
              skuAlias = skuRows[0] && skuRows[0][0] && skuRows[0][0].sku || null;
            } catch (e) {
            }
          }
          const orderData = {
            customer_name: customerName,
            customer_email: customerEmail,
            shipping_address: shippingAddress,
            paypal_order_id: data && data.id,
            item_number: primarySku,
            sku: skuAlias,
            items,
            captured_at: (/* @__PURE__ */ new Date()).toISOString()
          };
          await tursoExecute("INSERT INTO orders (id, item_number, total, status, data, created_at) VALUES (?, ?, ?, 'Processing', ?, datetime('now'))", [data && data.id, orderData.item_number, parseFloat(total) || 0, JSON.stringify(orderData)]);
          for (const it of items) {
            if (!it.item_number) continue;
            try {
              await tursoExecute("UPDATE items SET quantity = MAX(0, COALESCE(quantity,0) - ?) WHERE item_number = ?", [parseInt(it.quantity) || 1, it.item_number]);
              await tursoExecute("UPDATE items SET status = 'Sold', date_sold = datetime('now') WHERE item_number = ? AND COALESCE(quantity,0) <= 0 AND status = 'Listed'", [it.item_number]);
            } catch (stockErr) {
              console.warn("Stock update skipped for " + it.item_number + ":", stockErr.message);
            }
          }
          if (customerEmail) {
            const rows = items.map(function(it) {
              return '<tr><td style="padding:4px 8px;border-bottom:1px solid #eee">' + escapeHtmlEmail(it.name) + (it.item_number ? ' <span style="color:#888;font-size:12px">(' + escapeHtmlEmail(it.item_number) + ")</span>" : "") + '</td><td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">' + it.quantity + '</td><td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">$' + (parseFloat(it.price) || 0).toFixed(2) + "</td></tr>";
            }).join("");
            const receiptHtml = '<div style="font-family:Arial,Helvetica,sans-serif;color:#111;line-height:1.5;max-width:520px"><h2 style="color:#dc2626;margin:0 0 8px">Thanks for your order, ' + escapeHtmlEmail(customerName || "friend") + `!</h2><p>Your payment was received and your order is being prepared. Here's your receipt:</p><p style="font-size:13px;color:#666">Order #: ` + escapeHtmlEmail(data && data.id || "") + '</p><table style="width:100%;border-collapse:collapse;margin:12px 0;font-size:14px">' + rows + '</table><p style="text-align:right;font-weight:bold;font-size:16px">Total paid: $' + (parseFloat(total) || 0).toFixed(2) + "</p>" + (shippingAddress ? '<p style="font-size:13px;color:#444"><b>Ship to:</b> ' + escapeHtmlEmail(shippingAddress) + "</p>" : "") + `<p style="margin-top:16px;color:#666;font-size:13px">Questions? Reply to this email and we'll help.</p><p style="margin-top:8px;color:#666;font-size:13px">\u2014 Mr. Mulligan<br>Mulligan Market \u2014 Where Every Item Deserves a Second Shot<br><a href="https://www.mulliganmarket.com">www.mulliganmarket.com</a></p></div>`;
            ctx.waitUntil(sendEmail(env, {
              to: customerEmail,
              subject: "Your Mulligan Market order confirmation (#" + (data && data.id || "") + ")",
              html: receiptHtml,
              replyTo: env.NOTIFY_EMAIL || void 0
            }));
          }
        } catch (dbErr) {
          console.warn("Order logging skipped:", dbErr.message);
        }
        return jsonResponse(resPay.status, data);
      } catch (err) {
        return jsonResponse(500, { error: err.message });
      }
    }
    if (request.method === "POST" && path === "/api/notify/order-status") {
      try {
        const body = await readJson(request);
        const to = body.customer_email || body.to || "";
        if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return jsonResponse(400, { ok: false, error: "Valid customer email required" });
        const items = Array.isArray(body.items) ? body.items : [];
        const result = await sendOrderStatusEmail(env, {
          to,
          status: body.status || "",
          items,
          orderLabel: body.orderLabel || body.id || "",
          tracking: body.tracking || ""
        });
        return jsonResponse(200, result);
      } catch (err) {
        return jsonResponse(500, { error: err.message });
      }
    }
    if (request.method === "GET" && path === "/api/orders/by-email") {
      const email = (url.searchParams.get("email") || "").trim();
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return jsonResponse(400, { error: "Valid email required" });
      try {
        const r = await tursoPipeline([{ sql: "SELECT id, item_number, total, status, data, created_at FROM orders WHERE json_extract(data, '$.customer_email') = ? ORDER BY created_at DESC", args: [email] }]);
        return jsonResponse(200, { orders: r[0] });
      } catch (err) {
        return jsonResponse(500, { error: err.message });
      }
    }
    if (request.method === "POST" && path === "/api/subscribe") {
      try {
        const email = String((await readJson(request)).email || "").trim();
        if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return jsonResponse(400, { ok: false, error: "Please enter a valid email address" });
        await tursoExecute("INSERT INTO subscribers (email, created_at, source) VALUES (?, datetime('now'), ?) ON CONFLICT(email) DO UPDATE SET created_at = datetime('now')", [email, "footer"]);
        ctx.waitUntil(sendEmail(env, {
          to: email,
          subject: "Welcome to The Clubhouse \u2014 Mulligan Market",
          html: `<div style="font-family:Arial,Helvetica,sans-serif;color:#111;line-height:1.5"><h2 style="color:#dc2626;margin:0 0 8px">You're in the Clubhouse!</h2><p>Thanks for joining Mulligan Market. You'll be the first to know about new arrivals and exclusive deals.</p><p style="margin-top:16px">\u2014 Mr. Mulligan<br>Mulligan Market \u2014 Where Every Item Deserves a Second Shot<br><a href="https://www.mulliganmarket.com">www.mulliganmarket.com</a></p></div>`
        }));
        return jsonResponse(200, { ok: true });
      } catch (err) {
        return jsonResponse(500, { ok: false, error: err.message });
      }
    }
    if (request.method === "POST" && path === "/api/contact") {
      try {
        const body = await readJson(request);
        const name = String(body.name || "").trim();
        const email = String(body.email || "").trim();
        const subject = String(body.subject || "").trim().slice(0, 200);
        const message = String(body.message || "").trim();
        if (!name) return jsonResponse(400, { ok: false, error: "Please enter your name" });
        if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return jsonResponse(400, { ok: false, error: "Please enter a valid email address" });
        if (!message || message.length < 5) return jsonResponse(400, { ok: false, error: "Please enter a message" });
        if (message.length > 5e3) return jsonResponse(400, { ok: false, error: "Message is too long (max 5000 characters)" });
        await tursoExecute("CREATE TABLE IF NOT EXISTS contact_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL, subject TEXT, message TEXT NOT NULL, status TEXT DEFAULT 'unread', created_at TEXT DEFAULT (datetime('now')))");
        await tursoExecute("INSERT INTO contact_messages (name, email, subject, message, status, created_at) VALUES (?, ?, ?, ?, 'unread', datetime('now'))", [name, email, subject, message]);
        if (env.NOTIFY_EMAIL) {
          ctx.waitUntil(sendEmail(env, {
            to: env.NOTIFY_EMAIL,
            replyTo: email,
            subject: "New contact message: " + (subject || "(no subject)"),
            html: '<div style="font-family:Arial,Helvetica,sans-serif;color:#111;line-height:1.5"><h2 style="margin:0 0 8px">New message from ' + escapeHtmlEmail(name) + "</h2><p><b>Email:</b> " + escapeHtmlEmail(email) + "</p><p><b>Subject:</b> " + escapeHtmlEmail(subject || "(none)") + '</p><p><b>Message:</b></p><p style="white-space:pre-wrap;background:#f5f5f5;padding:12px;border-radius:8px">' + escapeHtmlEmail(message) + '</p><p style="color:#666;font-size:12px">Reply directly to this email to respond to ' + escapeHtmlEmail(name) + ".</p></div>"
          }));
        }
        return jsonResponse(200, { ok: true });
      } catch (err) {
        return jsonResponse(500, { ok: false, error: err.message });
      }
    }
    if (request.method === "POST" && path === "/api/reviews") {
      try {
        const body = await readJson(request);
        if (body.company) return jsonResponse(200, { ok: true });
        const customer_name = String(body.customer_name || "").trim();
        const comment = String(body.comment || "").trim();
        const rating = parseInt(body.rating);
        const item_number = body.item_number ? String(body.item_number).trim() : null;
        if (!customer_name) return jsonResponse(400, { ok: false, error: "Please enter your name" });
        if (!rating || rating < 1 || rating > 5) return jsonResponse(400, { ok: false, error: "Please choose a rating between 1 and 5" });
        if (!comment || comment.length < 5) return jsonResponse(400, { ok: false, error: "Please enter a review (at least 5 characters)" });
        if (comment.length > 2e3) return jsonResponse(400, { ok: false, error: "Review is too long (max 2000 characters)" });
        await tursoExecute("INSERT INTO reviews (item_number, customer_name, rating, comment, platform, status, created_at) VALUES (?, ?, ?, ?, NULL, 'Pending', datetime('now'))", [item_number, customer_name, rating, comment]);
        return jsonResponse(200, { ok: true });
      } catch (err) {
        return jsonResponse(500, { ok: false, error: err.message });
      }
    }
    const assetResp = await env.ASSETS.fetch(request);
    const newHeaders = new Headers(assetResp.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
      if (!newHeaders.has(k)) newHeaders.set(k, v);
    }
    newHeaders.set("X-Frame-Options", "DENY");
    const contentType = (newHeaders.get("Content-Type") || "").toLowerCase();
    const isAdminHtml = /^\/(admin|hq|app)(?:\.html)?$/.test(url.pathname) && contentType.includes("text/html");
    const csp = "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com https://unpkg.com; script-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com https://cdn.tailwindcss.com https://unpkg.com; connect-src 'self'; font-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; frame-ancestors 'none'; base-uri 'self'";
    newHeaders.set("Content-Security-Policy", csp);
    if (isAdminHtml) {
      newHeaders.set("Cache-Control", "no-store");
    }
    const origin = allowedOrigin(env, reqOrigin);
    if (origin && origin !== "*") {
      newHeaders.set("Access-Control-Allow-Origin", origin);
      newHeaders.set("Vary", "Origin");
    }
    return new Response(assetResp.body, { status: assetResp.status, headers: newHeaders });
  }
};
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map