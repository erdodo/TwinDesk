// "The latest copy wins" together with the pool (docs/mesh.md, Clipboard: the latest copy wins):
// three devices W (Windows), M (Mac) and P (a second Windows PC) on fake links, joined by the same
// Net as clip-pool.js. Runs without Electron (a stub is installed):  node windows/test/clip-mesh.js
//
//   1. W copies A, M copies B later, A's late push (a held message, then a fresh pool item that
//      carries A's old time, then a relayed copy) reaches M and P: everyone ends with B.
//   2. An image goes through the pool: M applies it and relays it to P unchanged (one image per hop).
//   3. A file copy is announced to every device that takes files; the selected one fetches it from
//      the announcing device, a device that is not linked or selected only notes it, an older late
//      offer is ignored.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

// ---- electron stub (windows/fclip.js and the clipboards want these names) ----
const stub = {
  app: { getPath: () => os.tmpdir() },
  globalShortcut: { register: () => true, unregister() {}, unregisterAll() {} },
  shell: {},
  screen: {},
};
const cached = new Module('electron');
cached.exports = stub;
cached.loaded = true;
require.cache.electron = cached;
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return req === 'electron' ? 'electron' : origResolve.call(this, req, ...rest); };

const Clip = require('../clip.js');
const FileClip = require('../fclip.js');
const { Clipboard: MacClip } = require('../../mac/clipboard.js');
const S = require('../../shared/clipsync.js');
const { Net } = require('./support/fake-net.js');

const png = (n) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, n)]);
const fakeImage = (buf) => ({ isEmpty: () => !buf || !buf.length, getSize: () => ({ width: 4, height: 2 }), toBitmap: () => buf, toPNG: () => buf });
const nativeImage = { createFromBuffer: (b) => fakeImage(b) };
const later = (ms = 5) => new Promise((r) => setTimeout(r, ms)); // a later millisecond: copies are ordered by time
const made = [];

function settings(o = {}) {
  return { enabled: true, send: true, receive: true, mode: 'instant', historySize: 20, maxKB: 256, skipConcealed: true, images: true, files: true, filesMaxMB: 50, ...o };
}

// ---- a Windows PC ----
function winBoard() {
  const b = {
    text: '', image: null, files: null, buffers: {}, writes: [], imageWrites: [],
    availableFormats: () => (b.image ? ['image/png'] : b.text ? ['text/plain'] : []),
    readText: () => b.text,
    writeText(t) { b.text = t; b.image = null; b.files = null; b.buffers = {}; b.writes.push(t); },
    readBuffer: (f) => b.buffers[f] || Buffer.alloc(0),
    readImage: () => fakeImage(b.image),
    writeImage(im) { b.image = im.toPNG(); b.text = ''; b.imageWrites.push(b.image); },
  };
  return b;
}

async function winDevice(net, id, cfg) {
  const dev = net.add(id, { name: 'PC-' + id });
  dev.os = 'win';
  dev.board = winBoard();
  dev.settings = cfg || settings();
  dev.clip = new Clip({ bus: dev.bus, mesh: dev.mesh, getSettings: () => dev.settings, onChange: () => {}, clipboard: dev.board, nativeImage });
  made.push(dev.clip);
  await dev.clip.tick(); // the first look: what is on the clipboard at start is not a copy
  dev.copyText = async (text) => { dev.board.text = text; dev.board.image = null; await dev.clip.tick(); };
  dev.copyImage = async (buf) => { dev.board.image = buf; dev.board.text = ''; await dev.clip.tick(); };
  return dev;
}

