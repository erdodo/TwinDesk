// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Clipboard sharing (text, images, files) across every connected device (docs/mesh.md, one pool): a
// copy goes to the devices that accept clipboard from us, an item from any device is applied once
// and relayed by the Pool. Directions, switch/instant mode, concealed filter, size limits,
// clip.policy per device and the Recent list (shared/clip-history.js: text in memory, images and files
// kept in the app's cache folder so they can be copied again and previewed). "The latest copy wins": every local copy is
// noticed as it happens (the helper watches NSPasteboard.changeCount) and stamped with
// shared/clipsync.js, so a late or repeated push of an older copy never replaces a newer one (the
// Pool's (origin, sequence) dedupe is the first filter, the time decides what wins).
// Files copied in Finder go through fclip.js (announced with fclip.offer to every device that takes
// files, fetched by the receiver).
//
// Events: 'change' — this.view changed.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');
const { Pool } = require('../shared/mesh.js');
const { Latest, textMessage, imageMessage, readImage } = require('../shared/clipsync.js');
const { ClipHistory } = require('../shared/clip-history.js');
const { textKey, imageKey, filesKey, EchoGuard, Breaker } = require('../shared/clipguard.js');

const THUMB = 64; // width of an image's thumbnail in the Recent list

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

// What a clipboard item IS, never how the system stores it (format lists, PNG bytes, line breaks).
// An image: its size and a sample of its raw pixels, whatever encoder made the PNG.
function imageKeyOf(img) {
  if (!img || img.isEmpty()) return ''; // nothing there: no picture
  const { width, height } = img.getSize();
  let bmp;
  try { bmp = img.toBitmap(); } catch { bmp = img.toPNG(); }
  const step = Math.max(1, Math.floor(bmp.length / 16384));
  const sample = Buffer.alloc(Math.ceil(bmp.length / step) + 8);
  let n = sample.writeUInt32BE(bmp.length >>> 0, 0);
  for (let i = 0; i < bmp.length; i += step) sample[n++] = bmp[i];
  return imageKey(width, height, sha1(sample.subarray(0, n)));
}
// Files: names and sizes (the paths differ between devices).
function filesKeyOf(paths) {
  return filesKey(paths.map((p) => {
    let size = 0;
    try { size = fs.statSync(p).size; } catch { /* gone: size 0 */ }
    return { name: path.basename(p), size };
  }));
}

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

