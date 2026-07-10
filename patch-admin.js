const fs = require('fs');
const f = "C:\\Projects\\MrMulliganStore\\admin.html";
let c = fs.readFileSync(f, 'utf8');

// Fix 1: Add Oswald font back
c = c.replace('<style>\n        body { font-family: system-ui, sans-serif; }', '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Anton&family=Oswald:wght@400;500;600;700&display=swap" rel="stylesheet"><style>\n        body { font-family: "Oswald", sans-serif; }');

// Fix 2: Make inventory cells editable - use escaped dollar signs
const oldTitle = '<td class="p-2 font-bold">${i.title||\'Untitled\'}</td>';
const newTitle = '<td class="p-2"><span contenteditable="true" class="editable" data-field="title" style="border-bottom:1px dashed #ccc">${i.title||\'Untitled\'}</span></td>';
c = c.replace(oldTitle, newTitle);

const oldCat = '<td class="p-2">${i.category||\'—\'}</td>';
const newCat = '<td class="p-2"><span contenteditable="true" class="editable" data-field="category" style="border-bottom:1px dashed #ccc">${i.category||\'—\'}</span></td>';
c = c.replace(oldCat, newCat);

const oldCon = '<td class="p-2">${i.condition||\'—\'}</td>';
const newCon = '<td class="p-2"><span contenteditable="true" class="editable" data-field="condition" style="border-bottom:1px dashed #ccc">${i.condition||\'—\'}</span></td>';
c = c.replace(oldCon, newCon);

fs.writeFileSync(f, c);
console.log("Patched fonts and editable cells");
