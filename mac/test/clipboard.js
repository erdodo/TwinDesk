// Tests for mac/clipboard.js and the clipboard part of mac/fclip.js with a fake pasteboard, helper and link.
// Run with plain node (electron is stubbed): node mac/test/clipboard.js
'use strict';
const assert = require('assert');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

// ---- fake electron: a pasteboard with a change count ----
const pb = { count: 1, text: '', png: null, files: [] };
const bump = (patch) => { Object.assign(pb, { text: '', png: null, files: [] }, patch); pb.count++; };
const fakeImage = (png) => ({ isEmpty: () => !png, toPNG: () => png, getSize: () => ({ width: 2, height: 3 }) });
const electron = {
  clipboard: {
    readText: async () => pb.text,
    writeText: (t) => bump({ text: t }),
    readImage: () => fakeImage(pb.png),
    writeImage: (img) => bump({ png: img.toPNG() }),
  },
  nativeImage: { createFromBuffer: (b) => fakeImage(b) },
  globalShortcut: { unregisterAll() {}, register: () => true },
  app: { getPath: () => fs.mkdtempSync(path.join(os.tmpdir(), 'clip-test-')) },
  shell: {}, screen: {},
};
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === 'electron' ? electron : load.call(this, request, ...rest);
};

const P = require('../../shared/protocol.js');
const { Clipboard } = require('../clipboard.js');
const { FileClip, pruneCache } = require('../fclip.js');

let now = 1000;
Date.now = () => now;
const T = P.T;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pixels')]);

function rig(over = {}) {
  const settings = { macId: 'M', clipboard: { enabled: true, send: true, receive: true, mode: 'instant', skipConcealed: true, maxKB: 256, images: true, files: true, filesMaxMB: 50, historySize: 20, ...over } };
  const server = new EventEmitter();
  server.current = { name: 'PC', deviceId: 'W' };
  server.sent = [];
  server.sendToClient = (m) => server.sent.push(m);
  const helper = new EventEmitter();
  helper.send = () => {};
  helper.wrote = [];
  helper.request = async (cmd, args) => {
    if (cmd === 'clipboardInfo') return { changeCount: pb.count, concealed: false, text: !!pb.text, image: !!pb.png, ...(pb.files.length ? { files: pb.files } : {}) };
    if (cmd === 'clipboardFiles') { helper.wrote.push(args.paths); bump({ files: args.paths }); return { changeCount: pb.count }; }
    throw new Error(cmd);
  };
  const clip = new Clipboard(server, helper, () => settings);
  clip.fileClip = { announced: [], announceClipboard: async (paths, stamp, mb) => clip.fileClip.announced.push({ paths, stamp, mb }), retractAuto() {} };
  // The helper's watcher: tell about the current pasteboard (what Pasteboard.swift emits after a change).
  const watch = async (initial = false) => {
    const i = await helper.request('clipboardInfo');
    helper.emit('event', 'clipboard', { event: 'clipboard', initial, ...i });
    await clip.chain;
  };
  const copy = async (patch) => { bump(patch); await watch(); };
  const sentOf = (t) => server.sent.filter((m) => m.t === t);
  return { clip, server, helper, settings, watch, copy, sentOf };
}
const flush = async (clip) => { for (let i = 0; i < 4; i++) { await new Promise((r) => setImmediate(r)); await clip.chain; } };

