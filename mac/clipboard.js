// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Clipboard sharing (text, images, files): directions, switch/instant mode, concealed filter, size
// limits, clip.policy both ways, and the Recent list (shared/clip-history.js: text in memory, images
// and files kept in the app's cache folder so they can be copied again and previewed). "The latest copy wins": every local
// copy is noticed as it happens (the helper watches NSPasteboard.changeCount) and stamped with
// shared/clipsync.js, so a late or repeated push of an older copy never replaces a newer one.
// Files copied in Finder go through fclip.js (announced with fclip.offer, fetched by the other side).
//
// Events: 'change' — this.view changed.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app, clipboard, nativeImage } = require('electron');
const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');
const { Latest, textMessage, imageMessage, readImage } = require('../shared/clipsync.js');
const { ClipHistory } = require('../shared/clip-history.js');
const { textKey, imageKey, filesKey, EchoGuard, Breaker } = require('../shared/clipguard.js');

// Electron 44's clipboard.readText() returns a Promise in the main process (older: a string).
const readText = async () => String((await clipboard.readText()) || '');
const THUMB = 64; // width of an image's thumbnail in the Recent list
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

// What a clipboard item IS, never how the system stores it (format lists, PNG bytes, line breaks).
// An image: its size and a sample of its raw pixels, whatever encoder made the PNG.
function imageKeyOf(img) {
  const { width, height } = img.getSize();
  let bmp;
  try { bmp = img.toBitmap(); } catch { bmp = img.toPNG(); }
  const step = Math.max(1, Math.floor(bmp.length / 16384));
  const sample = Buffer.alloc(Math.ceil(bmp.length / step) + 8);
  let n = sample.writeUInt32BE(bmp.length >>> 0, 0);
  for (let i = 0; i < bmp.length; i += step) sample[n++] = bmp[i];
  return imageKey(width, height, sha1(sample.subarray(0, n)));
}
// Files: names and sizes (the paths differ between computers).
function filesKeyOf(paths) {
  return filesKey(paths.map((p) => {
    let size = 0;
    try { size = fs.statSync(p).size; } catch { /* gone: size 0 */ }
    return { name: path.basename(p), size };
  }));
}

class Clipboard extends EventEmitter {
  // historyDir: where the Recent list keeps images and files (default: the app's cache folder).
  constructor(server, helper, getSettings, { historyDir } = {}) {
    super();
    this.server = server;
    this.helper = helper;
    this.getSettings = getSettings;
    this.latest = new Latest({ selfId: String(getSettings().macId || 'mac') });
    this.item = null; // what the clipboard holds: { kind, sig, stamp, concealed, sent, text|png,w,h|paths }
    this.applied = null; // signature of what we wrote ourselves (the helper then reports it as a change)
    this.ownCount = -1; // changeCount after our last write
    this.seen = -1; // last changeCount looked at
    this.chain = Promise.resolve(); // detections and sends one after the other
    this.fileClip = null; // fclip.js: announces and fetches copied files
    this.peerAccepts = true; // the PC's last clip.policy
    this.hist = new ClipHistory({ dir: historyDir || path.join(app.getPath('userData'), 'clipboard-history'), max: Number(this.cfg.historySize) || 0 });
    this.hist.wipe(); // nothing from an earlier run stays on disk
    this.thumbs = new Map(); // history id -> thumbnail data URL
    this.lastSkip = '';
    this.echo = new EchoGuard({ now: () => Date.now() }); // content we wrote or sent a moment ago
    this.breaker = new Breaker({ now: () => Date.now() }); // copies faster than a person: pause
    this.pausedLogged = false;

    server.on('client', () => {
      this.peerAccepts = true;
      this.sendPolicy();
      const c = this.cfg;
      const latest = this.latest.latestMessage();
      if (latest && c.enabled && c.send) server.sendToClient(latest); // the other side asks if it is newer
    });
    server.on(`t:${P.T.CLIP}`, (msg) => this._onClip(msg));
    server.on(`t:${P.T.CLIP_IMAGE}`, (msg) => this._onImage(msg));
    server.on(`t:${P.T.CLIP_LATEST}`, (msg) => this._onLatest(msg));
    server.on(`t:${P.T.CLIP_POLICY}`, (msg) => {
      this.peerAccepts = msg.accept !== false;
      this.emit('change');
    });
    server.on(`t:${P.T.CLIP_REQUEST}`, () => this.sendIfChanged('request'));
    helper.on('event', (name, ev) => {
      if (name === 'clipboard') this._queue(() => this._detect(ev, true));
    });
    helper.on('ready', () => setTimeout(() => this.applySettings(), 100));
  }

