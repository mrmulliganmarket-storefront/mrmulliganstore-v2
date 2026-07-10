const http = require('http');

const statements = [
  `CREATE TABLE IF NOT EXISTS items (
    item_number TEXT PRIMARY KEY,
    sku TEXT,
    title TEXT NOT NULL,
    category TEXT,
    subcategory TEXT,
    condition TEXT,
    status TEXT DEFAULT 'Available',
    cost REAL DEFAULT 0,
    price REAL DEFAULT 0,
    fees REAL DEFAULT 0,
    description TEXT,
    vendor_id INTEGER,
    photos TEXT DEFAULT '[]',
    specs TEXT DEFAULT '{}',
    listing_url TEXT,
    location TEXT,
    quantity INTEGER DEFAULT 1,
    date_listed TEXT DEFAULT (datetime('now')),
    date_sold TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS orders (
    order_id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_number TEXT,
    customer_name TEXT NOT NULL,
    customer_email TEXT,
    ordered_at TEXT DEFAULT (datetime('now')),
    total REAL DEFAULT 0,
    status TEXT DEFAULT 'Processing',
    FOREIGN KEY (item_number) REFERENCES items(item_number)
  )`,

  `CREATE TABLE IF NOT EXISTS vendors (
    vendor_id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    notes TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS expenses (
    expense_id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    description TEXT NOT NULL,
    amount REAL NOT NULL,
    item_number TEXT,
    expense_date TEXT DEFAULT (date('now')),
    FOREIGN KEY (item_number) REFERENCES items(item_number)
  )`,

  `CREATE TABLE IF NOT EXISTS monthly_goals (
    month TEXT PRIMARY KEY,
    items INTEGER DEFAULT 0,
    profit REAL DEFAULT 0
  )`,

  `CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    details TEXT,
    item_number TEXT,
    item_title TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS reviews (
    review_id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_number TEXT,
    customer_name TEXT NOT NULL,
    rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
    comment TEXT,
    platform TEXT,
    status TEXT DEFAULT 'Pending' CHECK(status IN ('Pending', 'Approved', 'Rejected')),
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (item_number) REFERENCES items(item_number)
  )`
];

const body = {
  requests: statements.map(sql => ({
    type: 'execute',
    stmt: { sql, args: [] }
  }))
};

const req = http.request({
  hostname: 'localhost',
  port: 8080,
  path: '/api/turso',
  method: 'POST',
  headers: { 'Content-Type': 'application/json' }
}, res => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const result = JSON.parse(data);
    result.results.forEach((r, i) => {
      console.log(`Statement ${i + 1}: ${r.type}${r.error ? ' - ' + r.error.message : ''}`);
    });
  });
});

req.write(JSON.stringify(body));
req.end();
