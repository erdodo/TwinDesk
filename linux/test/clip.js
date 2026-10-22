// Tests for linux/clip.js (ordering, images, files) with a fake clipboard and link; no Electron needed.
// Run with: NODE_PATH=/path/to/node_modules node linux/test/clip.js
'use strict';
const assert = require('assert');
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');

// ---- fake electron ----
const board = { text: '', png: null, formats: [], buffers: {}, writes: [] };
const clearBoard = () => Object.assign(board, { text: '', png: null, formats: [], buffers: {} });
const electron = {
  clipboard: {
    availableFormats: () => board.formats.slice(),
    readText: () => board.text,
    readBuffer: (f) => board.buffers[f] || Buffer.alloc(0),
    readImage: () => ({ toPNG: () => board.png }),
    writeText: (t) => { clearBoard(); board.text = t; board.formats = ['text/plain']; board.writes.push('text'); },
    writeImage: (img) => { clearBoard(); board.png = img.buf; board.formats = ['image/png']; board.buffers['image/png'] = img.buf; board.writes.push('image'); },
    writeBuffer: (f, b) => { clearBoard(); board.buffers[f] = b; board.formats = [f]; },
  },
  nativeImage: { createFromBuffer: (buf) => ({ buf, isEmpty: () => !buf.length, getSize: () => ({ width: 4, height: 3 }), resize: () => ({ toDataURL: () => 'data:image/png;base64,THUMB' }) }) },
  app: { getPath: () => '/tmp' },
};
const load = Module._load;
Module._load = function (request, ...rest) { return request === 'electron' ? electron : load.call(this, request, ...rest); };

const P = require('../../shared/protocol.js');
const Clip = require('../clip.js');
const io = require('../clipio.js');
const T = P.T;

const PNG = (n) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(String(n))]);
const copyText = (t) => { clearBoard(); board.text = t; board.formats = ['text/plain']; };
const copyImage = (png) => { clearBoard(); board.png = png; board.formats = ['image/png']; board.buffers['image/png'] = png; };
const copyFiles = (...paths) => { clearBoard(); board.formats = ['text/uri-list']; board.buffers['text/uri-list'] = Buffer.from(paths.map((p) => 'file://' + p).join('\r\n')); };

function setup(settings = {}) {
  const link = new EventEmitter();
  link.on = link.addListener;
  link.sent = [];
  link.status = { state: 'connected' };
  link.send = (m) => { link.sent.push(m); return true; };
  const now = { t: 1000 };
  const cfg = { enabled: true, send: true, receive: true, mode: 'instant', skipConcealed: true, maxKB: 256, historySize: 20, images: true, files: true, filesMaxMB: 50, ...settings };
  const historyDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clip-test-')), 'hist');
  const clip = new Clip(link, () => cfg, () => {}, { selfId: 'L', now: () => now.t, historyDir });
  clearBoard();
  return { clip, link, now, cfg, historyDir, deliver: (m) => link.emit(m.t, m), sent: (t) => link.sent.filter((m) => m.t === t) };
}
const settle = () => new Promise((r) => setImmediate(r));