  get cfg() {
    return this.getSettings().clipboard;
  }

  // Call after settings.clipboard changed (and once at start).
  applySettings() {
    const c = this.cfg;
    this.helper.send('clipboardWatch', { on: !!c.enabled }); // also with Send off: every copy gets its time
    this.hist.setMax(Number(c.historySize) || 0);
    this.sendPolicy();
    this.emit('change');
  }

  sendPolicy() {
    const c = this.cfg;
    this.server.sendToClient({ t: P.T.CLIP_POLICY, accept: !!(c.enabled && c.receive) });
  }

  // Record an item in the Recent list (both directions).
  _remember(entry) {
    try {
      this.hist.add({ at: Date.now(), ...entry });
    } catch (e) {
      console.error(`[clipboard] history: ${e.message}`);
    }
  }

  _queue(fn) {
    this.chain = this.chain.then(fn).catch((e) => console.error(`[clipboard] ${e.message}`));
    return this.chain;
  }

  _stampNow() {
    return { ts: this.latest.cur.ts, o: this.latest.cur.o };
  }

  // The pasteboard changed (helper event or poll): what is on it now, stamped as a copy made now.
  // Our own writes are recognised and keep the time of the item they carry.
  async _detect(ev, live) {
    if (typeof ev.changeCount === 'number') {
      if (ev.changeCount === this.seen) return;
      this.seen = ev.changeCount;
      if (ev.changeCount === this.ownCount) return;
    }
    const files = Array.isArray(ev.files) ? ev.files.filter((f) => typeof f === 'string' && f) : [];
    let item = null;
    if (files.length) {
      item = { kind: 'files', sig: filesKeyOf(files), paths: files };
    } else {
      // A picture we wrote may gain a text format afterwards (a file name): still our picture.
      let pic = null;
      if (ev.image) {
        const img = clipboard.readImage();
        if (!img.isEmpty()) {
          pic = img;
          if (this.echo.isEcho(imageKeyOf(img))) return;
        }
      }
      const text = ev.text ? await readText() : '';
      if (text) {
        item = { kind: 'text', sig: textKey(text), text };
      } else if (pic) {
        const png = pic.toPNG();
        const { width, height } = pic.getSize();
        item = { kind: 'image', sig: imageKeyOf(pic), w: width, h: height, bytes: png.length, png: png.length <= P.CLIP_IMAGE_MAX_BYTES ? png : null };
      }
    }
    if (!item || item.sig === this.applied || (this.item && this.item.sig === item.sig)) return;
    if (this.echo.isEcho(item.sig)) return; // the system touching what we wrote or sent: not a new copy
    this.applied = null;
    item.concealed = !!ev.concealed;
    item.sent = false;
    if (!ev.initial && !this.breaker.hit()) { // faster than a person: a loop? remember it, stamp nothing
      item.stamp = null;
      this.item = item;
      if (!this.pausedLogged) console.error('[clipboard] copies come in too fast: sync paused');
      this.pausedLogged = true;
      this.emit('change');
      return;
    }
    this.pausedLogged = false;
    // What was there when watching began is of unknown age: never stamped, never sent.
    item.stamp = ev.initial ? null : this.latest.copied(item.kind, item.kind === 'image' ? item.sig : undefined);
    this.item = item;
    if (item.stamp) this.echo.note(item.sig);
    if (item.stamp && item.kind !== 'files' && this.fileClip) this.fileClip.retractAuto(); // a newer copy: the files offered before are gone
    if (item.stamp && live && this.cfg.mode === 'instant') await this._send('instant');
  }

  // Look at the pasteboard now (the watcher may be a tick behind, or the helper not running).
  async _poll() {
    try {
      await this._detect(await this.helper.request('clipboardInfo'), false);
    } catch { /* no helper */ }
  }

  // The incoming handlers first look at the local clipboard, so a copy made just now is stamped
  // before the incoming item is compared with it.
  _onClip(msg) {
    return this._queue(() => this._applyText(msg));
  }

  async _applyText(msg) {
    const c = this.cfg;
    if (!c.enabled || !c.receive || !P.clipAllowed(msg.text)) return;
    await this._poll();
    if (!this.latest.accept(msg, 'text')) return; // older than a copy we already know
    const sig = textKey(msg.text);
    this.item = { kind: 'text', sig, text: msg.text, stamp: this._stampNow(), sent: true };
    this.echo.note(sig);
    if (textKey(await readText()) !== sig) { // the same content is already there: nothing to write
      this.applied = sig;
      clipboard.writeText(msg.text);
      await this._wrote();
    }
    this._remember({ kind: 'text', dir: 'in', text: msg.text });
    this.emit('change');
  }