(async () => {
  // The reported bug: Windows copies A, the Mac copies B later, A's late push arrives: B stays.
  {
    bump({}); now = 1000;
    const r = rig({ mode: 'switch' });
    await r.watch(true);
    now = 2000; // the Windows copy happens at t=2000 on its clock (message in flight)
    const a = { t: T.CLIP, text: 'A', ts: 2000, o: 'W' };
    now = 2100;
    await r.copy({ text: 'B' }); // the Mac copies B afterwards
    now = 2500;
    r.server.emit(`t:${T.CLIP}`, a); // A's late push
    await flush(r.clip);
    assert.strictEqual(pb.text, 'B', 'a late push of an older copy must not replace the newer local copy');
    // Switch mode: B is sent when switching, with the time of the copy, not the time of sending
    now = 9000;
    await r.clip.sendIfChanged('switch');
    const [b] = r.sentOf(T.CLIP);
    assert.strictEqual(b.text, 'B');
    assert.strictEqual(b.o, 'M');
    assert.ok(b.ts >= 2100 && b.ts < 2500, `stamp is the copy time (${b.ts})`);
    // and asking again (clip.request) answers with the same original stamp
    now = 9500;
    r.server.emit(`t:${T.CLIP_REQUEST}`);
    await flush(r.clip);
    assert.strictEqual(r.sentOf(T.CLIP)[1].ts, b.ts);
  }

  // A newer incoming copy is applied, and the write is not taken for a local copy (no echo, no restamp).
  {
    now = 3000;
    const r = rig();
    r.server.emit(`t:${T.CLIP}`, { t: T.CLIP, text: 'from PC', ts: 3000, o: 'W' });
    await flush(r.clip);
    assert.strictEqual(pb.text, 'from PC');
    await r.watch(); // the helper reports the write a moment later
    await flush(r.clip);
    assert.strictEqual(r.sentOf(T.CLIP).length, 0, 'applied text is not sent back');
    // an old app sends no time: counts as copied now
    now = 3100;
    r.server.emit(`t:${T.CLIP}`, { t: T.CLIP, text: 'old app' });
    await flush(r.clip);
    assert.strictEqual(pb.text, 'old app');
    // an older stamped copy is refused afterwards
    r.server.emit(`t:${T.CLIP}`, { t: T.CLIP, text: 'stale', ts: 3050, o: 'W' });
    await flush(r.clip);
    assert.strictEqual(pb.text, 'old app');
  }

  // Instant mode sends a new copy at once, only once; the item present at start is not sent.
  {
    now = 4000;
    bump({ text: 'there before' });
    const r = rig();
    await r.watch(true);
    assert.strictEqual(r.sentOf(T.CLIP).length, 0);
    now = 4100;
    await r.copy({ text: 'new' });
    await r.watch();
    const sent = r.sentOf(T.CLIP);
    assert.strictEqual(sent.length, 1);
    assert.deepStrictEqual([sent[0].text, sent[0].ts, sent[0].o], ['new', 4100, 'M']);
    // Send off: still stamped (order kept), nothing sent
    r.settings.clipboard.send = false;
    now = 4200;
    await r.copy({ text: 'quiet' });
    assert.strictEqual(r.sentOf(T.CLIP).length, 1);
    now = 4300;
    r.server.emit(`t:${T.CLIP}`, { t: T.CLIP, text: 'older', ts: 4150, o: 'W' });
    await flush(r.clip);
    assert.strictEqual(pb.text, 'quiet', 'the quiet local copy is still newer than 4150');
  }

  // clip.latest after welcome: said when we hold a copy, asked for when theirs is newer.
  {
    now = 5000;
    const r = rig();
    await r.copy({ text: 'mine' });
    r.server.sent.length = 0;
    r.server.emit('client', r.server.current);
    const latest = r.sentOf(T.CLIP_LATEST)[0];
    assert.ok(latest && latest.kind === 'text' && latest.o === 'M');
    r.server.emit(`t:${T.CLIP_LATEST}`, { t: T.CLIP_LATEST, ts: latest.ts - 5, o: 'W', kind: 'text' });
    await flush(r.clip);
    assert.strictEqual(r.sentOf(T.CLIP_REQUEST).length, 0, 'theirs is older: nothing to ask');
    r.server.emit(`t:${T.CLIP_LATEST}`, { t: T.CLIP_LATEST, ts: latest.ts + 5, o: 'W', kind: 'text' });
    await flush(r.clip);
    assert.strictEqual(r.sentOf(T.CLIP_REQUEST).length, 1, 'theirs is newer: ask for it');
    r.settings.clipboard.receive = false;
    r.server.emit(`t:${T.CLIP_LATEST}`, { t: T.CLIP_LATEST, ts: latest.ts + 50, o: 'W', kind: 'text' });
    await flush(r.clip);
    assert.strictEqual(r.sentOf(T.CLIP_REQUEST).length, 1, 'receiving is off: do not ask');
  }

  // Images: sent as clip.image with the copy time, applied when newer, switch off honoured, no echo.
  {
    now = 6000;
    const r = rig();
    await r.copy({ png: PNG });
    const [img] = r.sentOf(T.CLIP_IMAGE);
    assert.ok(img && img.o === 'M' && img.ts === 6000 && Buffer.from(img.png, 'base64').equals(PNG));
    now = 6100;
    r.server.emit(`t:${T.CLIP_IMAGE}`, { ...img, id: 'x1', ts: 6050, o: 'W' });
    await flush(r.clip);
    assert.ok(pb.png.equals(PNG) && r.sentOf(T.CLIP_IMAGE).length === 1, 'older image refused');
    const PNG2 = Buffer.concat([PNG, Buffer.from('2')]);
    r.server.emit(`t:${T.CLIP_IMAGE}`, { t: T.CLIP_IMAGE, id: 'x2', w: 1, h: 1, png: PNG2.toString('base64'), ts: 6200, o: 'W' });
    await flush(r.clip);
    assert.ok(pb.png.equals(PNG2), 'newer image applied');
    await r.watch();
    await flush(r.clip);
    assert.strictEqual(r.sentOf(T.CLIP_IMAGE).length, 1, 'applied image is not sent back');
    r.settings.clipboard.images = false;
    now = 6300;
    await r.copy({ png: PNG });
    assert.strictEqual(r.sentOf(T.CLIP_IMAGE).length, 1, 'images off: not sent');
    r.server.emit(`t:${T.CLIP_IMAGE}`, { t: T.CLIP_IMAGE, id: 'x3', w: 1, h: 1, png: PNG2.toString('base64'), ts: 6400, o: 'W' });
    await flush(r.clip);
    assert.ok(pb.png.equals(PNG), 'images off: not applied');
  }

  // Files: a file list on the clipboard is announced with the copy time; the text clipboard does not hide it.
  {
    now = 7000;
    const r = rig({ files: true, filesMaxMB: 10 });
    await r.copy({ files: ['/Users/x/a.txt', '/Users/x/b.txt'], text: 'a.txt' });
    const [an] = r.clip.fileClip.announced;
    assert.deepStrictEqual(an.paths, ['/Users/x/a.txt', '/Users/x/b.txt']);
    assert.deepStrictEqual([an.stamp.ts, an.stamp.o, an.mb], [7000, 'M', 10]);
    r.settings.clipboard.files = false;
    now = 7100;
    await r.copy({ files: ['/Users/x/c.txt'] });
    assert.strictEqual(r.clip.fileClip.announced.length, 1, 'files off: nothing announced');
  }

  // FileClip: an eager offer is fetched into the cache folder, then becomes the clipboard (not before, not if superseded).
  {
    now = 8000;
    bump({});
    const r = rig();
    await r.watch(true);
    const drop = new EventEmitter();
    drop.expected = [];
    drop.expectBatch = (id, dir, quiet) => drop.expected.push({ id, dir, quiet });
    const fc = new FileClip({ server: r.server, helper: r.helper, fileSend: {}, drop, getSettings: () => ({ files: { shortcuts: false, pasteKeys: 'Control+Alt+V' } }), clipboard: r.clip });
    r.server.current = { name: 'PC', deviceId: 'W' };
    const offer = { t: T.FCLIP_OFFER, id: 'f1', items: [{ name: 'a.txt', size: 3 }], files: 1, bytes: 3, ts: 8000, o: 'W', auto: true, eager: true };
    r.server.emit(`t:${T.FCLIP_OFFER}`, offer);
    assert.strictEqual(drop.expected.length, 1);
    assert.strictEqual(drop.expected[0].quiet, true);
    assert.ok(drop.expected[0].dir.startsWith(fc.cacheRoot));
    assert.strictEqual(r.sentOf(T.FCLIP_PASTE)[0].id, 'f1');
    const dir = drop.expected[0].dir;
    drop.emit('batch', { batch: 'f1', kind: 'paste', quiet: true, placed: [path.join(dir, 'a.txt')], files: 1, count: 1, ok: true });
    await flush(r.clip);
    assert.deepStrictEqual(pb.files, [path.join(dir, 'a.txt')]);
    await r.watch();
    await flush(r.clip);
    assert.strictEqual(r.clip.fileClip.announced.length, 0, 'received files are not announced again');
    // an offer older than what we know is ignored; a second one superseded before it arrived is not applied
    r.server.emit(`t:${T.FCLIP_OFFER}`, { ...offer, id: 'f0', ts: 7000 });
    assert.strictEqual(drop.expected.length, 1);
    r.server.emit(`t:${T.FCLIP_OFFER}`, { ...offer, id: 'f2', ts: 8100 });
    now = 8200;
    await r.copy({ text: 'typed later' });
    const dir2 = drop.expected[1].dir;
    drop.emit('batch', { batch: 'f2', kind: 'paste', quiet: true, placed: [path.join(dir2, 'b.txt')], files: 1, count: 1, ok: true });
    await flush(r.clip);
    assert.strictEqual(pb.text, 'typed later');
    assert.deepStrictEqual(r.helper.wrote.length, 1, 'a newer local copy keeps the clipboard');
    // too big for this side: not fetched
    r.server.emit(`t:${T.FCLIP_OFFER}`, { ...offer, id: 'f3', ts: 9000, bytes: 60 * 1048576 });
    assert.strictEqual(drop.expected.length, 2);
    // the clipboard sharing is off for files: an auto offer is ignored
    r.settings.clipboard.files = false;
    r.server.emit(`t:${T.FCLIP_OFFER}`, { ...offer, id: 'f4', ts: 9100 });
    assert.strictEqual(drop.expected.length, 2);
    assert.strictEqual(fc.incoming.id, 'f3');
  }

  // Cache cleanup: older than an hour goes, the newest few stay.
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-cache-'));
    const t0 = Date.now();
    for (let i = 0; i < 6; i++) {
      const d = path.join(root, `d${i}`);
      fs.mkdirSync(d);
      const when = new Date(t0 - (i + 1) * 30 * 60 * 1000); // 30 min, 60 min, …
      fs.utimesSync(d, when, when);
    }
    pruneCache(root, { now: t0 });
    assert.deepStrictEqual(fs.readdirSync(root).sort(), ['d0', 'd1', 'd2']);
    pruneCache(root, { now: t0 + 10 * 60 * 1000 });
    assert.strictEqual(fs.readdirSync(root).length, 3, 'the newest few always stay');
    fs.rmSync(root, { recursive: true });
  }

  console.log('mac clipboard tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
