# Account Feature Repair & Nav Banner Redesign Plan

## Goal
Fix the broken visitor account feature, reorganize the upper-right nav buttons, and improve the account icon appearance.

## Problem Statement
1. **Account feature is non-functional**: `public/index.html` JavaScript calls `/api/auth/*` and `/api/customer/*` endpoints that don't exist in the current `worker.js`
2. **Nav banner is misaligned**: Version badge, account, and cart are stacked instead of grouped; positions conflict
3. **Account icon needs improvement**: Standard SVG lacks visual appeal; needs a white ring/circle treatment

## Current State
- `worker.js` (committed): Admin sessions only (lines 87-114), no customer auth endpoints
- `public/index.html` (lines 87-123): Nav buttons with broken positioning
- `public/account.html`: Customer auth page (exists but broken due to missing API)
- `worker.js` (deleted local changes): Had customer auth endpoints with session types, password hashing, customer management APIs

## Affected Boundaries
- `worker.js`: Add customer auth API endpoints
- `public/index.html`: Restructure nav banner, update account icon
- May need `public/account.html` updates if layout changes break references

## Implementation Steps

### Step 1: Add Customer Auth Endpoints to worker.js
Insert after the admin login endpoints (around line 443):

```javascript
// Customer Registration
if (request.method === "POST" && path === "/api/auth/register") {
  try {
    const body = await readJson(request);
    const email = String(body.email || "").trim().toLowerCase();
    const name = String(body.name || "").trim();
    const password = String(body.password || "");
    
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) 
      return jsonResponse(400, { ok: false, error: "Please enter a valid email address" });
    if (!password || password.length < 8) 
      return jsonResponse(400, { ok: false, error: "Password must be at least 8 characters" });
    
    const passwordHash = await hashPassword(password);
    try {
      await tursoExecute(
        "INSERT INTO customers (email, password_hash, name, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))",
        [email, passwordHash, name || email.split("@")[0]]
      );
    } catch (insertErr) {
      if (insertErr.message && insertErr.message.includes("UNIQUE")) 
        return jsonResponse(409, { ok: false, error: "An account with that email already exists" });
      throw insertErr;
    }
    
    const r = await tursoPipeline([{ 
      sql: "SELECT id, email, name, shipping_address, wishlist FROM customers WHERE email = ?", 
      args: [email] 
    }]);
    const row = r[0]?.[0];
    const token = await createSession("customer");
    const tokenPayload = JSON.parse(b64urlDecode(token.split(".")[0]));
    tokenPayload.cid = row.id;
    const newToken = b64urlEncode(JSON.stringify(tokenPayload)) + "." + await hmacSign(b64urlEncode(JSON.stringify(tokenPayload)));
    
    return jsonResponse(200, { 
      ok: true, 
      token: newToken, 
      expiresIn: SESSION_TTL_MS, 
      customer: { 
        id: row.id, 
        email: row.email, 
        name: row.name, 
        shipping_address: row.shipping_address, 
        wishlist: row.wishlist ? JSON.parse(row.wishlist) : [] 
      } 
    });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err.message });
  }
}

// Customer Login
if (request.method === "POST" && path === "/api/auth/login") {
  try {
    const body = await readJson(request);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) 
      return jsonResponse(400, { ok: false, error: "Please enter a valid email address" });
    
    const r = await tursoPipeline([{ 
      sql: "SELECT id, email, password_hash, name, shipping_address, wishlist FROM customers WHERE email = ?", 
      args: [email] 
    }]);
    const row = r[0]?.[0];
    if (!row) return jsonResponse(401, { ok: false, error: "Invalid email or password" });
    
    const valid = await verifyPassword(password, row.password_hash);
    if (!valid) return jsonResponse(401, { ok: false, error: "Invalid email or password" });
    
    const token = await createSession("customer");
    const tokenPayload = JSON.parse(b64urlDecode(token.split(".")[0]));
    tokenPayload.cid = row.id;
    const newToken = b64urlEncode(JSON.stringify(tokenPayload)) + "." + await hmacSign(b64urlEncode(JSON.stringify(tokenPayload)));
    
    return jsonResponse(200, { 
      ok: true, 
      token: newToken, 
      expiresIn: SESSION_TTL_MS, 
      customer: { 
        id: row.id, 
        email: row.email, 
        name: row.name, 
        shipping_address: row.shipping_address, 
        wishlist: row.wishlist ? JSON.parse(row.wishlist) : [] 
      } 
    });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: err.message });
  }
}

// Customer Logout (for consistency)
if (request.method === "POST" && path === "/api/auth/logout") {
  return jsonResponse(200, { ok: true });
}

// Get Customer Info
if (request.method === "GET" && path === "/api/auth/me") {
  const auth = request.headers.get("Authorization") || "";
  if (!await verifySession(auth, "customer")) 
    return jsonResponse(401, { error: "Unauthorized" });
  try {
    const payload = b64urlDecode(auth.replace(/^Bearer /, "").split(".")[0]);
    const data = JSON.parse(payload);
    const cid = data.cid;
    if (!cid) return jsonResponse(401, { error: "Invalid session" });
    
    const r = await tursoPipeline([{ 
      sql: "SELECT id, email, name, shipping_address, wishlist FROM customers WHERE id = ?", 
      args: [cid] 
    }]);
    const row = r[0]?.[0];
    if (!row) return jsonResponse(401, { error: "Account not found" });
    
    let wishlist = [];
    try { wishlist = row.wishlist ? JSON.parse(row.wishlist) : []; } catch { wishlist = []; }
    
    return jsonResponse(200, { 
      ok: true, 
      customer: { 
        id: row.id, 
        email: row.email, 
        name: row.name, 
        shipping_address: row.shipping_address, 
        wishlist 
      } 
    });
  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
}
```

