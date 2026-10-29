'use strict';
// Sohbet uçtan uca: biçimlendirme, bahsetme, yazıyor…, tepkiler, silme, dosya/görsel paylaşımı, geçmiş.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { createServer } = require('../server');

const PORT = 3996;
const BASE = `http://localhost:${PORT}`;
const ROOM = 'sohbet-test';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

async function launch() {
  const args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
  for (const channel of ['chrome', 'msedge', undefined]) {
    try {
      return await chromium.launch({ channel, headless: true, args });
    } catch (err) {
      if (channel === undefined) throw err;
    }
  }
}

async function join(browser, name) {
  const ctx = await browser.newContext({ permissions: ['microphone', 'clipboard-read', 'clipboard-write'], viewport: { width: 1280, height: 860 } });
  await ctx.addInitScript(() => localStorage.setItem('rv:autoGate', 'false'));
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) page.errors.push(m.text());
  });
  await page.goto(`${BASE}/r/${ROOM}`);
  await page.fill('#name-input', name);
  await page.click('#join-btn');
  await page.waitForSelector('#room-view:not([hidden])', { timeout: 20000 });
  return page;
}

async function send(page, text) {
  await page.fill('#chat-input', text);
  await page.press('#chat-input', 'Enter');
}

test('sohbet: mesajlar, dosyalar ve geçmiş', { timeout: 180000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yanki-up-'));
  const srv = createServer({ quiet: true, graceMs: 3000, env: { UPLOAD_DIR: dir, UPLOAD_MAX_MB: '1' } });
  await new Promise((r) => srv.server.listen(PORT, r));
  const browser = await launch();
  t.after(async () => {
    await browser.close();
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const A = await join(browser, 'Ahri');
  const B = await join(browser, 'Bora');
  await A.waitForFunction(() => window.__rv.peers.size === 1);
  await B.waitForFunction(() => window.__rv.peers.size === 1);

  await t.test('biçimlendirme ve bahsetme', async () => {
    await send(A, '@Bora **kalın** `kod` ||gizli|| https://example.com/a?b=1');
    const msg = B.locator('.msg', { hasText: 'kalın' });
    await msg.waitFor();
    assert.equal(await msg.locator('b').textContent(), 'kalın');
    assert.equal(await msg.locator('code').textContent(), 'kod');
    assert.equal(await msg.locator('a').getAttribute('href'), 'https://example.com/a?b=1');
    assert.equal(await msg.locator('.mention.me').textContent(), '@Bora');
    assert.match(await msg.getAttribute('class'), /mention-me/, 'bahsedilen kişide mesaj vurgulanmalı');
    assert.doesNotMatch(await A.locator('.msg', { hasText: 'kalın' }).getAttribute('class'), /mention-me/);
    // Gizli metin tıklayınca açılır
    const sp = msg.locator('.spoiler');
    assert.doesNotMatch(await sp.getAttribute('class'), /shown/);
    await sp.click();
    assert.match(await sp.getAttribute('class'), /shown/);
    // HTML kaçırılır
    await send(A, '<img src=x onerror=alert(1)> <b>yok</b>');
    await B.locator('.msg', { hasText: '<b>yok</b>' }).waitFor();
    assert.equal(await B.locator('.msg-text img').count(), 0);
  });

  await t.test('art arda mesajlar tek grupta toplanır', async () => {
    await send(A, 'ikinci satır');
    await B.locator('.msg', { hasText: 'ikinci satır' }).waitFor();
    const lastGroup = B.locator('.msg-group').last();
    assert.equal(await lastGroup.locator('.mg-name').textContent(), 'Ahri');
    assert.ok((await lastGroup.locator('.msg').count()) >= 3);
    assert.equal(await B.locator('.msg-group').count(), 1);
  });

  await t.test('bahsetme önerisi', async () => {
    await B.click('#chat-input');
    await B.type('#chat-input', 'selam @Ah');
    await B.waitForSelector('#mention-pop:not([hidden]) .mention-opt');
    await B.press('#chat-input', 'Enter'); // öneriyi seçer, göndermez
    assert.equal(await B.inputValue('#chat-input'), 'selam @Ahri ');
    // Yazıyor… göstergesi
    await A.waitForSelector('#typing.on');
    assert.match(await A.textContent('#typing'), /Bora yazıyor/);
    await B.press('#chat-input', 'Enter');
    await A.locator('.msg.mention-me', { hasText: 'selam' }).waitFor();
    await A.waitForSelector('#typing:not(.on)', { state: 'attached', timeout: 3000 });
  });

  await t.test('tepkiler', async () => {
    const msg = B.locator('.msg', { hasText: 'ikinci satır' });
    await msg.hover();
    await msg.locator('.msg-tools button', { hasText: '🔥' }).click();
    const ra = A.locator('.msg', { hasText: 'ikinci satır' }).locator('.react');
    await ra.waitFor();
    assert.match(await ra.textContent(), /🔥\s*1/);
    assert.doesNotMatch(await ra.getAttribute('class'), /mine/);
    assert.match(await msg.locator('.react').getAttribute('class'), /mine/);
    // Aynı tepkiye tıklamak geri alır
    await ra.click();
    await B.waitForFunction(() => /🔥2/.test([...document.querySelectorAll('.react')].map((r) => r.textContent).join('')));
    await ra.click();
    await B.waitForFunction(() => /🔥1/.test([...document.querySelectorAll('.react')].map((r) => r.textContent).join('')));
  });

  await t.test('kendi mesajını silme', async () => {
    await send(A, 'silinecek mesaj');
    await B.locator('.msg', { hasText: 'silinecek mesaj' }).waitFor();
    // Başkasının mesajında silme yok
    assert.equal(await B.locator('.msg', { hasText: 'silinecek mesaj' }).locator('.del').count(), 0);
    const mine = A.locator('.msg', { hasText: 'silinecek mesaj' });
    await mine.hover();
    await mine.locator('.del').click({ modifiers: ['Shift'] });
    await B.waitForFunction(() => !document.querySelector('#chat-log').textContent.includes('silinecek mesaj'));
  });

  await t.test('görsel yükleme, önizleme ve büyütme', async () => {
    await A.setInputFiles('#file-input', { name: 'kare.png', mimeType: 'image/png', buffer: PNG });
    await A.waitForSelector('#attach-tray:not([hidden]) .tray-item');
    assert.equal(await A.textContent('.tray-name'), 'kare.png');
    await A.fill('#chat-input', 'işte görsel');
    await A.press('#chat-input', 'Enter');
    await A.waitForSelector('#attach-tray[hidden]', { state: 'attached' });
    const img = B.locator('.msg', { hasText: 'işte görsel' }).locator('.att-img img');
    await img.waitFor();
    await B.waitForFunction(() => {
      const i = document.querySelector('.att-img img');
      return i && i.complete && i.naturalWidth === 1;
    });
    await img.click();
    await B.waitForSelector('#lightbox:not([hidden])');
    assert.match(await B.textContent('#lb-name'), /kare\.png/);
    await B.keyboard.press('Escape');
    await B.waitForSelector('#lightbox[hidden]', { state: 'attached' });
    const src = await img.getAttribute('src');
    const r = await fetch(BASE + src);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  });

  await t.test('dosya: indirme kartı, ek olarak iner', async () => {
    await A.setInputFiles('#file-input', { name: 'notlar.html', mimeType: 'text/html', buffer: Buffer.from('<script>alert(1)</script>') });
    await A.waitForSelector('.tray-item');
    await A.press('#chat-input', 'Enter');
    const card = B.locator('a.att-file', { hasText: 'notlar.html' });
    await card.waitFor();
    assert.equal(await card.getAttribute('download'), 'notlar.html');
    const r = await fetch(BASE + (await card.getAttribute('href')));
    assert.equal(r.headers.get('content-type'), 'application/octet-stream');
    assert.match(r.headers.get('content-disposition'), /^attachment/);
  });

  await t.test('yapıştırma ve sürükle-bırak', async () => {
    await A.evaluate((b64) => {
      const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bin], 'image.png', { type: 'image/png' }));
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      document.querySelector('#chat-input').dispatchEvent(ev);
    }, PNG.toString('base64'));
    await A.waitForSelector('.tray-item');
    assert.match(await A.textContent('.tray-name'), /^ekran-goruntusu-\d{6}\.png$/);
    // Sürükle-bırak: bırakma alanı görünür, dosya eklenir
    await A.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['merhaba'], 'not.txt', { type: 'text/plain' }));
      window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    assert.equal(await A.isVisible('#drop-zone'), true);
    await A.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['merhaba'], 'not.txt', { type: 'text/plain' }));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    assert.equal(await A.isHidden('#drop-zone'), true);
    assert.equal(await A.locator('.tray-item').count(), 2);
    await A.press('#chat-input', 'Enter');
    await B.locator('a.att-file', { hasText: 'not.txt' }).waitFor();
    assert.ok((await B.locator('.att-img img').count()) >= 2);
  });

  await t.test('boyut sınırı', async () => {
    await A.setInputFiles('#file-input', { name: 'buyuk.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(1.5 * 1048576) });
    await A.waitForSelector('#toast:not([hidden])');
    assert.match(await A.textContent('#toast'), /çok büyük/);
    assert.equal(await A.locator('.tray-item').count(), 0);
    // Sunucu da sınırı uygular; kanalda olmayan yükleyemez
    const token = await A.evaluate(() => window.__rv.streamToken);
    let r = await fetch(`${BASE}/upload?k=${token}&name=x.bin`, { method: 'POST', body: Buffer.alloc(1.2 * 1048576) });
    assert.equal(r.status, 413);
    r = await fetch(`${BASE}/upload?k=yanlis&name=x.bin`, { method: 'POST', body: Buffer.from('a') });
    assert.equal(r.status, 403);
  });

  await t.test('sohbeti gizleyince okunmamış sayacı', async () => {
    await B.click('#chat-toggle');
    assert.equal(await B.isHidden('#chat-pane'), true);
    await send(A, 'gizliyken gelen');
    await B.waitForSelector('#chat-badge:not([hidden])');
    assert.equal(await B.textContent('#chat-badge'), '1');
    await B.click('#chat-toggle');
    assert.equal(await B.isVisible('#chat-pane'), true);
    assert.equal(await B.isHidden('#chat-badge'), true);
  });

  await t.test('sonradan gelen geçmişi görür', async () => {
    const C = await join(browser, 'Cem');
    await C.locator('.msg', { hasText: 'gizliyken gelen' }).waitFor();
    assert.ok((await C.locator('.att-img img').count()) >= 2, 'görseller geçmişte olmalı');
    assert.equal(await C.locator('.msg', { hasText: 'silinecek mesaj' }).count(), 0);
    assert.match(await C.locator('.msg', { hasText: 'ikinci satır' }).locator('.react').textContent(), /🔥\s*1/);
    assert.deepEqual(C.errors, []);
    await C.context().close();
  });

  await t.test('kanal boşalınca dosyalar silinir', async () => {
    const src = await B.locator('.att-img img').first().getAttribute('src');
    await A.click('#leave-btn');
    await B.click('#leave-btn');
    await new Promise((r) => setTimeout(r, 300));
    const r = await fetch(BASE + src);
    assert.equal(r.status, 404);
  });

  await t.test('konsolda hata yok', () => {
    assert.deepEqual(A.errors, []);
    assert.deepEqual(B.errors, []);
  });
});
