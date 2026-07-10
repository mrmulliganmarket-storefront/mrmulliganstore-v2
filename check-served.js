const http = require('http');

const req = http.request({
    hostname: 'localhost',
    port: 8080,
    path: '/',
    method: 'GET'
}, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
        const match = d.match(/<script>([\s\S]*?)<\/script>/);
        if (!match) { console.log('No script tag'); return; }
        try {
            new Function(match[1]);
            console.log('Served JS syntax OK');
        } catch (e) {
            console.log('Served JS syntax error:', e.message);
        }
    });
});

req.on('error', e => console.error(e.message));
req.end();