Add helper functions before `function timingSafeEqual` (around line 80):

```javascript
const PBKDF2_ITERATIONS = 1e5;

async function hashPassword(password) {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw", 
    new TextEncoder().encode(password), 
    { name: "PBKDF2" }, 
    false, 
    ["deriveBits"]
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, 
    key, 
    256
  );
  const saltStr = b64urlEncode(String.fromCharCode(...saltBytes));
  const hashStr = b64urlEncode(String.fromCharCode(...new Uint8Array(derived)));
  return PBKDF2_ITERATIONS + ":" + saltStr + ":" + hashStr;
}

async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== "string") return false;
  const parts = stored.split(":");
  if (parts.length !== 3) return false;
  const iterations = parseInt(parts[0]) || PBKDF2_ITERATIONS;
  const salt = b64urlDecode(parts[1]);
  const expectedHash = parts[2];
  try {
    const saltBytes = new Uint8Array(salt.length);
    for (let i = 0; i < salt.length; i++) saltBytes[i] = salt.charCodeAt(i);
    const key = await crypto.subtle.importKey(
      "raw", 
      new TextEncoder().encode(password), 
      { name: "PBKDF2" }, 
      false, 
      ["deriveBits"]
    );
    const derived = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" }, 
      key, 
      256
    );
    const hashStr = b64urlEncode(String.fromCharCode(...new Uint8Array(derived)));
    return timingSafeEqual(hashStr, expectedHash);
  } catch {
    return false;
  }
}

// Updated createSession with type support
async function createSession(type) {
  const iat = Date.now();
  const exp = iat + SESSION_TTL_MS;
  const payload = b64urlEncode(JSON.stringify({ iat, exp, type: type || "admin" }));
  const sig = await hmacSign(payload);
  return payload + "." + sig;
}

// Updated verifySession with type checking
async function verifySession(header, expectedType) {
  if (!header || !header.startsWith("Bearer ")) return false;
  const token = header.slice(7);
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const expected = await hmacSign(b64urlEncode(payload));
  if (!timingSafeEqual(sig, expected)) return false;
  try {
    const data = JSON.parse(b64urlDecode(b64urlDecode(payload)));
    if (!data.exp || data.exp < Date.now()) return false;
    if (expectedType && data.type !== expectedType) {
      if (!(expectedType === "admin" && data.type === undefined)) return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}
```

Update `isValidSession` to pass type parameter:
```javascript
function isValidSession(header, expectedType) {
  return verifySession(header, expectedType);
}
```

### Step 2: Add Customer Endpoint Routes
Insert after the existing Turso endpoint (around line 630):