  _onImage(msg) {
    return this._queue(() => this._applyImage(msg));
  }

  async _applyImage(msg) {
    const c = this.cfg;
    if (!c.enabled || !c.receive || !c.images) return;
    const img = readImage(msg);
    if (!img) return;
    const pic = nativeImage.createFromBuffer(img.png);
    if (pic.isEmpty()) return;
    await this._poll();
    if (!this.latest.accept(msg, 'image', img.id)) return;
    const sig = imageKeyOf(pic);
    const here = clipboard.readImage();
    this.echo.note(sig);
    if (here.isEmpty() || imageKeyOf(here) !== sig) { // the same picture is already there: nothing to write
      clipboard.writeImage(pic);
      this.applied = sig;
      this.echo.note(imageKeyOf(clipboard.readImage())); // the pasteboard may hold it a little differently
      await this._wrote();
    }
    this.item = { kind: 'image', sig, w: img.w, h: img.h, png: null, stamp: this._stampNow(), sent: true };
    this._remember({ kind: 'image', dir: 'in', png: img.png, w: img.w, h: img.h });
    this.emit('change');
  }

  // Files received for the clipboard are in the cache folder now: put them on it as a file list
  // (Finder pastes them). id: the fclip offer they belong to; a newer copy since then wins.
  applyFiles(paths, id) {
    return this._queue(() => this._applyFiles(paths, id));
  }

  async _applyFiles(paths, id) {
    const c = this.cfg;
    await this._poll();
    const cur = this.latest.cur;
    if (!c.enabled || !c.receive || !c.files || !cur || cur.id !== id || !paths.length) return;
    const sig = filesKeyOf(paths);
    const same = this.item && this.item.kind === 'files' && this.item.sig === sig; // already on the clipboard
    this.item = { kind: 'files', sig, paths, stamp: this._stampNow(), sent: true };
    this.echo.note(sig);
    if (!same) {
      this.applied = sig;
      try {
        this.ownCount = (await this.helper.request('clipboardFiles', { paths })).changeCount;
      } catch (e) {
        console.error(`[clipboard] files: ${e.message}`);
      }
    }
    this._remember({ kind: 'files', dir: 'in', files: paths.map((p) => ({ path: p })) });
    this.emit('change');
  }

  // After our own write: the pasteboard's count, so the change is not taken for a new copy.
  async _wrote() {
    try {
      this.ownCount = (await this.helper.request('clipboardInfo')).changeCount;
    } catch { /* the signature still tells */ }
  }

  // The other side's newest copy (sent after welcome): ask for it when it is newer than ours.
  _onLatest(msg) {
    const c = this.cfg;
    if (!c.enabled || !c.receive || (msg.kind === 'image' && !c.images) || (msg.kind === 'files' && !c.files)) return;
    return this._queue(async () => {
      await this._poll();
      if (this.latest.isNewer(msg)) this.server.sendToClient({ t: P.T.CLIP_REQUEST });
    });
  }

  // Send what the clipboard holds if allowed and not sent yet (why 'request': the other side asked,
  // so again). The message carries the time of the copy, never the time of sending.
  sendIfChanged(why) {
    return this._queue(async () => {
      if (why !== 'instant') await this._poll();
      await this._send(why);
    });
  }

  async _send(why) {
    const c = this.cfg;
    const it = this.item;
    if (!c.enabled || !c.send || !this.server.current || !it || !it.stamp) return;
    if (it.stamp.o !== this.latest.selfId || it.noShare || (it.sent && why !== 'request')) return; // theirs, or sent
    if (!this.peerAccepts) return this._skip(`${this.server.current ? this.server.current.name : 'the other computer'} doesn’t take the clipboard`);
    it.sent = true; // whatever happens below, don't retry this item
    if (c.skipConcealed && it.concealed) return this._skip('skipped a password (concealed item)');
    if (it.kind === 'text') {
      if (Buffer.byteLength(it.text, 'utf8') > c.maxKB * 1024 || !P.clipAllowed(it.text)) {
        return this._skip(`skipped ${Math.round(Buffer.byteLength(it.text, 'utf8') / 1024)} KB (over ${c.maxKB} KB)`);
      }
      this.server.sendToClient(textMessage(it.text, it.stamp));
      if (!it.fromHistory) this._remember({ kind: 'text', dir: 'out', text: it.text });
    } else if (it.kind === 'image') {
      if (!c.images) return;
      const msg = it.png && imageMessage({ id: it.sig, w: it.w, h: it.h, png: it.png }, it.stamp);
      if (!msg) return this._skip(`skipped an image of ${Math.round(it.bytes / 1048576)} MB (over ${Math.round(P.CLIP_IMAGE_MAX_BYTES / 1048576)} MB)`);
      this.server.sendToClient(msg);
      if (!it.fromHistory) this._remember({ kind: 'image', dir: 'out', png: it.png, w: it.w, h: it.h });
    } else if (it.kind === 'files') {
      if (!c.files || !this.fileClip) return;
      await this.fileClip.announceClipboard(it.paths, it.stamp, c.filesMaxMB);
      if (!it.fromHistory) this._remember({ kind: 'files', dir: 'out', files: it.paths.map((p) => ({ path: p })) });
    }
    this.lastSkip = '';
    this.emit('change');
  }