(async () => {
  // The reported bug: the other computer copied A, we copied B later; A's late push must not win.
  {
    const s = setup();
    await s.clip._scan(); // first look: whatever is there is not a copy
    await s.deliver({ t: T.CLIP, text: 'A', ts: 1000, o: 'W' }); await settle();
    assert.strictEqual(board.text, 'A', 'the first copy is applied');
    await s.clip._scan();
    assert.strictEqual(s.sent(T.CLIP).length, 0, 'applying is not seen as a local copy (no echo)');
    s.now.t = 2000;
    copyText('B');
    await s.clip._scan();
    const out = s.sent(T.CLIP);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].text, 'B');
    s.now.t = 2500;
    await s.deliver({ t: T.CLIP, text: 'A', ts: 1000, o: 'W' }); await settle(); // late push of the older copy
    assert.strictEqual(board.text, 'B', 'the late A does not replace the newer B');
    await s.deliver({ t: T.CLIP, text: 'A2', ts: 1900, o: 'W' }); await settle();
    assert.strictEqual(board.text, 'B', 'a copy made before B, arriving after it, is ignored');
    await s.deliver({ t: T.CLIP, text: 'C', ts: 2600, o: 'W' }); await settle();
    assert.strictEqual(board.text, 'C', 'a newer copy is applied');
    await s.deliver({ t: T.CLIP, text: 'old app' }); await settle();
    assert.strictEqual(board.text, 'old app', 'an older app sends no time: counts as copied on arrival');
  }

  // A local copy is noticed (and stamped) in switch mode too; a late send keeps the time of the copy.
  {
    const s = setup({ mode: 'switch' });
    await s.clip._scan();
    s.now.t = 3000;
    copyText('local');
    await s.clip._scan();
    assert.strictEqual(s.sent(T.CLIP).length, 0, 'switch mode sends nothing yet');
    s.now.t = 9000;
    await s.deliver({ t: T.CLIP, text: 'late', ts: 2000, o: 'W' }); await settle();
    assert.strictEqual(board.text, 'local', 'the copy made here is newer than the push, though nothing was sent');
    s.now.t = 9500;
    await s.clip.sendIfChanged();
    const m = s.sent(T.CLIP);
    assert.strictEqual(m.length, 1);
    assert.strictEqual(m[0].ts, 3000, 'the message carries the time of the copy, not of sending');
    assert.strictEqual(m[0].o, 'L');
    await s.deliver({ t: T.CLIP_REQUEST, force: true }); await settle();
    assert.strictEqual(s.sent(T.CLIP).length, 2);
    assert.strictEqual(s.sent(T.CLIP)[1].ts, 3000, 'a request answer keeps the original time');
    await s.deliver({ t: T.CLIP_REQUEST }); await settle();
    assert.strictEqual(s.sent(T.CLIP).length, 2, 'an older app asking again gets nothing twice');
  }

  // After welcome: clip.latest goes out; a newer one on the other side is requested.
  {
    const s = setup();
    await s.clip._scan();
    s.now.t = 4000;
    copyText('mine');
    await s.clip._scan();
    s.link.emit('welcome', {});
    const l = s.sent(T.CLIP_LATEST);
    assert.strictEqual(l.length, 1);
    assert.deepStrictEqual([l[0].ts, l[0].o, l[0].kind], [4000, 'L', 'text']);
    await s.deliver({ t: T.CLIP_LATEST, ts: 3000, o: 'W', kind: 'text' }); await settle();
    assert.strictEqual(s.sent(T.CLIP_REQUEST).length, 0, 'older: not asked for');
    await s.deliver({ t: T.CLIP_LATEST, ts: 5000, o: 'W', kind: 'text' }); await settle();
    assert.strictEqual(s.sent(T.CLIP_REQUEST).length, 1, 'newer: asked for');
    assert.strictEqual(s.sent(T.CLIP_REQUEST)[0].force, true);
  }

  // Images: sent as clip.image with the time of the copy, applied when newer, switch off honoured.
  {
    const s = setup();
    await s.clip._scan();
    s.now.t = 5000;
    copyImage(PNG(1));
    await s.clip._scan();
    const im = s.sent(T.CLIP_IMAGE);
    assert.strictEqual(im.length, 1);
    assert.strictEqual(im[0].ts, 5000);
    assert.strictEqual(Buffer.from(im[0].png, 'base64').equals(PNG(1)), true);
    const other = { t: T.CLIP_IMAGE, id: 'img2', w: 2, h: 2, png: PNG(2).toString('base64'), ts: 6000, o: 'W' };
    await s.deliver(other); await settle();
    assert.strictEqual(board.png.equals(PNG(2)), true, 'a newer image is applied');
    await s.clip._scan();
    assert.strictEqual(s.sent(T.CLIP_IMAGE).length, 1, 'the applied image is not sent back');
    await s.deliver({ ...other, id: 'img3', png: PNG(3).toString('base64'), ts: 5500 }); await settle();
    assert.strictEqual(board.png.equals(PNG(2)), true, 'an older image is ignored');
    s.cfg.images = false;
    copyImage(PNG(4));
    await s.clip._scan();
    assert.strictEqual(s.sent(T.CLIP_IMAGE).length, 1, 'images off: not sent');
    await s.deliver({ ...other, id: 'img5', png: PNG(5).toString('base64'), ts: 9000 }); await settle();
    assert.strictEqual(board.png.equals(PNG(4)), true, 'images off: not applied');
    s.cfg.images = true;
    await s.deliver({ ...other, id: 'bad', png: Buffer.from('not a png').toString('base64'), ts: 9500 }); await settle();
    assert.strictEqual(board.png.equals(PNG(4)), true, 'not a PNG: ignored');
  }

  // Text beats an image copied with it; files beat the text a file manager adds.
  {
    const s = setup();
    await s.clip._scan();
    s.now.t = 7000;
    board.text = 'cell'; board.png = PNG(7); board.formats = ['text/plain', 'image/png']; board.buffers['image/png'] = PNG(7);
    await s.clip._scan();
    assert.strictEqual(s.sent(T.CLIP).length, 1);
    assert.strictEqual(s.sent(T.CLIP_IMAGE).length, 0);
  }
  {
    const s = setup();
    const copied = [];
    s.clip.fileClip = { clipCopied: (p, st, limit) => copied.push([p, st, limit]), clipboardFiles: async () => [], isCache: (p) => p[0].startsWith('/cache/'), acceptFiles: async () => true };
    await s.clip._scan();
    s.now.t = 8000;
    copyFiles('/home/u/a.txt', '/home/u/b%20c.txt');
    board.text = 'a.txt\nb c.txt';
    board.formats.push('text/plain');
    await s.clip._scan();
    assert.strictEqual(copied.length, 1);
    assert.deepStrictEqual(copied[0][0], ['/home/u/a.txt', '/home/u/b c.txt']);
    assert.strictEqual(copied[0][1].ts, 8000);
    assert.strictEqual(copied[0][2], 50 * 1048576);
    assert.strictEqual(s.sent(T.CLIP).length, 0, 'the names are not sent as text');
    s.now.t = 8500;
    copyFiles('/cache/x/a.txt');
    await s.clip._scan();
    assert.strictEqual(copied.length, 1, 'received files in the cache are never announced again');
    s.cfg.files = false;
    copyFiles('/home/u/c.txt');
    await s.clip._scan();
    assert.strictEqual(copied.length, 1, 'files off: not announced');
  }

  // Receiving files: applyFiles only while that offer is still the newest copy.
  {
    const s = setup();
    const written = [];
    const w = io.writeFiles;
    io.writeFiles = async (p) => { written.push(p); copyFiles(...p); return true; };
    await s.clip._scan();
    assert.strictEqual(await s.clip.acceptFiles({ id: 'o1', ts: 1500, o: 'W' }), true);
    assert.strictEqual(await s.clip.acceptFiles({ id: 'o0', ts: 1200, o: 'W' }), false, 'an older offer');
    assert.strictEqual(await s.clip.applyFiles(['/cache/o1/a'], 'o1'), true);
    await s.clip._scan();
    assert.strictEqual(s.link.sent.length, 0, 'a received file list is not a local copy');
    assert.strictEqual(await s.clip.acceptFiles({ id: 'o2', ts: 1700, o: 'W' }), true);
    s.now.t = 3000;
    copyText('typed meanwhile');
    assert.strictEqual(await s.clip.applyFiles(['/cache/o2/a'], 'o2'), false, 'a newer local copy keeps the clipboard');
    assert.strictEqual(written.length, 1);
    io.writeFiles = w;
  }

  // Recent list: both directions, text / image / files.
  {
    const s = setup();
    s.clip.fileClip = { retract() {}, clipCopied: () => {}, clipboardFiles: async () => [], isCache: () => false, acceptFiles: async () => true };
    await s.clip._scan();
    s.now.t = 2000; copyText('out text'); await s.clip._scan();
    await s.deliver({ t: T.CLIP, text: 'in text', ts: 3000, o: 'W' }); await settle();
    s.now.t = 4000; copyImage(PNG(11)); await s.clip._scan();
    await s.deliver({ t: T.CLIP_IMAGE, id: 'im', w: 2, h: 2, png: PNG(12).toString('base64'), ts: 5000, o: 'W' }); await settle();
    const f = path.join(path.dirname(s.historyDir), 'doc.txt');
    fs.writeFileSync(f, 'hello');
    s.now.t = 6000; copyFiles(f); await s.clip._scan();
    const io0 = io.writeFiles;
    io.writeFiles = async (p) => { copyFiles(...p); return true; };
    await s.clip.acceptFiles({ id: 'o9', ts: 7000, o: 'W' });
    await s.clip.applyFiles([f], 'o9');
    io.writeFiles = io0;
    const rows = s.clip.view.history;
    assert.deepStrictEqual(rows.map((r) => r.kind + ':' + r.dir), ['files:in', 'files:out', 'image:in', 'image:out', 'text:in', 'text:out']);
    assert.strictEqual(rows[1].title, 'doc.txt');
    assert.strictEqual(rows[2].thumb, 'data:image/png;base64,THUMB', 'images get a thumbnail');
    assert.strictEqual(rows.every((r) => r.kept), true);
    assert.strictEqual(s.clip.previewHistory(rows[4].id).text, 'in text');
    assert.strictEqual(s.clip.previewHistory(rows[3].id).image.startsWith('data:image/png;base64,'), true);
    assert.strictEqual(s.clip.previewHistory(rows[1].id).files[0].name, 'doc.txt');

    // Copy again: back on the clipboard, a new copy stamped now and sent; not listed twice.
    s.now.t = 8000;
    const n = rows.length;
    const img = rows.find((r) => r.kind === 'image' && r.dir === 'in');
    assert.strictEqual(await s.clip.copyHistory(img.id), true);
    assert.strictEqual(board.png.equals(PNG(12)), true, 'the image is back on the clipboard');
    const sent = s.sent(T.CLIP_IMAGE);
    assert.strictEqual(sent.length, 2);
    assert.strictEqual(sent[1].ts, 8000, 'stamped as a new copy');
    await s.clip._scan();
    assert.strictEqual(s.sent(T.CLIP_IMAGE).length, 2, 'no double stamp or echo');
    assert.strictEqual(s.clip.view.history.length, n, 'copying again does not add a row');
    s.now.t = 8500;
    const txt = rows.find((r) => r.kind === 'text' && r.dir === 'in');
    await s.clip.copyHistory(txt.id);
    assert.strictEqual(board.text, 'in text');
    assert.strictEqual(s.sent(T.CLIP).slice(-1)[0].ts, 8500);
    await s.deliver({ t: T.CLIP, text: 'older', ts: 8100, o: 'W' }); await settle();
    assert.strictEqual(board.text, 'in text', 'the copy again beats older copies');
    s.now.t = 8800;
    await s.clip.copyHistory(rows.find((r) => r.kind === 'files' && r.dir === 'in').id);
    assert.strictEqual(board.formats.length === 1 && String(board.buffers[board.formats[0]]).includes(path.join(s.historyDir, '')), true, 'files go back as a file list (the kept copies)');
    assert.strictEqual(await s.clip.copyHistory('nope'), false);

    // Not kept (too big): listed, cannot be copied.
    s.clip.history.maxBytes = 8; // an image is kept only up to a quarter of the budget
    s.now.t = 9000; copyImage(PNG(13)); await s.clip._scan();
    const big = s.clip.view.history[0];
    assert.strictEqual(big.kept, false);
    const before = board.png;
    copyText('x'); await s.clip._scan();
    assert.strictEqual(await s.clip.copyHistory(big.id), false, 'not kept: cannot be copied');
    assert.strictEqual(board.text, 'x');

    // Clear and quit wipe the folder.
    s.clip.clearHistory();
    assert.strictEqual(s.clip.view.history.length, 0);
    assert.strictEqual(fs.existsSync(s.historyDir), false);
    s.clip.shutdown();
  }

  // historySize 0: nothing kept, nothing on disk. And a fresh start wipes what an earlier run left.
  {
    const s = setup({ historySize: 0 });
    await s.clip._scan();
    s.now.t = 2000; copyText('t'); await s.clip._scan();
    s.now.t = 3000; copyImage(PNG(21)); await s.clip._scan();
    await s.deliver({ t: T.CLIP, text: 'in', ts: 9000, o: 'W' }); await settle();
    assert.strictEqual(s.clip.view.history.length, 0);
    assert.strictEqual(fs.existsSync(s.historyDir), false);
    s.cfg.historySize = 5; s.clip.applySettings();
    s.now.t = 10000; copyText('now on'); await s.clip._scan();
    assert.strictEqual(s.clip.view.history.length, 1);
    s.cfg.historySize = 0; s.clip.applySettings();
    assert.strictEqual(s.clip.view.history.length, 0, 'turning it off drops the list');

    const left = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-old-'));
    fs.mkdirSync(path.join(left, 'old'));
    const link = new EventEmitter(); link.status = { state: 'connected' }; link.send = () => true;
    const c2 = new Clip(link, () => ({ historySize: 5 }), () => {}, { historyDir: left });
    assert.strictEqual(fs.existsSync(left), false, 'wiped when the app starts');
    c2.shutdown();
    s.clip.shutdown();
  }

  console.log('linux/test/clip.js: all passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
