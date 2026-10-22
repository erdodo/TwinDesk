// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Clipboard sharing (text, images, files) across every connected device (docs/mesh.md, one pool): a
// copy goes to the devices that accept clipboard from us, an item from any device is applied once
// and relayed by the Pool. Directions, switch/instant mode, concealed filter, size limits,
// clip.policy per device and the in-memory Recent list. "The latest copy wins": every local copy is
// noticed as it happens (the helper watches NSPasteboard.changeCount) and stamped with
// shared/clipsync.js, so a late or repeated push of an older copy never replaces a newer one (the
// Pool's (origin, sequence) dedupe is the first filter, the time decides what wins).
// Files copied in Finder go through fclip.js (announced with fclip.offer to every device that takes
// files, fetched by the receiver).
//
// Events: 'change' — this.view changed.
'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');
const { Pool } = require('../shared/mesh.js');
const { Latest, textMessage, imageMessage, readImage } = require('../shared/clipsync.js');

const PREVIEW = 300; // characters kept per history item for the UI
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

// The Pool's view of the mesh for the clipboard. Items from a device are always applied (its
// clip.policy says what it wants from us, not what it sends); items go only to devices whose
// clip.policy accepted (mesh entry .pool), and images only to those that take them (.images,
// default true), which is checked in send().
function clipPeers(mesh) {
  return mesh.peers().map((e) => ({
    id: e.id,
    mesh: e.mesh,
    pool: true,
    send: (msg) => e.pool !== false && !(msg.t === P.T.CLIP_IMAGE && e.images === false) && e.send(msg),
  }));
}

class Clipboard extends EventEmitter {
  // opts:
  //   bus      { on(type, fn(msg, fromId)), onPeer(event, fn(peerId, info)), send(peerId, msg) -> bool,
  //              selectedId() -> string|null, connectedIds() -> string[] }   (hub.js)
  //   mesh     shared/mesh.js Mesh (entries: {id, name, send, mesh, pool, images, files})
  //   getSettings()  -> settings (settings.clipboard is used)
  //   helper   the helper process {running, send(name, args), request(name, args) -> Promise,
  //            on('event' | 'ready')}: 'clipboard' events (every copy) and 'clipboardInfo'
  //   clipboard, nativeImage   optional; default Electron's
  constructor(opts) {
    super();
    this.bus = opts.bus;
    this.mesh = opts.mesh;
    this.helper = opts.helper || null;
    this.getSettings = opts.getSettings;
    const electron = opts.clipboard ? {} : require('electron');
    this.clipboard = opts.clipboard || electron.clipboard;
    this.nativeImage = opts.nativeImage || electron.nativeImage;
    this.pool = new Pool({ name: 'clip', selfId: this.mesh.selfId, peers: () => clipPeers(this.mesh) });
    this.latest = new Latest({ selfId: this.mesh.selfId });
    this.item = null; // what the clipboard holds: { kind, sig, stamp, concealed, sent, text|png,w,h|paths }
    this.applied = null; // signature of what we wrote ourselves (the helper then reports it as a change)
    this.ownCount = -1; // changeCount after our last write
    this.seen = -1; // last changeCount looked at
    this.chain = Promise.resolve(); // detections and sends one after the other
    this.fileClip = null; // fclip.js: announces and fetches copied files
    this.offers = new Map(); // fclip.offer id -> true/false: Latest's answer, so two handlers ask it once
    this.history = []; // newest first: {dir, at, text, size}
    this.lastSkip = '';

    const bus = this.bus;
    bus.on(P.T.CLIP, (m, from) => this._onClip(m, from));
    bus.on(P.T.CLIP_IMAGE, (m, from) => this._onImage(m, from));
    bus.on(P.T.CLIP_LATEST, (m, from) => this._onLatest(m, from));
    bus.on(P.T.CLIP_POLICY, (m, from) => {
      const e = this.mesh.get(from);
      if (e) {
        e.pool = m.accept !== false;
        e.images = m.images !== false;
        e.files = m.files !== false;
      }
      this.emit('change');
    });
    bus.on(P.T.CLIP_REQUEST, () => this.sendIfChanged('request'));
    bus.on(P.T.FCLIP_OFFER, (m, from) => {
      // The selected device's offers are taken by fclip.js (acceptOffer there). From any other
      // device we only note the copy, so an older text cannot replace it later.
      if (from === this.bus.selectedId() || !m || typeof m.id !== 'string') return;
      const c = this.cfg;
      if (c.enabled && c.receive && c.files) this._queue(() => this.acceptOffer(m, from));
    });
    bus.onPeer('welcome', (id) => {
      const e = this.mesh.get(id);
      if (e) { e.pool = true; e.images = true; e.files = true; } // until its clip.policy says otherwise
      this._sendPolicy(id);
      const c = this.cfg;
      const latest = this.latest.latestMessage();
      if (latest && c.enabled && c.send) this.bus.send(id, latest); // to the new device only: it asks if it is newer
      this._applyWatch();
      this.emit('change');
    });
    bus.onPeer('closed', () => {
      this._applyWatch();
      this.emit('change');
    });
    if (this.helper) {
      this.helper.on('event', (name, ev) => {
        if (name === 'clipboard') this._queue(() => this._detect(ev, true));
      });
      this.helper.on('ready', () => setTimeout(() => this.applySettings(), 100));
    }
  }