  _skip(why) {
    if (this.lastSkip !== why) {
      this.lastSkip = why;
      this.emit('change');
    }
  }

  // Put a Recent item back on the clipboard as a new copy: stamped now, so it goes out to the other
  // computer by the normal rules and wins over older copies. Nothing happens when it was not kept.
  copyHistory(id) {
    return this._queue(() => this._copyHistory(id));
  }

  async _copyHistory(id) {
    const c = this.hist.content(String(id));
    if (!c) return;
    await this._poll(); // a copy made just now is stamped before this one
    if (!this.breaker.hit()) return; // a person never gets here that fast
    let item;
    if (c.kind === 'text') {
      item = { kind: 'text', sig: textKey(c.text), text: c.text };
      this.echo.note(item.sig);
      this.applied = item.sig;
      clipboard.writeText(c.text);
      await this._wrote();
    } else if (c.kind === 'image') {
      const pic = nativeImage.createFromBuffer(c.png);
      if (pic.isEmpty()) return;
      const sig = imageKeyOf(pic);
      this.echo.note(sig);
      this.applied = sig;
      clipboard.writeImage(pic);
      this.echo.note(imageKeyOf(clipboard.readImage())); // the pasteboard may hold it a little differently
      item = { kind: 'image', sig, w: c.w, h: c.h, bytes: c.png.length, png: c.png.length <= P.CLIP_IMAGE_MAX_BYTES ? c.png : null };
      await this._wrote();
    } else {
      this.echo.note(filesKeyOf(c.paths));
      try {
        this.ownCount = (await this.helper.request('clipboardFiles', { paths: c.paths })).changeCount;
      } catch (e) {
        return console.error(`[clipboard] files: ${e.message}`);
      }
      item = { kind: 'files', sig: filesKeyOf(c.paths), paths: c.paths };
    }
    this.applied = item.sig; // the watcher reports our own write: not a second copy
    this.echo.note(item.sig);
    item.concealed = false;
    item.sent = false;
    item.fromHistory = true; // already in the list
    item.stamp = this.latest.copied(item.kind, item.kind === 'image' ? item.sig : undefined);
    this.item = item;
    if (item.kind !== 'files' && this.fileClip) this.fileClip.retractAuto();
    if (this.cfg.mode === 'instant') await this._send('instant');
    this.emit('change');
  }

  // Everything of one Recent item for the Preview window (plain JSON), or null.
  previewHistory(id) {
    return this.hist.preview(String(id));
  }

  clearHistory() {
    this.hist.clear();
    this.thumbs.clear();
    this.emit('change');
  }

  // The app is quitting: kept images and files go.
  shutdown() {
    this.hist.wipe();
  }

  _thumb(id) {
    if (this.thumbs.has(id)) return this.thumbs.get(id);
    let url = '';
    try {
      const c = this.hist.content(id);
      if (c && c.png) url = nativeImage.createFromBuffer(c.png).resize({ width: THUMB }).toDataURL();
    } catch { /* no thumbnail */ }
    this.thumbs.set(id, url);
    return url;
  }

  get view() {
    const history = this.hist.list();
    const live = new Set(history.map((h) => h.id));
    for (const id of this.thumbs.keys()) if (!live.has(id)) this.thumbs.delete(id);
    return {
      peerAccepts: this.peerAccepts,
      lastSkip: this.lastSkip,
      paused: this.breaker.paused,
      pausedUntil: this.breaker.paused ? this.breaker.until : 0,
      history: history.map((h) => (h.kind === 'image' && h.kept ? { ...h, thumb: this._thumb(h.id) } : h)),
    };
  }
}

module.exports = { Clipboard };