```javascript
// === Customer API Endpoints ===

if (request.method === "POST" && path === "/api/customer/wishlist") {
  const auth = request.headers.get("Authorization") || "";
  if (!await verifySession(auth, "customer")) return jsonResponse(401, { error: "Unauthorized" });
  try {
    const payload = b64urlDecode(auth.replace(/^Bearer /, "").split(".")[0]);
    const data = JSON.parse(payload);
    const cid = data.cid;
    if (!cid) return jsonResponse(401, { error: "Invalid session" });
    const body = await readJson(request);
    const wishlist = JSON.stringify(Array.isArray(body.wishlist) ? body.wishlist : []);
    await tursoExecute("UPDATE customers SET wishlist = ?, updated_at = datetime('now') WHERE id = ?", [wishlist, cid]);
    return jsonResponse(200, { ok: true });
  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
}

if (request.method === "GET" && path === "/api/customer/wishlist") {
  const auth = request.headers.get("Authorization") || "";
  if (!await verifySession(auth, "customer")) return jsonResponse(401, { error: "Unauthorized" });
  try {
    const payload = b64urlDecode(auth.replace(/^Bearer /, "").split(".")[0]);
    const data = JSON.parse(payload);
    const cid = data.cid;
    if (!cid) return jsonResponse(401, { error: "Invalid session" });
    const r = await tursoPipeline([{ sql: "SELECT wishlist FROM customers WHERE id = ?", args: [cid] }]);
    const row = r[0]?.[0];
    let wishlist = [];
    try { wishlist = row?.wishlist ? JSON.parse(row.wishlist) : []; } catch { wishlist = []; }
    return jsonResponse(200, { wishlist });
  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
}

if (request.method === "GET" && path === "/api/customer/orders") {
  const auth = request.headers.get("Authorization") || "";
  if (!await verifySession(auth, "customer")) return jsonResponse(401, { error: "Unauthorized" });
  try {
    const payload = b64urlDecode(auth.replace(/^Bearer /, "").split(".")[0]);
    const data = JSON.parse(payload);
    const cid = data.cid;
    if (!cid) return jsonResponse(401, { error: "Invalid session" });
    const orders = await tursoPipeline([{ 
      sql: "SELECT id, item_number, total, status, data, created_at FROM orders WHERE json_extract(data, '$.customer_email') = ? ORDER BY created_at DESC", 
      args: [cid] 
    }]);
    return jsonResponse(200, { orders: orders[0] });
  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
}

if (request.method === "GET" && path === "/api/customer/cart") {
  const auth = request.headers.get("Authorization") || "";
  if (!await verifySession(auth, "customer")) return jsonResponse(401, { error: "Unauthorized" });
  try {
    const payload = b64urlDecode(auth.replace(/^Bearer /, "").split(".")[0]);
    const data = JSON.parse(payload);
    const cid = data.cid;
    if (!cid) return jsonResponse(401, { error: "Invalid session" });
    const r = await tursoPipeline([{ sql: "SELECT cart FROM customers WHERE id = ?", args: [cid] }]);
    const row = r[0]?.[0];
    let cart = [];
    try { cart = row?.cart ? JSON.parse(row.cart) : []; } catch { cart = []; }
    return jsonResponse(200, { cart });
  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
}

if (request.method === "POST" && path === "/api/customer/cart") {
  const auth = request.headers.get("Authorization") || "";
  if (!await verifySession(auth, "customer")) return jsonResponse(401, { error: "Unauthorized" });
  try {
    const payload = b64urlDecode(auth.replace(/^Bearer /, "").split(".")[0]);
    const data = JSON.parse(payload);
    const cid = data.cid;
    if (!cid) return jsonResponse(401, { error: "Invalid session" });
    const body = await readJson(request);
    const cart = JSON.stringify(Array.isArray(body.cart) ? body.cart : []);
    await tursoExecute("UPDATE customers SET cart = ?, updated_at = datetime('now') WHERE id = ?", [cart, cid]);
    return jsonResponse(200, { ok: true });
  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
}

if (request.method === "POST" && path === "/api/customer/profile") {
  const auth = request.headers.get("Authorization") || "";
  if (!await verifySession(auth, "customer")) return jsonResponse(401, { error: "Unauthorized" });
  try {
    const payload = b64urlDecode(auth.replace(/^Bearer /, "").split(".")[0]);
    const data = JSON.parse(payload);
    const cid = data.cid;
    if (!cid) return jsonResponse(401, { error: "Invalid session" });
    const body = await readJson(request);
    const name = String(body.name || "").trim().slice(0, 200);
    const shippingAddress = String(body.shipping_address || "").trim().slice(0, 500);
    await tursoExecute(
      "UPDATE customers SET name = ?, shipping_address = ?, updated_at = datetime('now') WHERE id = ?",
      [name, shippingAddress, cid]
    );
    const r = await tursoPipeline([{ sql: "SELECT id, email, name, shipping_address, wishlist FROM customers WHERE id = ?", args: [cid] }]);
    const row = r[0]?.[0];
    if (!row) return jsonResponse(401, { error: "Account not found" });
    let wishlist = [];
    try { wishlist = row.wishlist ? JSON.parse(row.wishlist) : []; } catch { wishlist = []; }
    return jsonResponse(200, { 
      ok: true, 
      customer: { id: row.id, email: row.email, name: row.name, shipping_address: row.shipping_address, wishlist } 
    });
  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
}

// Ensure customers table exists on first run
(async () => {
  try {
    await tursoExecute(`
      CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name TEXT,
        shipping_address TEXT,
        wishlist TEXT,
        cart TEXT,
        created_at TEXT,
        updated_at TEXT
      )
    `);
  } catch (e) {}
})();
```

