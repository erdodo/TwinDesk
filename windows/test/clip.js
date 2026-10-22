// "The latest copy wins" on Windows: windows/clip.js with a fake clipboard, link, helper and file
// clip. Runs without Electron:  node windows/test/clip.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// ---- electron stub ----
const state = { text: '', image: null, buffers: {} };
const png = (n) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, n)]);
const fakeImage = (buf) => ({ isEmpty: () => !buf || !buf.length, getSize: () => ({ width: 4, height: 2 }), toBitmap: () => buf, toPNG: () => buf, resize: () => ({ toDataURL: () => 'data:image/png;base64,thumb' }) });
const electron = {
  clipboard: {
    availableFormats: () => [...(state.text ? ['text/plain'] : []), ...(state.image ? ['image/png'] : [])],
    readText: () => state.text,
    writeText: (t) => { state.text = t; state.image = null; state.buffers = {}; },
    readBuffer: (f) => state.buffers[f] || Buffer.alloc(0),
    readImage: () => fakeImage(state.image),
    writeImage: (im) => { state.image = im.toPNG(); state.text = ''; state.buffers = {}; },
  },
  nativeImage: { createFromBuffer: (b) => fakeImage(b) },
  app: { getPath: () => os.tmpdir() },
};
const cached = new Module('electron');
cached.exports = electron;
cached.loaded = true;
require.cache.electron = cached;
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return req === 'electron' ? 'electron' : origResolve.call(this, req, ...rest); };

const Clip = require('../clip.js');
const { Mesh } = require('../../shared/mesh.js');
const S = require('../../shared/clipsync.js');
const P = require('../../shared/protocol.js');

// ---- fakes ----
let now = 1_000_000;
const clock = () => new S.Clock(() => now);
const settings = (o) => ({ enabled: true, send: true, receive: true, mode: 'instant', skipConcealed: true, maxKB: 256, historySize: 20, images: true, files: true, filesMaxMB: 50, ...o });

function make(cfg, id = 'win') {
  const handlers = {};
  const peerHandlers = {};
  const sent = [];
  const send = (m) => { sent.push(m); return true; };
  // One old one-to-one peer ('mac': it sends no pool stamps, only the time of its copies).
  const mesh = new Mesh({ selfId: id });
  mesh.addPeer({ id: 'mac', name: 'Mac', os: 'mac', mesh: false, send });
  const bus = {
    on: (t, f) => { (handlers[t] = handlers[t] || []).push(f); },
    onPeer: (e, f) => { (peerHandlers[e] = peerHandlers[e] || []).push(f); },
    send: (to, m) => send(m),
    selectedId: () => 'mac',
    connectedIds: () => ['mac'],
  };
  const calls = { announce: [], expect: [], drop: [] };
  const clip = new Clip({ bus, mesh, getSettings: () => cfg, onChange: () => {} });
  clip.latest = new S.Latest({ selfId: id, clock: clock() });
  clip.attachFiles({
    helper: { clipFiles: async () => state.files || [], setFileDrop: async (paths) => { calls.drop.push(paths); state.files = paths; state.buffers = { FileNameW: Buffer.from(paths.join('|')) }; state.text = ''; } },
    fileClip: {
      fileRecv: { expectBatch: (...a) => calls.expect.push(a) },
      announce: (paths, stamp, fid, mb, fromClip, to) => { calls.announce.push({ paths, stamp, fid, mb, fromClip, to }); return { bytes: 1 }; },
      notice: () => {},
    },
    cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'clip-test-')),
    historyDir: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clip-hist-')), 'cliphistory'),
  });
  const deliver = (m) => { for (const f of handlers[m.t] || []) f(m, 'mac'); };
  const welcome = () => { for (const f of peerHandlers.welcome || []) f('mac', {}); };
  return { clip, sent, handlers, calls, deliver, welcome, mesh };
}
const reset = () => { state.text = ''; state.image = null; state.buffers = {}; state.files = null; now += 10000; };
const wait = () => new Promise((r) => setImmediate(r));
async function settle(clip) { await clip.tick(); await clip.queue; await wait(); }