  // True when some connected device accepts clipboard from us (true with nobody connected, as before).
  get peerAccepts() {
    const ids = this.bus.connectedIds();
    if (!ids.length) return true;
    return ids.some((id) => {
      const e = this.mesh.get(id);
      return !!e && e.pool !== false;
    });
  }

  _connected() {
    return this.bus.connectedIds().length > 0;
  }

  get cfg() {
    return this.getSettings().clipboard;
  }

  // Call after settings.clipboard changed (and once at start).
  applySettings() {
    const c = this.cfg;
    this._applyWatch();
    if (c.historySize < this.history.length) this.history.length = c.historySize;
    this.sendPolicy();
    this.emit('change');
  }

  // The helper reports every copy while the clipboard is shared at all (also with Send off: every
  // copy gets its time).
  _applyWatch() {
    if (!this.helper || this.helper.running === false) return;
    this.helper.send('clipboardWatch', { on: !!this.cfg.enabled });
  }

  destroy() {
    if (this.helper && this.helper.running !== false) this.helper.send('clipboardWatch', { on: false });
  }

  // Our clip.policy to every connected device.
  sendPolicy() {
    for (const id of this.bus.connectedIds()) this._sendPolicy(id);
  }

  _sendPolicy(id) {
    const c = this.cfg;
    const on = !!(c.enabled && c.receive);
    this.bus.send(id, { t: P.T.CLIP_POLICY, accept: on, images: on && c.images !== false, files: on && c.files !== false });
  }

  async _readText() {
    // Electron 44's clipboard.readText() returns a Promise in the main process (older: a string).
    return String((await this.clipboard.readText()) || '');
  }

  // Name of the device where an item started: the mesh entry, else the sender's own name.
  _nameOf(origin, on, from) {
    const o = this.mesh.get(origin);
    if (o && o.name) return o.name;
    if (typeof on === 'string' && on) return on.slice(0, 100);
    const f = this.mesh.get(from);
    return (f && f.name) || from;
  }

