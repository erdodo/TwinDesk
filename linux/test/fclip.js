// Tests for the clipboard part of linux/fclip.js (eager copies, dedupe, cache) with fakes; no Electron needed.
// Run with: NODE_PATH=/path/to/node_modules node linux/test/fclip.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'fclip-test-'));
const electron = { app: { getPath: () => userData }, clipboard: { availableFormats: () => [], readText: () => '', readBuffer: () => Buffer.alloc(0) }, nativeImage: {} };
const load = Module._load;
Module._load = function (request, ...rest) { return request === 'electron' ? electron : load.call(this, request, ...rest); };

const P = require('../../shared/protocol.js');
const FileClip = require('../fclip.js');
const io = require('../clipio.js');
const T = P.T;

const MB = 1048576;
function setup(cfg = {}) {
  const link = new EventEmitter();
  link.on = link.addListener;
  link.sent = [];
  link.status = { state: 'connected' };
  link.send = (m) => { link.sent.push(m); return true; };
  const popups = [];
  const expected = [];
  const applied = [];
  const clip = {
    latest: { n: 0, copied: () => ({ ts: 100 + clip.latest.n++, o: 'L' }) },
    accepted: [],
    acceptFiles: async (m) => { clip.accepted.push(m.id); return !m.stale; },
    applyFiles: async (paths, id) => { applied.push([paths, id]); return true; },
  };
  const settings = { clipboard: { enabled: true, receive: true, send: true, files: true, filesMaxMB: 50, ...cfg }, files: { shortcuts: true, copyKeys: 'Control+Alt+C', pasteKeys: 'Control+Alt+V' } };
  const fileDrop = { plan: (paths) => ({ jobs: paths.map(() => 1), items: paths.map((p) => ({ name: path.basename(p), dir: false, size: 1 })), bytes: 10 * MB, list: [], dirs: [] }) };
  const fileRecv = { expectBatch: (id, dir, bytes) => expected.push([id, dir, bytes]) };
  const helper = new EventEmitter();
  helper.request = async () => null;
  const fc = new FileClip({ link, helper, fileDrop, fileRecv, settings, clip, peerName: () => 'Mac', popup: (k, t) => popups.push(t), onChange: () => {} });
  return { fc, link, popups, expected, applied, clip, settings };
}
const offer = (o) => ({ t: T.FCLIP_OFFER, id: 'x1', items: [{ name: 'a.txt', size: 5 }], files: 1, bytes: 5 * MB, ts: 500, o: 'W', ...o });
const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  // Sending: a normal copy is announced with the time of the copy; eager only under the limit.
  {
    const s = setup();
    const f = path.join(userData, 'a.txt');
    fs.writeFileSync(f, 'x');
    s.fc.clipCopied([f], { ts: 777, o: 'L' }, 50 * MB);
    const m = s.link.sent.find((x) => x.t === T.FCLIP_OFFER);
    assert.deepStrictEqual([m.ts, m.o, m.eager], [777, 'L', true]);
    s.fc.clipCopied([f], { ts: 778, o: 'L' }, 50 * MB);
    assert.strictEqual(s.link.sent.filter((x) => x.t === T.FCLIP_OFFER).length, 1, 'the same files twice in a row are offered once');
    const g = path.join(userData, 'g.txt');
    fs.writeFileSync(g, 'x');
    s.fc.clipCopied([g], { ts: 779, o: 'L' }, 1 * MB);
    assert.strictEqual(s.link.sent.filter((x) => x.t === T.FCLIP_OFFER).pop().eager, false, 'over the limit: lazy');
  }

  // Receiving: eager and small = fetched into the cache; then applied to the clipboard once it landed.
  {
    const s = setup();
    s.link.emit(T.FCLIP_OFFER, offer({ eager: true }));
    await tick();
    assert.strictEqual(s.expected.length, 1);
    assert.strictEqual(s.expected[0][1], path.join(userData, 'clipfiles', 'x1'));
    assert.strictEqual(s.link.sent.filter((x) => x.t === T.FCLIP_PASTE).length, 1);
    fs.mkdirSync(s.expected[0][1], { recursive: true });
    await s.fc.pasted({ kind: 'paste', batch: 'x1', ok: true, files: 1, count: 1, placed: [path.join(s.expected[0][1], 'a.txt')] });
    assert.strictEqual(s.applied.length, 1);
    assert.strictEqual(s.applied[0][1], 'x1');
    assert.strictEqual(s.fc.isCache(s.applied[0][0]), true);
    assert.strictEqual(s.popups.length, 0, 'no popup for the eager case');
  }
  {
    const s = setup({ filesMaxMB: 1 });
    s.link.emit(T.FCLIP_OFFER, offer({ eager: true }));
    await tick();
    assert.strictEqual(s.expected.length, 0, 'over our limit: not fetched');
    assert.match(s.popups[0], /5 MB copied on Mac: use Ctrl\+Alt\+V to paste/);
    assert.strictEqual(s.fc.incoming.id, 'x1', 'the shortcut can still paste it');
  }
  {
    const s = setup();
    s.link.emit(T.FCLIP_OFFER, offer({ eager: true, stale: true }));
    await tick();
    assert.strictEqual(s.expected.length, 0, 'an older copy than ours is ignored');
    assert.strictEqual(s.fc.incoming, null);
    const off = setup({ files: false });
    off.link.emit(T.FCLIP_OFFER, offer({ eager: true }));
    await tick();
    assert.strictEqual(off.expected.length, 0, 'files off: not fetched');
    assert.strictEqual(off.fc.incoming.id, 'x1', 'but the shortcut flow still works');
    const old = setup();
    old.link.emit(T.FCLIP_OFFER, { t: T.FCLIP_OFFER, id: 'x9', items: [], files: 1, bytes: 1 });
    await tick();
    assert.strictEqual(old.expected.length, 0, 'an older app offers lazily');
    assert.strictEqual(old.fc.incoming.id, 'x9');
  }

  // Cache: wiped at start, trimmed to the newest few.
  {
    const dir = path.join(userData, 'clipfiles');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 6; i++) {
      const d = path.join(dir, 'old' + i);
      fs.mkdirSync(d);
      fs.utimesSync(d, new Date(Date.now() - i * 1000), new Date(Date.now() - i * 1000));
    }
    const s = setup();
    assert.strictEqual(fs.existsSync(dir), false, 'wiped at start');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 6; i++) {
      const d = path.join(dir, 'old' + i);
      fs.mkdirSync(d);
      fs.utimesSync(d, new Date(Date.now() - i * 1000), new Date(Date.now() - i * 1000));
    }
    s.fc._sweep();
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['old0', 'old1', 'old2']);
  }

  // The file list written for the clipboard.
  assert.strictEqual(io.fileData(['/a/b c.txt', '/d'], 'x-special/gnome-copied-files'), 'copy\nfile:///a/b%20c.txt\nfile:///d');
  assert.strictEqual(io.fileData(['/a'], 'text/uri-list'), 'file:///a\r\n');
  assert.deepStrictEqual(io.filesIn('copy\nfile:///a/b%20c.txt\nhttp://x/y\n'), ['/a/b c.txt']);

  fs.rmSync(userData, { recursive: true, force: true });
  console.log('linux/test/fclip.js: all passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
