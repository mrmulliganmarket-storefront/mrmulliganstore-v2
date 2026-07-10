const fs = require('fs');
const f = "C:\\Projects\\MrMulliganStore\\admin.html";
let c = fs.readFileSync(f, 'utf8');

const blurCode = `
document.addEventListener('blur', function(e) {
    if (e.target.classList.contains('editable')) {
        const field = e.target.dataset.field;
        const row = e.target.closest('tr');
        const itemNumber = row ? row.querySelector('.font-mono').textContent.trim() : null;
        if (!field || !itemNumber) return;
        let value = e.target.textContent.trim();
        if (e.target.dataset.type === 'number') value = parseFloat(value) || 0;
        const sql = 'UPDATE items SET ' + field + ' = ? WHERE item_number = ?';
        dbQuery(sql, [value, itemNumber]).then(function() { toast('Saved'); }).catch(function(e) { toast('Save failed: ' + e.message); });
    }
}, true);
`;

c = c.replace('init();', blurCode + '\ninit();');
fs.writeFileSync(f, c);
console.log("Blur handler added");