// ---- a Mac ----
async function macDevice(net, id, cfg) {
  const dev = net.add(id, { name: 'Mac-' + id });
  dev.os = 'mac';
  const b = { text: '', png: null, writes: [], imageWrites: [] };
  b.readText = async () => b.text;
  b.writeText = (t) => { b.text = t; b.png = null; b.writes.push(t); };
  b.readImage = () => fakeImage(b.png);
  b.writeImage = (im) => { b.png = im.toPNG(); b.text = ''; b.imageWrites.push(b.png); };
  dev.board = b;
  dev.settings = cfg || settings();
  dev.count = 1;
  dev.helper = new EventEmitter();
  dev.helper.running = true;
  dev.helper.send = () => {};
  dev.helper.request = async (cmd) => (cmd === 'clipboardInfo' ? { changeCount: dev.count, concealed: false, text: !!b.text, image: !!b.png } : {});
  dev.clip = new MacClip({ bus: dev.bus, mesh: dev.mesh, getSettings: () => ({ clipboard: dev.settings }), helper: dev.helper, clipboard: b, nativeImage });
  const copied = async (ev) => { dev.count += 1; dev.helper.emit('event', 'clipboard', { changeCount: dev.count, concealed: false, ...ev }); await dev.clip.chain; };
  dev.copyText = async (text) => { b.text = text; b.png = null; await copied({ text: true }); };
  dev.copyImage = async (buf) => { b.png = buf; b.text = ''; await copied({ image: true }); };
  return dev;
}

const full = (a, b, c) => [[a, b], [b, c], [a, c]];
async function world(shape) {
  const net = new Net();
  const W = await winDevice(net, 'W');
  const M = await macDevice(net, 'M');
  const P = await winDevice(net, 'P');
  const links = shape === 'line' ? [['W', 'M'], ['M', 'P']] : full('W', 'M', 'P');
  for (const [a, b] of links) net.connect(a, b);
  await net.run();
  return { net, W, M, P };
}

const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });
const texts = (net, from, to) => net.sent('clip', from, to).map((e) => e.msg.text);

scenario('the report over three devices: W copies A, M copies B later, A pushed late: all end with B', async () => {
  const { net, W, M, P } = await world('full');
  await W.copyText('A'); // A goes out ...
  const held = net.queue.splice(0); // ... but is slow: W -> M and W -> P are still on the way
  assert.deepStrictEqual(held.map((e) => e.to).sort(), ['M', 'P']);
  await later();
  await M.copyText('B'); // the Mac copies B afterwards
  const stampA = W.clip.item.stamp;
  net.queue.push(...held); // now A's late push arrives, after B
  await net.run();
  for (const d of [W, M, P]) assert.strictEqual(d.board.text, 'B', d.id + ' ends with B');
  assert.deepStrictEqual(P.board.writes, ['B'], 'P never takes the older A');
  assert.deepStrictEqual(M.board.writes, [], 'M keeps its own B');
  assert.deepStrictEqual(W.board.writes, ['B']);

  // A fresh pool item (new sequence number) that carries A's old time: the time rule refuses it.
  W.clip.pool.publish(S.textMessage('A', stampA));
  await net.run();
  for (const d of [W, M, P]) assert.strictEqual(d.board.text, 'B', d.id + ' still B after the re-push');
  assert.deepStrictEqual(P.board.writes, ['B']);

  // The time of every copy is the time of the copy: W's message to the others carries W's stamp.
  const m = net.sent('clip', 'W', 'M')[0].msg;
  assert.deepStrictEqual([m.o, m.ts], ['W', stampA.ts]);
  // No echo: nobody restamped what was applied (B keeps M's time everywhere).
  for (const d of [W, P]) assert.strictEqual(d.clip.latest.cur.o, 'M');
  assert.strictEqual(net.sent('clip', 'P').length, 0, 'P never published anything');
});

scenario('a relayed copy that comes late is ignored too (line W - M - P)', async () => {
  const { net, W, M, P } = await world('line');
  await W.copyText('A');
  const held = net.queue.splice(0); // W -> M on the way
  await later();
  await M.copyText('B'); // M -> W and M -> P
  net.queue.push(...held);
  await net.run();
  // M took A from W as a fresh pool item, relayed it to P (h 1), and refused to apply it.
  const relayed = net.sent('clip', 'M', 'P').map((e) => e.msg).filter((x) => x.o === 'W');
  assert.strictEqual(relayed.length, 1, 'M relayed W\'s item to P');
  assert.strictEqual(relayed[0].h, 1);
  for (const d of [W, M, P]) assert.strictEqual(d.board.text, 'B', d.id);
  assert.deepStrictEqual(P.board.writes, ['B']);
  // The other order: a newer copy relayed through M reaches P once.
  await later();
  await W.copyText('C');
  await net.run();
  assert.strictEqual(P.board.text, 'C');
  assert.deepStrictEqual(P.board.writes, ['B', 'C']);
  assert.strictEqual(M.board.text, 'C');
});

