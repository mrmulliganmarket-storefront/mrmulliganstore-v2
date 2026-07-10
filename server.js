/* Turso Proxy Server for Mulligan Market */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');

// Load environment variables from .env if present (dependency-free)
try {
    const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    envFile.split('\n').forEach(function(line) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const idx = trimmed.indexOf('=');
        if (idx === -1) return;
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim();
        if (!(key in process.env)) process.env[key] = val;
    });
} catch (e) { /* no .env file — rely on real environment variables */ }

const TURSO_URL = 'https://mulliganmarket-mrmulligan.aws-us-west-2.turso.io';
const TURSO_TOKEN = process.env.TURSO_TOKEN;

// Native libSQL protocol (WebSocket, keep-alive) — lower latency than REST /v2/pipeline
const libsqlClient = createClient({
    url: TURSO_URL.replace(/^https:\/\//, 'libsql://'),
    authToken: TURSO_TOKEN
});

const PAYPAL_CLIENT_ID = 'YOUR_PAYPAL_CLIENT_ID';
const PAYPAL_CLIENT_SECRET = 'YOUR_PAYPAL_CLIENT_SECRET';
const PAYPAL_API = 'https://api-m.sandbox.paypal.com';

function getPayPalAccessToken() {
    return fetch(PAYPAL_API + '/v1/oauth2/token', {
        method: 'POST',
        headers: {
            'Authorization': 'Basic ' + Buffer.from(PAYPAL_CLIENT_ID + ':' + PAYPAL_CLIENT_SECRET).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials'
    }).then(res => res.json());
}

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // Serve item photos by item_number to avoid embedding large base64 blobs
    if (req.method === 'GET' && req.url.startsWith('/api/image')) {
        const itemNumber = new URL(req.url, 'http://localhost').searchParams.get('item');
        if (!itemNumber) {
            res.writeHead(400);
            res.end('Missing item');
            return;
        }
        const payload = JSON.stringify({
            requests: [{
                type: 'execute',
                stmt: { sql: 'SELECT photos FROM items WHERE item_number = ?', args: [{ type: 'text', value: itemNumber }] }
            }]
        });
        fetch('https://mulliganmarket-mrmulligan.aws-us-west-2.turso.io/v2/pipeline', {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + TURSO_TOKEN,
                'Content-Type': 'application/json'
            },
            body: payload
        }).then(tursoRes => tursoRes.json())
        .then(data => {
            const result = data.results?.[0]?.response?.result;
            const row = result?.rows?.[0];
            const photoCell = row ? row[0] : null;
            let photos = [];
            if (photoCell && photoCell.value) {
                try { photos = JSON.parse(photoCell.value); } catch { photos = []; }
            }
            const photo = Array.isArray(photos) ? photos[0] : '';
            if (!photo) {
                console.log('Image ' + itemNumber + ': no photo');
                res.writeHead(204);
                res.end('');
                return;
            }
            const match = photo.match(/^data:([^;]+);base64,(.+)$/);
            if (!match) {
                console.log('Image ' + itemNumber + ': regex mismatch, starts=' + photo.slice(0, 40));
                res.writeHead(204);
                res.end('');
                return;
            }
            const buffer = Buffer.from(match[2], 'base64');
            if (!buffer || buffer.length < 100) {
                console.log('Image ' + itemNumber + ': small buffer', buffer.length);
                res.writeHead(204);
                res.end('');
                return;
            }
            res.writeHead(200, {
                'Content-Type': match[1],
                'Content-Length': buffer.length,
                'Cache-Control': 'public, max-age=3600'
            });
            res.end(buffer);
        }).catch((err) => {
            console.log('Image ' + itemNumber + ': fetch error', err && err.message);
            res.writeHead(500);
            res.end('Image error');
        });
        return;
    }

    // --- Batched, cached API endpoints (additive; /api/turso proxy is untouched) ---
    const _apiCache = new Map();
    const DASHBOARD_TTL = 8000;
    const VENDORS_TTL = 8000;
    const ANALYTICS_TTL = 12000;
    const STORE_TTL = 10000;
    const STORE_ITEM_TTL = 10000;
    const STORE_REVIEWS_TTL = 10000;

    function withTimeout(promise, ms) {
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('libsql timeout')), ms);
            promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
        });
    }

    async function tursoPipeline(statements) {
        try {
            const results = await withTimeout(
                libsqlClient.batch(
                    statements.map(s => ({ sql: s.sql, args: toLibsqlArgs(s.args) })),
                    'read'
                ),
                15000
            );
            return results.map(r => r.rows.map(row => normalizeLibsqlRow(row, r.columns)));
        } catch (e) {
            console.warn('libsql batch failed, falling back to REST:', e.message);
            return await tursoPipelineRest(statements);
        }
    }

    function toLibsqlArgs(args) {
        return (args || []).map(a => {
            if (a && typeof a === 'object' && a.type && ('value' in a)) {
                return a.type === 'integer' ? parseInt(a.value, 10) : a.value;
            }
            return a;
        });
    }

    function normalizeLibsqlRow(row, columns) {
        const obj = {};
        columns.forEach((col, i) => {
            let v = row[i];
            if (v === null || v === undefined) { obj[col] = null; return; }
            if (typeof v === 'string') {
                try { obj[col] = JSON.parse(v); } catch (e) { obj[col] = v; }
            } else {
                obj[col] = v;
            }
        });
        return obj;
    }

    async function tursoPipelineRest(statements) {
        const body = {
            requests: statements.map(s => ({
                type: 'execute',
                stmt: {
                    sql: s.sql,
                    args: (s.args || []).map(a => {
                        if (a && typeof a === 'object' && a.type && ('value' in a)) return a;
                        if (a === null || a === undefined) return { type: 'null', value: '' };
                        if (typeof a === 'number') return { type: 'float', value: a };
                        return { type: 'text', value: String(a) };
                    })
                }
            }))
        };
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        let res;
        try {
            res = await fetch(TURSO_URL + '/v2/pipeline', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + TURSO_TOKEN,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body),
                signal: ctrl.signal
            });
        } finally {
            clearTimeout(timer);
        }
        if (!res.ok) {
            const text = await res.text();
            throw new Error('Turso ' + res.status + ': ' + text);
        }
        const data = await res.json();
        return data.results.map(r => {
            if (r.type === 'error') throw new Error(r.error.message);
            const result = r.response && r.response.result;
            if (!result || !result.rows) return [];
            return result.rows.map(row => {
                const cells = Array.isArray(row) ? row : (row.value || row);
                const obj = {};
                result.cols.forEach((col, i) => {
                    const cell = cells[i];
                    if (!cell || cell.type === 'null') { obj[col.name] = null; return; }
                    try { obj[col.name] = JSON.parse(cell.value); } catch (e) { obj[col.name] = cell.value; }
                });
                return obj;
            });
        });
    }

    function cachedJson(res, key, ttlMs, builder) {
        const hit = _apiCache.get(key);
        const nowTs = Date.now();
        const send = (status, obj) => {
            res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify(obj));
        };
        if (hit && (nowTs - hit.ts) < ttlMs) {
            send(200, hit.data);
            return;
        }
        builder().then(data => {
            _apiCache.set(key, { ts: nowTs, data });
            send(200, data);
        }).catch(err => {
            if (hit) { send(200, hit.data); return; }
            send(500, { error: err.message });
        });
    }

    async function buildDashboard() {
        const now = new Date();
        const currentMonth = now.toISOString().slice(0, 7);
        const last = new Date(now);
        last.setMonth(last.getMonth() - 1);
        const lastMonthStr = last.toISOString().slice(0, 7);

        const r = await tursoPipeline([
            { sql: "SELECT COUNT(CASE WHEN status IN ('Available','Listed') THEN 1 END) as active, COALESCE(SUM(cost),0) as cost, COALESCE(SUM(price),0) as listed, COUNT(CASE WHEN status='Processing' THEN 1 END) as pending FROM items" },
            { sql: "SELECT item_number, sku, title, category, condition, status, cost, price, quantity, date_listed, date_sold FROM items ORDER BY date_listed DESC LIMIT 15" },
            { sql: "SELECT COUNT(*) as sold FROM items WHERE status='Sold' AND date_sold LIKE ?", args: [currentMonth + '%'] },
            { sql: "SELECT COALESCE(SUM(price-cost-fees),0) as profit FROM items WHERE status='Sold' AND date_sold LIKE ?", args: [currentMonth + '%'] },
            { sql: "SELECT items, profit FROM monthly_goals WHERE month = ?", args: [currentMonth] },
            { sql: "SELECT COUNT(*) as sold FROM items WHERE status='Sold' AND date_sold LIKE ?", args: [lastMonthStr + '%'] },
            { sql: "SELECT COALESCE(SUM(price-cost-fees),0) as profit FROM items WHERE status='Sold' AND date_sold LIKE ?", args: [lastMonthStr + '%'] },
            { sql: "SELECT date_sold as day, COUNT(*) as count, SUM(price-cost-fees) as profit FROM items WHERE date_sold >= date('now', '-30 days') AND status='Sold' GROUP BY date_sold ORDER BY day" },
            { sql: "SELECT condition, COUNT(*) as count FROM items WHERE condition IS NOT NULL GROUP BY condition" },
            { sql: "SELECT v.name, v.vendor_id, COUNT(i.item_number) as items_sold, COALESCE(SUM(i.price - i.cost - i.fees),0) as profit FROM vendors v LEFT JOIN items i ON i.vendor_id = v.vendor_id AND i.status='Sold' GROUP BY v.vendor_id, v.name ORDER BY profit DESC LIMIT 5" },
            { sql: "SELECT COALESCE(SUM(amount),0) as total, type FROM expenses WHERE expense_date >= date('now', '-30 days') GROUP BY type ORDER BY total DESC LIMIT 1" },
            { sql: "SELECT item_number, title FROM items WHERE status IN ('Available','Listed') AND date_listed <= date('now', '-45 days') LIMIT 3" },
            { sql: "SELECT item_number, title, price, cost FROM items WHERE status='Available' AND (price - cost) <= 0 LIMIT 3" },
            { sql: "SELECT item_number, title FROM items WHERE (photos IS NULL OR photos='[]' OR photos='') AND status IN ('Available','Listed') LIMIT 3" }
        ]);

        const kpis = r[0][0] || { active: 0, cost: 0, listed: 0, pending: 0 };
        const items = r[1];
        const soldItems = r[2][0] ? r[2][0].sold : 0;
        const monthlyProfit = r[3][0] ? r[3][0].profit : 0;
        const goalRow = r[4][0];
        const goal = goalRow ? { items: goalRow.items || 0, profit: goalRow.profit || 0 } : { items: 0, profit: 0 };
        const lastMonthSold = r[5][0] ? r[5][0].sold : 0;
        const lastMonthProfit = r[6][0] ? r[6][0].profit : 0;
        const salesTrend = r[7];
        const health = r[8];
        const vendors = r[9];
        const expenses30 = r[10][0] || { total: 0, type: '—' };
        const stale = r[11], low = r[12], nophotos = r[13];
        const alerts = stale.map(i => ({ type: 'stale', item: i.item_number, text: i.title }))
            .concat(low.map(i => ({ type: 'margin', item: i.item_number, text: i.title })))
            .concat(nophotos.map(i => ({ type: 'photos', item: i.item_number, text: i.title })));

        return { kpis: [kpis], items: items, orders: [], soldItems: soldItems, monthlyProfit: monthlyProfit, goal: goal, lastMonthSold: lastMonthSold, lastMonthProfit: lastMonthProfit, salesTrend: salesTrend, health: health, vendors: vendors, expenses30: expenses30, alerts: alerts };
    }

    async function buildVendors() {
        const r = await tursoPipeline([
            { sql: "SELECT * FROM vendors ORDER BY name" },
            { sql: "SELECT v.vendor_id, v.name, COUNT(DISTINCT i.item_number) as items_purchased, COALESCE(SUM(i.cost),0) as total_spent, COALESCE(AVG(i.price - i.cost - i.fees),0) as avg_profit_per_item, COALESCE(SUM(i.price - i.cost - i.fees),0) as total_profit, AVG(julianday(i.date_sold) - julianday(i.date_listed)) as avg_days_to_sell FROM vendors v LEFT JOIN items i ON i.vendor_id = v.vendor_id GROUP BY v.vendor_id, v.name" }
        ]);
        return { vendors: r[0], performance: r[1] };
    }

    async function buildAnalytics() {
        const r = await tursoPipeline([
            { sql: "SELECT COUNT(*) as total, COUNT(CASE WHEN status IN ('Available','Listed') THEN 1 END) as active, COUNT(CASE WHEN status='Sold' THEN 1 END) as sold, COALESCE(SUM(CASE WHEN status='Sold' THEN price-cost-fees END),0) as profit FROM items" },
            { sql: "SELECT COALESCE(SUM(price),0) as total_revenue, COALESCE(SUM(cost),0) as total_cost, COALESCE(SUM(fees),0) as total_fees FROM items WHERE status='Sold'" },
            { sql: "SELECT COALESCE(SUM(amount),0) as total_expenses FROM expenses" },
            { sql: "SELECT category, COUNT(*) as count, SUM(price) as value FROM items GROUP BY category ORDER BY value DESC" },
            { sql: "SELECT status, COUNT(*) as count FROM items GROUP BY status" },
            { sql: "SELECT item_number, title, price, cost, date_sold FROM items WHERE status='Sold' ORDER BY date_sold DESC LIMIT 10" }
        ]);
        return { mainStats: r[0], revenueStats: r[1], expenseStats: r[2], categoryStats: r[3], statusStats: r[4], recentSales: r[5] };
    }

    async function buildInventory() {
        const r = await tursoPipeline([{ sql: "SELECT item_number, sku, title, category, condition, status, cost, price, quantity, date_listed, date_sold FROM items ORDER BY date_listed DESC" }]);
        return { items: r[0] };
    }
    async function buildOrders() {
        const r = await tursoPipeline([{ sql: "SELECT orders.*, items.date_sold FROM orders LEFT JOIN items ON orders.item_number = items.item_number ORDER BY orders.id DESC" }]);
        return { orders: r[0] };
    }
    async function buildExpenses() {
        const r = await tursoPipeline([{ sql: "SELECT e.*, i.sku as item_sku FROM expenses e LEFT JOIN items i ON e.item_number = i.item_number ORDER BY expense_date DESC" }]);
        return { expenses: r[0] };
    }
    async function buildReviews() {
        const r = await tursoPipeline([{ sql: "SELECT * FROM reviews ORDER BY created_at DESC" }]);
        return { reviews: r[0] };
    }

    if (req.method === 'GET' && req.url.startsWith('/api/dashboard')) {
        cachedJson(res, 'dashboard', DASHBOARD_TTL, buildDashboard);
        return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/vendors')) {
        cachedJson(res, 'vendors', VENDORS_TTL, buildVendors);
        return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/analytics')) {
        cachedJson(res, 'analytics', ANALYTICS_TTL, buildAnalytics);
        return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/inventory')) {
        cachedJson(res, 'inventory', 8000, buildInventory);
        return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/orders')) {
        cachedJson(res, 'orders', 8000, buildOrders);
        return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/expenses')) {
        cachedJson(res, 'expenses', 8000, buildExpenses);
        return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/reviews')) {
        cachedJson(res, 'reviews', 8000, buildReviews);
        return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/store/item')) {
        const u = new URL(req.url, 'http://localhost');
        const item = u.searchParams.get('item');
        cachedJson(res, 'store-item:' + (item || ''), STORE_ITEM_TTL, () => buildStoreItem(item));
        return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/store/reviews')) {
        const u = new URL(req.url, 'http://localhost');
        const page = parseInt(u.searchParams.get('page')) || 1;
        const limit = parseInt(u.searchParams.get('limit')) || 9;
        cachedJson(res, 'store-reviews:' + page + ':' + limit, STORE_REVIEWS_TTL, () => buildStoreReviews(page, limit));
        return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/store')) {
        cachedJson(res, 'store', STORE_TTL, buildStore);
        return;
    }

    async function buildStore() {
        const r = await tursoPipeline([
            { sql: "SELECT item_number, sku, title, category, condition, status, price, quantity FROM items WHERE status IN ('Listed', 'Sold') ORDER BY CASE WHEN status='Sold' THEN 1 ELSE 0 END, date_listed DESC" },
            { sql: "SELECT review_id, item_number, customer_name, rating, comment, platform, status, created_at FROM reviews WHERE status = 'Approved' ORDER BY created_at DESC LIMIT 6" },
            { sql: "SELECT COUNT(*) as total, COALESCE(AVG(rating),0) as avg_rating FROM reviews WHERE status = 'Approved'" }
        ]);
        const reviewStatsRow = r[2][0] || {};
        return {
            items: r[0],
            reviews: r[1],
            reviewStats: { total: reviewStatsRow.total || 0, avgRating: parseFloat(reviewStatsRow.avg_rating || 0).toFixed(1) }
        };
    }
    async function buildStoreItem(itemNumber) {
        if (!itemNumber) return { item: null };
        const r = await tursoPipeline([{ sql: "SELECT item_number, sku, title, category, condition, status, price, quantity, description, photos FROM items WHERE item_number = ?", args: [itemNumber] }]);
        return { item: r[0][0] || null };
    }
    async function buildStoreReviews(page, limit) {
        const p = Math.max(1, parseInt(page) || 1);
        const l = Math.max(1, parseInt(limit) || 9);
        const offset = (p - 1) * l;
        const r = await tursoPipeline([
            { sql: "SELECT review_id, item_number, customer_name, rating, comment, platform, created_at FROM reviews WHERE status = 'Approved' ORDER BY created_at DESC LIMIT ? OFFSET ?", args: [{ type: 'integer', value: String(l) }, { type: 'integer', value: String(offset) }] },
            { sql: "SELECT COUNT(*) as cnt FROM reviews WHERE status = 'Approved'", args: [] }
        ]);
        return { reviews: r[0], total: (r[1][0] && r[1][0].cnt) || 0 };
    }

    // Serve static files
    if (req.method === 'GET') {
        const cleanPath = req.url.split('?')[0];
        let filePath = cleanPath === '/' ? '/index.html' : cleanPath;
        const fullPath = path.join(process.cwd(), filePath);

        fs.readFile(fullPath, (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end('Not found');
                return;
            }

            const ext = path.extname(filePath);
            const contentTypes = {
                '.html': 'text/html',
                '.css': 'text/css',
                '.js': 'application/javascript',
                '.png': 'image/png',
                '.jpg': 'image/jpeg'
            };

            res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
            res.end(data);
        });
        return;
    }

    // Proxy Turso API requests
    if (req.method === 'POST' && req.url === '/api/turso') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const tursoRes = await fetch('https://mulliganmarket-mrmulligan.aws-us-west-2.turso.io/v2/pipeline', {
                    method: 'POST',
                    headers: {
                        'Authorization': 'Bearer ' + TURSO_TOKEN,
                        'Content-Type': 'application/json'
                    },
                    body: body
                });
                const data = await tursoRes.json();
                res.writeHead(tursoRes.status, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify(data));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    // PayPal: create order
    if (req.method === 'POST' && req.url === '/api/paypal/create-order') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const accessToken = await getPayPalAccessToken();
                let cartItems = [];
                try { cartItems = JSON.parse(body).items || []; } catch {}
                const total = cartItems.reduce((sum, i) => sum + ((parseFloat(i.price) || 0) * (parseInt(i.quantity) || 1)), 0);
                const orderPayload = {
                    intent: 'CAPTURE',
                    purchase_units: [{
                        amount: {
                            currency_code: 'USD',
                            value: total.toFixed(2),
                            breakdown: {
                                item_total: { currency_code: 'USD', value: total.toFixed(2) }
                            }
                        },
                        items: cartItems.map(i => ({
                            name: (i.title || 'Item').slice(0, 127),
                            unit_amount: { currency_code: 'USD', value: (parseFloat(i.price) || 0).toFixed(2) },
                            quantity: String(parseInt(i.quantity) || 1),
                            category: 'PHYSICAL_GOODS'
                        }))
                    }]
                };
                const resPay = await fetch(PAYPAL_API + '/v2/checkout/orders', {
                    method: 'POST',
                    headers: {
                        'Authorization': 'Bearer ' + accessToken.access_token,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(orderPayload)
                });
                const data = await resPay.json();
                res.writeHead(resPay.status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify(data));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    // PayPal: capture order
    if (req.method === 'POST' && req.url.startsWith('/api/paypal/capture-order')) {
        const orderId = req.url.split('/').pop();
        if (!orderId) {
            res.writeHead(400);
            res.end('Missing order id');
            return;
        }
        (async () => {
            try {
                const accessToken = await getPayPalAccessToken();
                const resPay = await fetch(PAYPAL_API + '/v2/checkout/orders/' + orderId + '/capture', {
                    method: 'POST',
                    headers: {
                        'Authorization': 'Bearer ' + accessToken.access_token,
                        'Content-Type': 'application/json'
                    }
                });
                const data = await resPay.json();
                res.writeHead(resPay.status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify(data));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        })();
        return;
    }

    res.writeHead(404);
    res.end('Not found');
});

server.listen(8080, () => {
    console.log('Mulligan Market server running on http://localhost:8080');
    console.log('Turso proxy available at http://localhost:8080/api/turso');
});
