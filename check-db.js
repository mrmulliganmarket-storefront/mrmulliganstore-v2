const http = require('http');

function query(sql, args) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      requests: [{
        type: 'execute',
        stmt: { sql, args: (args || []).map(a => ({type:'text',value: a==null ? '' : String(a)})) }
      }]
    });
    const req = http.request({hostname:'localhost',port:8080,path:'/api/turso',method:'POST',headers:{'Content-Type':'application/json'}}, res => {
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d));}catch(e){resolve(d);} });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

function toRows(result) {
  if (!result.cols || !result.rows) return [];
  return result.rows.map(row => {
    const obj = {};
    const cells = Array.isArray(row) ? row : (row.value || row);
    result.cols.forEach((col, i) => {
      const cell = cells[i];
      if (!cell || cell.type === 'null') { obj[col.name] = null; return; }
      const v = cell.value;
      try { obj[col.name] = JSON.parse(v); } catch { obj[col.name] = v; }
    });
    return obj;
  });
}

(async () => {
  const r = await query("SELECT * FROM items WHERE status IN (?, ?) ORDER BY date_listed DESC", ['Available','Listed']);
  const res = r.results[0];
  console.log('result type:', res.type);
  if (res.type === 'error') { console.log('ERROR:', JSON.stringify(res.error)); process.exit(0); }
  const result = res.response ? res.response.result : res.result;
  console.log('cols count:', result.cols.length);
  console.log('rows count:', result.rows.Count);
  const rows = toRows(result);
  console.log('parsed rows:', rows.length);
  rows.forEach((row, i) => console.log(`Row ${i}:`, row.item_number, row.title, row.status));
  process.exit(0);
})();