  _remember(dir, text, from) {
    const n = this.cfg.historySize;
    if (!n) return;
    this.history = this.history.filter((h) => h.text !== text || h.dir !== dir);
    this.history.unshift({ dir, at: Date.now(), text, size: Buffer.byteLength(text, 'utf8'), from: from || '' });
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
      const text = ev.text ? await this._readText() : '';
      if (text) {
        item = { kind: 'text', sig: `t:${text}`, text };
      } else if (ev.image) {
        const img = this.clipboard.readImage();
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
  _onClip(msg, from) {
    return this._queue(() => this._applyText(msg, from));
  }

  // The stamp of a pooled item for Latest: the time of the copy and the device that made it.
  _stampOf(m) {
    return { ts: m.ts, o: m.o, from: m.o };
  }

  async _applyText(msg, from) {
    const c = this.cfg;
    if (!c.enabled || !c.receive || !msg || !P.clipAllowed(msg.text)) return;
    const r = this.pool.receive(from, msg);
    if (!r.fresh) return;
    await this._poll();
    if (!this.latest.accept(this._stampOf(r.msg), 'text')) return; // older than a copy we already know
    const sig = `t:${msg.text}`;
    this.item = { kind: 'text', sig, text: msg.text, stamp: this._stampNow(), sent: true };
    this.applied = sig;
    if ((await this._readText()) !== msg.text) {
      this.clipboard.writeText(msg.text);
      await this._wrote();
    }
    this._remember('in', msg.text, this._nameOf(r.msg.o, msg.on, from));
    this.emit('change');
  }

  _onImage(msg, from) {
    return this._queue(() => this._applyImage(msg, from));
  }

  async _applyImage(msg, from) {
    const c = this.cfg;
    if (!c.enabled || !c.receive || !c.images) return;
    const img = readImage(msg);
    if (!img) return;
    const pic = this.nativeImage.createFromBuffer(img.png);
    if (pic.isEmpty()) return;
    const r = this.pool.receive(from, msg); // relayed as it came: one image per hop, not re-encoded
    if (!r.fresh) return;
    await this._poll();
    if (!this.latest.accept(this._stampOf(r.msg), 'image', img.id)) return;
    this.clipboard.writeImage(pic);
    // The pasteboard re-encodes it: the signature of what it holds now is what we will see next.
    const sig = `i:${sha1(this.clipboard.readImage().toPNG())}`;
    this.item = { kind: 'image', sig, w: img.w, h: img.h, png: null, stamp: this._stampNow(), sent: true };
    this.applied = sig;
    await this._wrote();
    this.emit('change');
  }

  // fclip.offer from `from`: true when it is the newest copy known (fclip.js asks for the selected
  // device, this file for the others). Memoised per offer: both may ask.
  acceptOffer(m, from) {
    if (this.offers.has(m.id)) return this.offers.get(m.id);
    const ok = this.latest.accept({ ts: m.ts, o: m.o, from: m.o || from }, 'files', m.id);
    this.offers.set(m.id, ok);
    if (this.offers.size > 50) this.offers.delete(this.offers.keys().next().value);
    return ok;
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

  // The newest copy of the device that just connected (sent after welcome): ask it for it when it
  // is newer than ours.
  _onLatest(msg, from) {
    const c = this.cfg;
    if (!c.enabled || !c.receive || (msg.kind === 'image' && !c.images) || (msg.kind === 'files' && !c.files)) return;
    return this._queue(async () => {
      await this._poll();
      if (this.latest.isNewer(msg)) this.bus.send(from, { t: P.T.CLIP_REQUEST });
    });
  }

  // Send what the clipboard holds if allowed and not sent yet (why 'request': another device asked,
  // so again). The message carries the time of the copy, never the time of sending. Text and images
  // go to the pool; an answer to clip.request is published to every device that accepts it (a
  // targeted, unstamped answer would collide with this device's pool sequence numbers).
  sendIfChanged(why) {
    return this._queue(async () => {
      if (why !== 'instant') await this._poll();
      await this._send(why);
    });
  }

  async _send(why) {
    const c = this.cfg;
    const it = this.item;
    if (!c.enabled || !c.send || !this._connected() || !it || !it.stamp) return;
    if (it.stamp.o !== this.latest.selfId || it.noShare || (it.sent && why !== 'request')) return; // theirs, or sent
    if (!this.peerAccepts) return this._skip('A connected device doesn’t take the clipboard');
    if (c.skipConcealed && it.concealed) {
      it.sent = true; // don't retry this item
      return this._skip('skipped a password (concealed item)');
    }
    if (it.kind === 'text') {
      if (Buffer.byteLength(it.text, 'utf8') > c.maxKB * 1024 || !P.clipAllowed(it.text)) {
        it.sent = true;
        return this._skip(`skipped ${Math.round(Buffer.byteLength(it.text, 'utf8') / 1024)} KB (over ${c.maxKB} KB)`);
      }
      if (!this.pool.publish(textMessage(it.text, it.stamp)).sent.length) return;
      this._remember('out', it.text);
    } else if (it.kind === 'image') {
      if (!c.images) return;
      const msg = it.png && imageMessage({ id: it.sig.slice(2), w: it.w, h: it.h, png: it.png }, it.stamp);
      if (!msg) {
        it.sent = true;
        return this._skip(`skipped an image of ${Math.round(it.bytes / 1048576)} MB (over ${Math.round(P.CLIP_IMAGE_MAX_BYTES / 1048576)} MB)`);
      }
      if (!this.pool.publish(msg).sent.length) return;
    } else if (it.kind === 'files') {
      if (!c.files || !this.fileClip) return;
      // Straight to every device that takes files; each fetches them from us over its own link.
      const to = this.bus.connectedIds().filter((id) => {
        const e = this.mesh.get(id);
        return !!e && e.pool !== false && e.files !== false;
      });
      if (!to.length) return;
      await this.fileClip.announceClipboard(it.paths, it.stamp, c.filesMaxMB, to);
    }
    it.sent = true;
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
    this.clipboard.writeText(h.text); // the watcher takes it for a new copy
  }

  clearHistory() {
    this.history = [];
    this.emit('change');
  }

  get view() {
    return {
      peerAccepts: this.peerAccepts,
      lastSkip: this.lastSkip,
      history: this.history.map((h) => ({
        dir: h.dir, at: h.at, size: h.size, text: h.text.slice(0, PREVIEW), from: h.from || '',
      })),
    };
  }
}

module.exports = { Clip: Clipboard, Clipboard };
