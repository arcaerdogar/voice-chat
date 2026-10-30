'use strict';
// Önbellek kırma: HTML'deki CSS/JS linkleri dosya içeriğine göre sürümlenir.
const test = require('node:test');
const assert = require('node:assert');
const { createServer } = require('../server');

test('CSS/JS linkleri içerik özetiyle sürümlenir', async (t) => {
  const srv = createServer({ quiet: true, env: {} });
  await new Promise((r) => srv.server.listen(3993, r));
  t.after(() => srv.close());
  for (const p of ['/', '/r/oda']) {
    const r = await fetch('http://localhost:3993' + p);
    assert.equal(r.headers.get('cache-control'), 'no-cache');
    const html = await r.text();
    assert.match(html, /href="\/style\.css\?v=[0-9a-f]{10}"/);
    assert.match(html, /src="\/app\.js\?v=[0-9a-f]{10}"/);
  }
  const r = await fetch('http://localhost:3993/style.css?v=abc');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/css/);
});
