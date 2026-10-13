'use strict';
// TURN uçtan uca testi: gerçek bir coturn (Docker) + iki Chrome, bağlantı sadece röle üzerinden.
// Docker çalışmıyorsa test atlanır.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const os = require('os');
const { chromium } = require('playwright');
const { createServer } = require('../server');

const PORT = 3997;
const SECRET = 'test-secret-123';
const NAME = 'riftvoice-turn-test';

// Mikrofon izni verilmiş sayfalarda Chrome, ağ kartlarının IP'lerinden çıkış yapar ve
// 127.0.0.1'e ulaşamaz; bu yüzden TURN'e makinenin yerel ağ IP'si üzerinden bağlanıyoruz.
function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return '127.0.0.1';
}

function dockerOk() {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('TURN: doğrudan bağlantı yokken ses röle üzerinden akar', { timeout: 180000, skip: !dockerOk() && 'Docker yok' }, async (t) => {
  execFileSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' });
  execFileSync('docker', [
    'run', '-d', '--name', NAME,
    '-p', '3478:3478/udp', '-p', '3478:3478/tcp', '-p', '49160-49170:49160-49170/udp',
    'coturn/coturn:4.6',
    '-n', '--listening-port=3478', '--min-port=49160', '--max-port=49170',
    '--realm=riftvoice', '--fingerprint',
    '--use-auth-secret', `--static-auth-secret=${SECRET}`,
    '--no-tls', '--no-dtls', '--no-cli', '--allow-loopback-peers', '--log-file=stdout',
  ]);
  const srv = createServer({
    quiet: true,
    env: { TURN_URLS: `turn:${lanIp()}:3478?transport=udp`, TURN_SECRET: SECRET, STUN_URLS: '' },
  });
  await new Promise((r) => srv.server.listen(PORT, r));
  const browser = await chromium.launch({
    channel: 'chrome',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  t.after(async () => {
    await browser.close().catch(() => {});
    await srv.close();
    execFileSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' });
  });

  const pages = [];
  for (const name of ['Jinx', 'Vi']) {
    const ctx = await browser.newContext({ permissions: ['microphone'] });
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${PORT}/r/turn-oda?relay=1`);
    await page.fill('#name-input', name);
    await page.click('#join-btn');
    pages.push(page);
  }
  for (const page of pages) {
    await page.waitForFunction(
      () => {
        const p = [...window.__rv.peers.values()][0];
        return p && p.pc && p.pc.connectionState === 'connected' && p.relay === true;
      },
      null,
      { timeout: 30000 }
    );
    assert.equal(await page.evaluate(() => location.search), '?relay=1');
    assert.match(await page.textContent('.participant:not(:first-child) .status-text'), /röle/);
  }
  const bytes = () =>
    pages[1].evaluate(async () => {
      let n = 0;
      (await [...window.__rv.peers.values()][0].pc.getStats()).forEach((r) => {
        if (r.type === 'inbound-rtp') n += r.bytesReceived;
      });
      return n;
    });
  const a = await bytes();
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok((await bytes()) > a, 'röle üzerinden ses akmıyor');
});