scenario('a device that comes up asks for the newest copy (clip.latest to the new peer only)', async () => {
  const net = new Net();
  const W = await winDevice(net, 'W');
  const M = await macDevice(net, 'M');
  const P = await winDevice(net, 'P');
  net.connect('W', 'M');
  await net.run();
  await M.copyText('only on M, before P came'); // W has it
  await net.run();
  net.log.length = 0;
  net.connect('M', 'P');
  await net.run();
  assert.deepStrictEqual(net.sent('clip.latest').map((e) => [e.from, e.to]), [['M', 'P']], 'said to the new peer only');
  assert.strictEqual(P.board.text, 'only on M, before P came', 'P asked and got it');
  assert.strictEqual(W.board.text, 'only on M, before P came');
  assert.strictEqual(W.board.writes.length, 1, 'W did not get it twice');
});

scenario('an image goes through the pool: applied everywhere, relayed unchanged, not echoed', async () => {
  const { net, W, M, P } = await world('line');
  await W.copyImage(png(7));
  await net.run();
  assert.ok(M.board.png && M.board.png.equals(png(7)), 'M has the image');
  assert.ok(P.board.image && P.board.image.equals(png(7)), 'P has the image');
  const a = net.sent('clip.image', 'W', 'M')[0].msg;
  const b = net.sent('clip.image', 'M', 'P')[0].msg;
  assert.strictEqual(a.png, b.png, 'one image per hop, not re-encoded');
  assert.deepStrictEqual([b.o, b.ts, b.h], ['W', a.ts, 1]);
  assert.strictEqual(net.sent('clip.image', 'P').length, 0, 'P does not send it back');
  assert.strictEqual(net.sent('clip.image', 'M', 'W').length, 0, 'M does not echo it to W');
  assert.strictEqual(W.board.imageWrites.length, 0);

  // An older image arriving late is ignored; text copied after the image replaces it everywhere.
  await later();
  await P.copyText('after the image');
  await net.run();
  assert.strictEqual(W.board.text, 'after the image');
  assert.strictEqual(M.board.text, 'after the image');
  const old = S.imageMessage({ id: 'old', w: 4, h: 2, png: png(9) }, { ts: a.ts, o: 'W' });
  W.clip.pool.publish(old);
  await net.run();
  assert.strictEqual(M.board.text, 'after the image');
  assert.strictEqual(P.board.text, 'after the image');

  // A device with images off neither applies nor relays them.
  const toP = net.sent('clip.image', 'M', 'P').length;
  P.settings.images = false;
  P.clip.sendPolicy();
  await net.run();
  await later();
  await W.copyImage(png(8));
  await net.run();
  assert.ok(M.board.png.equals(png(8)));
  assert.strictEqual(net.sent('clip.image', 'M', 'P').length, toP, 'M no longer sends images to P: it said it does not take them');
  assert.notStrictEqual(P.board.image && P.board.image.toString('hex'), png(8).toString('hex'));
});