let n = 0;
async function test(name, fn) {
  reset();
  try { await fn(); n++; console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n' + e.stack); process.exitCode = 1; }
}

(async () => {
  await test('the report: an older push never replaces a newer copy', async () => {
    const w = make(settings({ mode: 'switch' }));
    await w.clip.tick(); // first look
    state.text = 'A (windows)'; now += 1000;
    await w.clip.tick(); // copied here, nothing sent in switch mode
    assert.strictEqual(w.sent.filter((m) => m.t === 'clip').length, 0);
    const tA = w.clip.item.stamp.ts;
    // the Mac copies B later and sends it: applied
    w.deliver({ t: 'clip', text: 'B (mac)', ts: tA + 5000, o: 'mac' });
    await settle(w.clip);
    assert.strictEqual(state.text, 'B (mac)');
    // Windows' answer to a request carries the ORIGINAL time of A (here: nothing to send, B is newer)
    w.deliver({ t: 'clip.request' });
    await settle(w.clip);
    assert.strictEqual(w.sent.filter((m) => m.t === 'clip').length, 0);
    // a late push of the older copy A from the Mac's side must not win either
    w.deliver({ t: 'clip', text: 'A (late)', ts: tA, o: 'mac' });
    await settle(w.clip);
    assert.strictEqual(state.text, 'B (mac)');
  });

  await test('a late push of an older copy does not overwrite a newer local copy', async () => {
    const w = make(settings());
    await w.clip.tick();
    state.text = 'newer local'; now += 1000;
    await w.clip.tick();
    const t = w.sent.find((m) => m.t === 'clip');
    assert.strictEqual(t.text, 'newer local');
    assert.ok(t.ts > 0 && t.o === 'win');
    w.deliver({ t: 'clip', text: 'old from mac', ts: t.ts - 3000, o: 'mac' });
    await settle(w.clip);
    assert.strictEqual(state.text, 'newer local');
    w.deliver({ t: 'clip', text: 'old without time', ts: undefined }); // an older app: copied on arrival
    await settle(w.clip);
    assert.strictEqual(state.text, 'old without time');
  });

  await test('switch mode: the copy is stamped when it happens, the answer keeps that time', async () => {
    const w = make(settings({ mode: 'switch' }));
    await w.clip.tick();
    state.text = 'copied at T'; now += 1000;
    await w.clip.tick();
    const stamp = { ...w.clip.item.stamp };
    now += 60000; // a minute later the Mac asks
    w.deliver({ t: 'clip.request' });
    await settle(w.clip);
    const m = w.sent.find((x) => x.t === 'clip');
    assert.strictEqual(m.ts, stamp.ts);
    assert.strictEqual(m.o, 'win');
    w.deliver({ t: 'clip.request' }); // asked again: not sent twice
    await settle(w.clip);
    assert.strictEqual(w.sent.filter((x) => x.t === 'clip').length, 1);
  });

  await test('applying an incoming item is not a new copy (no echo, no restamp)', async () => {
    const w = make(settings());
    await w.clip.tick();
    w.deliver({ t: 'clip', text: 'from mac', ts: now + 5000, o: 'mac' });
    await settle(w.clip);
    const cur = { ...w.clip.latest.cur };
    now += 2000;
    await w.clip.tick();
    await w.clip.tick();
    assert.strictEqual(w.sent.filter((m) => m.t === 'clip').length, 0);
    assert.deepStrictEqual(w.clip.latest.cur, cur);
  });

  await test('welcome sends clip.latest; a newer peer copy is requested, an older one is not', async () => {
    const w = make(settings());
    await w.clip.tick();
    state.text = 'x'; now += 1000;
    await w.clip.tick();
    w.sent.length = 0;
    w.welcome();
    const lm = w.sent.find((m) => m.t === 'clip.latest');
    assert.ok(lm && lm.ts === w.clip.item.stamp.ts && lm.kind === 'text');
    w.sent.length = 0;
    w.deliver({ t: 'clip.latest', ts: lm.ts - 1, o: 'mac', kind: 'text' });
    assert.strictEqual(w.sent.filter((m) => m.t === 'clip.request').length, 0);
    w.deliver({ t: 'clip.latest', ts: lm.ts + 1, o: 'mac', kind: 'text' });
    assert.strictEqual(w.sent.filter((m) => m.t === 'clip.request').length, 1);
    // after a new session the unsent-looking copy is offered again when the peer asks
    w.sent.length = 0;
    w.welcome();
    w.deliver({ t: 'clip.request' });
    await settle(w.clip);
    assert.strictEqual(w.sent.filter((m) => m.t === 'clip').length, 1);
  });

  await test('images: sent as clip.image with the copy time, applied once, no echo', async () => {
    const w = make(settings());
    await w.clip.tick();
    state.image = png(1); now += 1000;
    await w.clip.tick();
    const m = w.sent.find((x) => x.t === 'clip.image');
    assert.ok(m && m.ts > 0 && m.o === 'win' && Buffer.from(m.png, 'base64').equals(png(1)));
    // incoming newer image
    w.deliver({ t: 'clip.image', id: 'img2', w: 4, h: 2, png: png(2).toString('base64'), ts: m.ts + 5000, o: 'mac' });
    await settle(w.clip);
    assert.ok(state.image.equals(png(2)));
    now += 5000;
    await w.clip.tick();
    assert.strictEqual(w.sent.filter((x) => x.t === 'clip.image').length, 1);
    // older image: ignored; images off: ignored
    w.deliver({ t: 'clip.image', id: 'img3', w: 4, h: 2, png: png(3).toString('base64'), ts: m.ts, o: 'mac' });
    await settle(w.clip);
    assert.ok(state.image.equals(png(2)));
    const off = make(settings({ images: false }));
    await off.clip.tick();
    state.image = png(4);
    await off.clip.tick();
    assert.strictEqual(off.sent.filter((x) => x.t === 'clip.image').length, 0);
  });

  await test('concealed text is stamped but not sent', async () => {
    const w = make(settings());
    await w.clip.tick();
    state.text = 'secret'; state.buffers = { 'Clipboard Viewer Ignore': Buffer.from([1]) };
    await w.clip.tick();
    assert.strictEqual(w.sent.filter((x) => x.t === 'clip').length, 0);
    assert.strictEqual(w.clip.latest.cur.kind, 'text');
  });

  await test('files: a copy in Explorer is announced with its time; received files are not re-announced', async () => {
    const w = make(settings());
    await w.clip.tick();
    const f = path.join(w.clip.cacheDir, 'a.txt');
    fs.writeFileSync(f, 'hi');
    state.files = [f]; state.buffers = { FileNameW: Buffer.from(f) }; now += 1000;
    await w.clip.tick();
    assert.strictEqual(w.calls.announce.length, 1);
    const a = w.calls.announce[0];
    assert.deepStrictEqual(a.paths, [f]);
    assert.ok(a.stamp.ts > 0 && a.stamp.o === 'win' && a.mb === 50 && a.fromClip === true);
    // the other computer copies files (eager): fetched, then put on the clipboard
    const inc = { id: 'off1', bytes: 10, files: 1 };
    assert.ok(w.clip.latest.accept({ ts: a.stamp.ts + 5000, o: 'mac' }, 'files', 'off1')); // fclip.js accepts the offer
    w.clip.fileOffered(inc, { eager: true });
    assert.strictEqual(w.calls.expect.length, 1);
    assert.strictEqual(w.calls.expect[0][0], 'off1');
    assert.strictEqual(w.calls.expect[0][3], true);
    assert.ok(w.sent.some((m) => m.t === 'fclip.paste' && m.id === 'off1'));
    const got = path.join(w.calls.expect[0][1], 'b.txt');
    assert.strictEqual(w.clip.filesArrived({ quiet: true, batch: 'off1', ok: true, placed: [got] }), true);
    await settle(w.clip);
    assert.deepStrictEqual(w.calls.drop, [[got]]);
    now += 2000;
    await w.clip.tick();
    await w.clip.tick();
    assert.strictEqual(w.calls.announce.length, 1); // no echo
  });

  await test('files: over the size limit or off, no pull', async () => {
    const w = make(settings({ filesMaxMB: 1 }));
    w.clip.fileOffered({ id: 'big', bytes: 5 * 1024 * 1024, files: 1 }, { eager: true });
    assert.strictEqual(w.calls.expect.length, 0);
    const off = make(settings({ files: false }));
    off.clip.fileOffered({ id: 'x', bytes: 1, files: 1 }, { eager: true });
    assert.strictEqual(off.calls.expect.length, 0);
    assert.strictEqual(w.clip.filesArrived({ quiet: false }), false);
  });

  await test('pruneCache keeps the newest few and anything younger than an hour', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-prune-'));
    const t0 = Date.now();
    for (let i = 0; i < 6; i++) {
      const d = path.join(dir, 'set' + i);
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, 'f'), 'x');
      const t = new Date(t0 - (6 - i) * 3600e3); // set5 is the youngest (1 h), set0 the oldest (6 h)
      fs.utimesSync(d, t, t);
    }
    const fresh = path.join(dir, 'fresh');
    fs.mkdirSync(fresh);
    Clip.pruneCache(dir, t0);
    const left = fs.readdirSync(dir).sort();
    assert.deepStrictEqual(left, ['fresh', 'set4', 'set5']);
  });

  // ---- Recent list: kept data, copy again, preview ----
  const sendsOf = (w, t) => w.sent.filter((m) => m.t === t);

  await test('history: text, image and files are recorded in both directions', async () => {
    const w = make(settings());
    await w.clip.tick();
    state.text = 'sent text'; now += 1000;
    await w.clip.tick();
    state.text = ''; state.image = png(1); now += 1000;
    await w.clip.tick();
    const f = path.join(w.clip.cacheDir, 'report.pdf');
    fs.mkdirSync(w.clip.cacheDir, { recursive: true });
    fs.writeFileSync(f, 'pdf');
    state.files = [f]; state.buffers = { FileNameW: Buffer.from(f) }; now += 1000;
    await w.clip.tick();
    w.deliver({ t: 'clip', text: 'got text', ts: now + 5000, o: 'mac' });
    await settle(w.clip);
    w.deliver({ t: 'clip.image', id: 'im9', w: 4, h: 2, png: png(9).toString('base64'), ts: now + 6000, o: 'mac' });
    await settle(w.clip);
    const got = path.join(w.clip.cacheDir, 'off1', 'in.txt');
    fs.mkdirSync(path.dirname(got), { recursive: true });
    fs.writeFileSync(got, 'incoming');
    assert.ok(w.clip.latest.accept({ ts: now + 7000, o: 'mac' }, 'files', 'off1'));
    w.clip.fileOffered({ id: 'off1', bytes: 8, files: 1 }, { eager: true });
    w.clip.filesArrived({ quiet: true, batch: 'off1', ok: true, placed: [got] });
    await settle(w.clip);
    const rows = w.clip.view.history;
    assert.deepStrictEqual(rows.map((r) => r.kind + ':' + r.dir), ['files:in', 'image:in', 'text:in', 'files:out', 'image:out', 'text:out']);
    assert.strictEqual(rows[0].title, 'in.txt');
    assert.strictEqual(rows[3].title, 'report.pdf');
    assert.strictEqual(rows[1].title, 'Image 4×2');
    assert.ok(rows[1].thumb && rows[1].thumb.startsWith('data:image/'));
    assert.ok(rows.every((r) => r.kept));
    const pv = w.clip.previewHistory(rows[4].id);
    assert.ok(pv.image.startsWith('data:image/png;base64,'));
    assert.deepStrictEqual(w.clip.previewHistory(rows[0].id).files.map((x) => x.name), ['in.txt']);
  });

  await test('copyHistory: puts the item back as a new copy that is sent, text image and files', async () => {
    const w = make(settings());
    await w.clip.tick();
    state.text = 'one'; now += 1000;
    await w.clip.tick();
    state.text = ''; state.image = png(5); now += 1000;
    await w.clip.tick();
    const f = path.join(w.clip.cacheDir, 'a.txt');
    fs.mkdirSync(w.clip.cacheDir, { recursive: true });
    fs.writeFileSync(f, 'hi');
    state.files = [f]; state.buffers = { FileNameW: Buffer.from(f) }; now += 1000;
    await w.clip.tick();
    const rows = w.clip.view.history;
    const text = rows.find((r) => r.kind === 'text');
    const image = rows.find((r) => r.kind === 'image');
    const files = rows.find((r) => r.kind === 'files');
    // text
    w.sent.length = 0; now += 1000;
    assert.strictEqual(await w.clip.copyHistory(text.id), true);
    assert.strictEqual(state.text, 'one');
    const m = sendsOf(w, 'clip')[0];
    assert.ok(m && m.text === 'one' && m.ts >= now && m.o === 'win');
    now += 1000;
    await w.clip.tick(); await w.clip.tick();
    assert.strictEqual(sendsOf(w, 'clip').length, 1); // no echo, no second stamp
    assert.strictEqual(w.clip.latest.cur.ts, m.ts);
    // image
    now += 1000;
    assert.strictEqual(await w.clip.copyHistory(image.id), true);
    assert.ok(state.image.equals(png(5)));
    const im = sendsOf(w, 'clip.image')[0];
    assert.ok(im && im.ts > m.ts && Buffer.from(im.png, 'base64').equals(png(5)));
    await w.clip.tick();
    assert.strictEqual(sendsOf(w, 'clip.image').length, 1);
    // files: the kept copy goes back on the clipboard and is announced, not listed twice
    now += 1000;
    const before = w.clip.view.history.filter((r) => r.kind === 'files').length;
    assert.strictEqual(await w.clip.copyHistory(files.id), true);
    assert.strictEqual(w.calls.drop.length, 1);
    assert.notStrictEqual(w.calls.drop[0][0], f); // the kept copy, not the original
    assert.ok(fs.existsSync(w.calls.drop[0][0]));
    assert.strictEqual(w.calls.announce.length, 2);
    assert.ok(w.calls.announce[1].stamp.ts > im.ts);
    await w.clip.tick();
    assert.strictEqual(w.calls.announce.length, 2);
    assert.strictEqual(w.clip.view.history.filter((r) => r.kind === 'files').length, before);
  });

  await test('copyHistory: an item that was not kept cannot be copied', async () => {
    const w = make(settings());
    w.clip.hist.maxBytes = 40; // an image over a quarter of this is listed, not kept
    await w.clip.tick();
    state.image = png(2); now += 1000;
    await w.clip.tick();
    const row = w.clip.view.history[0];
    assert.strictEqual(row.kind, 'image');
    assert.strictEqual(row.kept, false);
    assert.strictEqual(row.thumb, undefined);
    state.text = 'other'; now += 1000;
    assert.strictEqual(await w.clip.copyHistory(row.id), false);
    assert.strictEqual(state.text, 'other');
    assert.strictEqual(await w.clip.copyHistory('nope'), false);
  });

  await test('historySize 0 keeps nothing and writes nothing to disk', async () => {
    const w = make(settings({ historySize: 0 }));
    await w.clip.tick();
    state.text = 'x'; now += 1000;
    await w.clip.tick();
    state.image = png(3); now += 1000;
    await w.clip.tick();
    assert.deepStrictEqual(w.clip.view.history, []);
    assert.ok(!fs.existsSync(w.clip.historyDir));
  });

  await test('history folder is wiped when the app starts, on Clear and on quit', async () => {
    const w = make(settings());
    fs.mkdirSync(path.join(w.clip.historyDir, 'old'), { recursive: true });
    fs.writeFileSync(path.join(w.clip.historyDir, 'old', 'x'), 'left over');
    w.clip.start();
    w.clip.stop();
    assert.ok(!fs.existsSync(w.clip.historyDir));
    await w.clip.tick();
    state.image = png(7); now += 1000;
    await w.clip.tick();
    assert.ok(fs.readdirSync(w.clip.historyDir).length);
    w.clip.clearHistory();
    assert.deepStrictEqual(w.clip.view.history, []);
    assert.ok(!fs.existsSync(w.clip.historyDir));
    w.clip.img = null; state.image = png(8); now += 1000;
    await w.clip.tick();
    assert.ok(fs.existsSync(w.clip.historyDir));
    w.clip.shutdown();
    assert.ok(!fs.existsSync(w.clip.historyDir));
  });

  console.log(n + ' passed' + (process.exitCode ? ', some FAILED' : ''));
})();