// The Recent list's folder: inside the app's cache; a temp folder where there is no Electron app (tests).
function defaultHistoryDir() {
  try {
    return path.join(require('electron').app.getPath('userData'), 'clipboard-history');
  } catch {
    return path.join(os.tmpdir(), `twindesk-clipboard-history-${process.pid}`);
  }
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
  //   historyDir   where the Recent list keeps images and files (default: the app's cache folder)
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
    this.echo = new EchoGuard({ now: () => Date.now() }); // content we wrote or sent a moment ago
    this.breaker = new Breaker({ now: () => Date.now() }); // copies faster than a person: pause
    this.pausedLogged = false;
    this.seen = -1; // last changeCount looked at
    this.chain = Promise.resolve(); // detections and sends one after the other
    this.fileClip = null; // fclip.js: announces and fetches copied files
    this.offers = new Map(); // fclip.offer id -> true/false: Latest's answer, so two handlers ask it once
    this.hist = new ClipHistory({ dir: opts.historyDir || defaultHistoryDir(), max: Number(this.cfg.historySize) || 0 });
    this.hist.wipe(); // nothing from an earlier run stays on disk
    this.thumbs = new Map(); // history id -> thumbnail data URL
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
    this.hist.setMax(Number(c.historySize) || 0);
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

  // Record an item in the Recent list (both directions); from: the name of the device it came from.
  _remember(entry, from) {
    try {
      const id = this.hist.add({ at: Date.now(), ...entry });
      const it = id && this.hist.get(id);
      if (it && from) it.from = from;
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
        const img = this.clipboard.readImage();
        if (!img.isEmpty()) {
          pic = img;
          if (this.echo.isEcho(imageKeyOf(img))) return;
        }
      }
      const text = ev.text ? await this._readText() : '';
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
    const sig = textKey(msg.text);
    this.item = { kind: 'text', sig, text: msg.text, stamp: this._stampNow(), sent: true };
    this.echo.note(sig);
    if (textKey(await this._readText()) !== sig) { // the same content is already there: nothing to write
      this.applied = sig;
      this.clipboard.writeText(msg.text);
      await this._wrote();
    }
    this._remember({ kind: 'text', dir: 'in', text: msg.text }, this._nameOf(r.msg.o, msg.on, from));
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
    const sig = imageKeyOf(pic);
    this.item = { kind: 'image', sig, w: img.w, h: img.h, png: null, stamp: this._stampNow(), sent: true };
    this.echo.note(sig);
    if (imageKeyOf(this.clipboard.readImage()) !== sig) { // the same picture is already there: nothing to write
      this.applied = sig;
      this.clipboard.writeImage(pic);
      this.echo.note(imageKeyOf(this.clipboard.readImage())); // the pasteboard may hold it a little differently
      await this._wrote();
    }
    this._remember({ kind: 'image', dir: 'in', png: img.png, w: img.w, h: img.h }, this._nameOf(r.msg.o, null, from));
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
    const cur2 = this.latest.cur;
    this._remember({ kind: 'files', dir: 'in', files: paths.map((p) => ({ path: p })) }, cur2 ? this._nameOf(cur2.o, null, cur2.o) : '');
    this.emit('change');
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
      if (!it.fromHistory) this._remember({ kind: 'text', dir: 'out', text: it.text });
    } else if (it.kind === 'image') {
      if (!c.images) return;
      const msg = it.png && imageMessage({ id: it.sig, w: it.w, h: it.h, png: it.png }, it.stamp);
      if (!msg) {
        it.sent = true;
        return this._skip(`skipped an image of ${Math.round(it.bytes / 1048576)} MB (over ${Math.round(P.CLIP_IMAGE_MAX_BYTES / 1048576)} MB)`);
      }
      if (!this.pool.publish(msg).sent.length) return;
      if (!it.fromHistory) this._remember({ kind: 'image', dir: 'out', png: it.png, w: it.w, h: it.h });
    } else if (it.kind === 'files') {
      if (!c.files || !this.fileClip) return;
      // Straight to every device that takes files; each fetches them from us over its own link.
      const to = this.bus.connectedIds().filter((id) => {
        const e = this.mesh.get(id);
        return !!e && e.pool !== false && e.files !== false;
      });
      if (!to.length) return;
      await this.fileClip.announceClipboard(it.paths, it.stamp, c.filesMaxMB, to);
      if (!it.fromHistory) this._remember({ kind: 'files', dir: 'out', files: it.paths.map((p) => ({ path: p })) });
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

  // Put a Recent item back on the clipboard as a new copy: stamped now, so it goes out to the pool by
  // the normal rules and wins over older copies. Nothing happens when it was not kept.
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
      this.clipboard.writeText(c.text);
      await this._wrote();
    } else if (c.kind === 'image') {
      const pic = this.nativeImage.createFromBuffer(c.png);
      if (pic.isEmpty()) return;
      const sig = imageKeyOf(pic);
      this.echo.note(sig);
      this.applied = sig;
      this.clipboard.writeImage(pic);
      this.echo.note(imageKeyOf(this.clipboard.readImage())); // the pasteboard may hold it a little differently
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
      if (c && c.png) url = this.nativeImage.createFromBuffer(c.png).resize({ width: THUMB }).toDataURL();
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
      history: history.map((h) => {
        const from = (this.hist.get(h.id) || {}).from || '';
        return h.kind === 'image' && h.kept ? { ...h, from, thumb: this._thumb(h.id) } : { ...h, from };
      }),
    };
  }
}

module.exports = { Clip: Clipboard, Clipboard };
