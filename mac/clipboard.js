// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Clipboard sharing (text, images, files): directions, switch/instant mode, concealed filter, size
// limits, clip.policy both ways, and the in-memory Recent list. "The latest copy wins": every local
// copy is noticed as it happens (the helper watches NSPasteboard.changeCount) and stamped with
// shared/clipsync.js, so a late or repeated push of an older copy never replaces a newer one.
// Files copied in Finder go through fclip.js (announced with fclip.offer, fetched by the other side).
//
// Events: 'change' — this.view changed.
'use strict';

const crypto = require('crypto');
const { clipboard, nativeImage } = require('electron');
const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');
const { Latest, textMessage, imageMessage, readImage } = require('../shared/clipsync.js');

// Electron 44's clipboard.readText() returns a Promise in the main process (older: a string).
const readText = async () => String((await clipboard.readText()) || '');
const PREVIEW = 300; // characters kept per history item for the UI
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

class Clipboard extends EventEmitter {
  constructor(server, helper, getSettings) {
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
    this.history = []; // newest first: {dir, at, text, size}
    this.lastSkip = '';

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
    if (c.historySize < this.history.length) this.history.length = c.historySize;
    this.sendPolicy();
    this.emit('change');
  }

  sendPolicy() {
    const c = this.cfg;
    this.server.sendToClient({ t: P.T.CLIP_POLICY, accept: !!(c.enabled && c.receive) });
  }

  _remember(dir, text) {
    const n = this.cfg.historySize;
    if (!n) return;
    this.history = this.history.filter((h) => h.text !== text || h.dir !== dir);
    this.history.unshift({ dir, at: Date.now(), text, size: Buffer.byteLength(text, 'utf8') });
    if (this.history.length > n) this.history.length = n;
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
      item = { kind: 'files', sig: `f:${files.join('\n')}`, paths: files };
    } else {
      const text = ev.text ? await readText() : '';
      if (text) {
        item = { kind: 'text', sig: `t:${text}`, text };
      } else if (ev.image) {
        const img = clipboard.readImage();
        if (!img.isEmpty()) {
          const png = img.toPNG();
          const { width, height } = img.getSize();
          item = { kind: 'image', sig: `i:${sha1(png)}`, w: width, h: height, bytes: png.length, png: png.length <= P.CLIP_IMAGE_MAX_BYTES ? png : null };
        }
      }
    }
    if (!item || item.sig === this.applied || (this.item && this.item.sig === item.sig)) return;
    this.applied = null;
    item.concealed = !!ev.concealed;
    item.sent = false;
    // What was there when watching began is of unknown age: never stamped, never sent.
    item.stamp = ev.initial ? null : this.latest.copied(item.kind, item.kind === 'image' ? item.sig.slice(2) : undefined);
    this.item = item;
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
    const sig = `t:${msg.text}`;
    this.item = { kind: 'text', sig, text: msg.text, stamp: this._stampNow(), sent: true };
    this.applied = sig;
    if ((await readText()) !== msg.text) {
      clipboard.writeText(msg.text);
      await this._wrote();
    }
    this._remember('in', msg.text);
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
    clipboard.writeImage(pic);
    // The pasteboard re-encodes it: the signature of what it holds now is what we will see next.
    const sig = `i:${sha1(clipboard.readImage().toPNG())}`;
    this.item = { kind: 'image', sig, w: img.w, h: img.h, png: null, stamp: this._stampNow(), sent: true };
    this.applied = sig;
    await this._wrote();
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
    const sig = `f:${paths.join('\n')}`;
    this.item = { kind: 'files', sig, paths, stamp: this._stampNow(), sent: true };
    this.applied = sig;
    try {
      this.ownCount = (await this.helper.request('clipboardFiles', { paths })).changeCount;
    } catch (e) {
      console.error(`[clipboard] files: ${e.message}`);
    }
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
      this._remember('out', it.text);
    } else if (it.kind === 'image') {
      if (!c.images) return;
      const msg = it.png && imageMessage({ id: it.sig.slice(2), w: it.w, h: it.h, png: it.png }, it.stamp);
      if (!msg) return this._skip(`skipped an image of ${Math.round(it.bytes / 1048576)} MB (over ${Math.round(P.CLIP_IMAGE_MAX_BYTES / 1048576)} MB)`);
      this.server.sendToClient(msg);
    } else if (it.kind === 'files') {
      if (!c.files || !this.fileClip) return;
      await this.fileClip.announceClipboard(it.paths, it.stamp, c.filesMaxMB);
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

  // Put a Recent item back on the clipboard (it then goes out by the normal rules).
  copyHistory(index) {
    const h = this.history[index];
    if (!h) return;
    clipboard.writeText(h.text); // the watcher takes it for a new copy
  }

  clearHistory() {
    this.history = [];
    this.emit('change');
  }

  get view() {
    return {
      peerAccepts: this.peerAccepts,
      lastSkip: this.lastSkip,
      history: this.history.map((h) => ({ dir: h.dir, at: h.at, size: h.size, text: h.text.slice(0, PREVIEW) })),
    };
  }
}

module.exports = { Clipboard };