### Step 3: Update Nav Banner in public/index.html
Replace lines 87-123 with:

```html
<header class="bg-black text-white shadow-lg">
    <div class="container mx-auto px-4 py-4 flex justify-between items-center">
        <h1 class="font-anton text-5xl">MULLIGAN<span class="text-red-600">MARKET</span></h1>
        <div class="flex items-center gap-4">
            <span class="text-xs text-gray-400 hidden md:inline">Upgrade Your Game.</span>
        </div>
    </div>
</header>

<!-- Top-right nav: version badge outside, account/cart grouped -->
<div class="fixed top-4 right-4 z-50">
    <span class="text-red-600 font-bold text-sm bg-black/70 px-2 py-1 rounded">v7.28.0</span>
</div>

<div class="fixed top-4 right-20 z-50 flex items-center gap-2">
    <div id="account-btn-wrapper">
        <button id="account-btn" onclick="toggleAccount()" class="relative text-gray-800 hover:text-black bg-white/90 backdrop-blur-sm p-3 rounded-full shadow-lg border border-gray-200">
            <svg class="w-8 h-8 text-red-600" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <circle cx="12" cy="8" r="6" stroke-width="2" fill="none" stroke="currentColor"/>
                <circle cx="12" cy="8" r="2" fill="currentColor"/>
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 20v-4m10 4v-4M7 16a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v4"/>
            </svg>
        </button>
        <div id="account-menu" class="hidden absolute top-full right-0 mt-2 w-48 bg-white rounded-xl shadow-xl border border-gray-200 py-2 z-50">
            <a href="account.html" class="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-100">My Account</a>
            <a href="#" onclick="openMyOrders(); return false;" class="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-100">My Orders</a>
            <a href="#" onclick="openWishlist(); return false;" class="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-100">Wishlist</a>
            <hr class="my-1 border-gray-200">
            <a href="#" onclick="logout(); return false;" class="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-100">Logout</a>
        </div>
    </div>
    <div class="relative">
        <button onclick="toggleCart()" class="relative text-gray-800 hover:text-black bg-white/90 backdrop-blur-sm p-3 rounded-full shadow-lg border border-gray-200">
            <svg class="w-8 h-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 100 4 2 2 0 000-4z"></path></svg>
            <span id="cart-count" class="absolute -top-1 -right-1 bg-red-600 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center hidden">0</span>
        </button>
    </div>
</div>
```

### Step 4: Optimize Account Button JavaScript
Replace or add in `index.html` script section (around line 1512):

```javascript
function updateAccountButton() {
    var btn = document.getElementById('account-btn');
    var menu = document.getElementById('account-menu');
    if (!btn || !menu) return;
    var customer = getCurrentCustomer();
    if (customer && customer.email) {
        menu.classList.add('hidden');
    } else {
        menu.classList.add('hidden');
    }
}
```

## Data Flow
1. Visitor visits site → No login
2. Click account icon → Shows "My Account" link (or opens auth modal if logged out)
3. Click "My Account" → Redirects to `/account.html`
4. `account.html` loads → Calls `init()` which verifies session via `/api/auth/me`
5. If valid session → Shows account data; if not → Redirects to home

## Validation Steps
1. Start local server: `cd public && python -m http.server 8080`
2. Open `http://localhost:8080`
3. Verify nav bar:
   - Version badge in top-right corner (outside account/cart cluster)
   - Account icon has white ring/circle around user icon
   - Cart icon beside account with no overlap
4. Test account feature:
   - Click account button → Dropdown appears
   - Click "My Account" → Opens account page
   - Try login/register → Should show modal (requires running Cloudflare Worker)
5. Verify hero image loads correctly

## Deployment Notice
**DO NOT DEPLOY UNTIL APPROVED.** Changes pending:
- [ ] worker.js updates (customer auth endpoints)
- [ ] public/index.html updates (nav bar, icon)

## Open Questions
None — plan is ready for implementation upon approval.