scenario('files: the offer goes to every device that takes files; the selected one fetches from the announcer', async () => {
  const { net, W, M, P } = await world('full');
  // W and P run the real FileClip (windows/fclip.js) over their buses; M is a Mac with no FileClip here.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-mesh-'));
  const file = path.join(tmp, 'a.txt');
  fs.writeFileSync(file, 'hello');
  for (const d of [W, P]) {
    d.rec = { expect: [], batches: [], drop: [] };
    const link = { status: { state: 'connected' }, send: (m) => !!(d.selected && d.bus.send(d.selected, m)), on: (t, fn) => { if (t !== 'closed' && t !== 'welcome') d.bus.on(t, (m, from) => from === d.selected && fn(m)); } };
    d.helper = { clipFiles: async () => d.board.files || [], setFileDrop: async (paths) => { d.rec.drop.push(paths); d.board.files = paths; d.board.buffers = { FileNameW: Buffer.from(paths.join('|')) }; d.board.text = ''; } };
    d.fileClip = new FileClip({
      link, bus: d.bus, helper: d.helper, clip: d.clip,
      fileDrop: {
        plan: (paths) => ({ jobs: paths.map(() => 1), items: paths.map((p) => ({ name: path.basename(p), dir: false, size: 5 })), bytes: 5 * paths.length, list: [], dirs: [] }),
        sendBatch: (paths, kind, id) => { d.rec.batches.push({ paths, kind, id }); return true; },
      },
      fileRecv: { expectBatch: (...a) => d.rec.expect.push(a) }, dragRecv: {},
      settings: { files: { shortcuts: false } }, peerName: () => 'peer', popup: () => {}, onChange: () => {},
    });
    d.clip.attachFiles({ helper: d.helper, fileClip: d.fileClip, cacheDir: path.join(tmp, 'cache-' + d.id) });
  }
  W.selected = 'P';
  P.selected = 'W';
  M.selected = null; // M has no direct fetch from W: it only notes the copy

  W.board.files = [file];
  W.board.buffers = { FileNameW: Buffer.from(file) };
  await W.clip.tick(); // Ctrl+C in Explorer
  await net.run();
  const offers = net.sent('fclip.offer', 'W');
  assert.deepStrictEqual(offers.map((e) => e.to).sort(), ['M', 'P'], 'announced to every device that takes files');
  const o = offers[0].msg;
  assert.ok(o.eager === true && o.o === 'W' && o.ts > 0, 'eager, with the time and device of the copy');
  assert.strictEqual(net.sent('fclip.offer', 'M').length + net.sent('fclip.offer', 'P').length, 0, 'offers are never relayed');
  // P (W is its selected device) fetches from W over its own link; M does not.
  assert.deepStrictEqual(net.sent('fclip.paste').map((e) => [e.from, e.to, e.msg.id]), [['P', 'W', o.id]]);
  assert.strictEqual(W.rec.batches.length, 1);
  assert.strictEqual(W.rec.batches[0].id, o.id);
  assert.strictEqual(P.rec.expect[0][0], o.id);
  assert.strictEqual(P.rec.expect[0][3], true, 'quiet: the clipboard puts them on its clipboard');
  assert.strictEqual(M.clip.latest.cur.id, o.id, 'M noted the copy for the order');
  assert.strictEqual(M.clip.latest.cur.kind, 'files');

  // The files land at P: they become its clipboard, and nobody announces them again.
  const got = path.join(P.rec.expect[0][1], 'a.txt');
  assert.strictEqual(P.clip.filesArrived({ quiet: true, batch: o.id, ok: true, placed: [got] }), true);
  await P.clip.queue;
  assert.deepStrictEqual(P.rec.drop, [[got]]);
  await P.clip.tick();
  await net.run();
  assert.strictEqual(net.sent('fclip.offer', 'P').length, 0, 'received files are not announced');

  // P copies text later; W's late re-offer of the older files is ignored at P (no second fetch).
  await later();
  await P.copyText('newer than the files');
  await net.run();
  assert.strictEqual(W.board.text, 'newer than the files');
  const before = net.sent('fclip.paste').length;
  W.fileClip.announce([file], { ts: o.ts, o: 'W' }, 'late-offer', 50, true, ['P']);
  await net.run();
  assert.strictEqual(net.sent('fclip.paste').length, before, 'an older offer is not fetched');
  assert.strictEqual(P.board.text, 'newer than the files');
});

async function main() {
  for (const s of scenarios) {
    try {
      await s.fn();
    } catch (e) {
      e.message = s.name + ': ' + e.message;
      throw e;
    }
  }
  for (const c of made) c.destroy();
  console.log('clip-mesh: ' + scenarios.length + ' scenarios passed');
}

main().catch((e) => {
  for (const c of made) c.destroy();
  console.error(e);
  process.exitCode = 1;
});
