// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Clipboard sharing — text, images and files — across every connected device (docs/mesh.md, one
// pool): a copy goes to the devices that accept clipboard from us, an item from any device is applied
// once and relayed by the Pool. Directions, switch/instant mode, concealed filter, size limits,
// clip.policy per device and the Recent list (shared/clip-history.js: text in memory, images and
// files kept in the app's cache folder so they can be copied again and previewed).
// "The latest copy wins" (shared/clipsync.js): the clipboard is watched all the time, every copy
// made here is stamped when it happens, and an item from the other computer is applied only when
// it is newer than everything this PC knows of (the Pool's (origin, sequence) dedupe is the first
// filter, the time decides what wins). Files copied normally (Explorer) are announced with
// fclip.offer to every device that takes files; a small set is fetched by the receiver at once.
const electron = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const P = require('../shared/protocol.js');
const S = require('../shared/clipsync.js');
const { Pool } = require('../shared/mesh.js');
const { ClipHistory } = require('../shared/clip-history.js');
const G = require('../shared/clipguard.js');

const electronClipboard = electron.clipboard; // undefined under plain node (tests inject one)
const electronImage = electron.nativeImage;

const POLL_MS = 500; // how often the clipboard is checked for a new copy
const IMAGE_POLL_MS = 1500; // an image on the clipboard is looked at this often at most (reading it is the costly part)
const PRUNE_EVERY = 1200; // polls (10 minutes) between clean-ups of the received files
const THUMB_W = 64; // width of an image's thumbnail in the Recent list
const MB = 1024 * 1024;
const CACHE_KEEP = 3; // received file sets kept (the newest)
const CACHE_AGE_MS = 60 * 60 * 1000; // …and any younger than this
// Explorer puts these next to the file list when files are copied; they tell a file copy from
// the registered formats without asking the helper every time.
const FILE_FORMATS = ['FileNameW', 'Shell IDList Array', 'Preferred DropEffect'];

const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');

// Password managers mark secrets so clipboard tools leave them alone. clipboard.has() doesn't see
// these registered formats; readBuffer() does (empty buffer = format absent).
function isConcealed(clipboard) {
  try {
    if (clipboard.readBuffer('ExcludeClipboardContentFromMonitorProcessing').length) return true;
    if (clipboard.readBuffer('Clipboard Viewer Ignore').length) return true;
    const b = clipboard.readBuffer('CanIncludeInClipboardHistory');
    if (b && b.length >= 4 && b.readUInt32LE(0) === 0) return true;
  } catch (_) { /* unknown format: not concealed */ }
  return false;
}

// An image by its size and a sample of its pixels (never its PNG bytes: encoders differ).
function imageKeyOf(im) {
  const sz = im.getSize();
  const bm = im.toBitmap();
  const step = Math.max(1, Math.floor(bm.length / 65536));
  const sample = Buffer.alloc(Math.ceil(bm.length / step));
  for (let i = 0, j = 0; i < bm.length; i += step) sample[j++] = bm[i];
  return G.imageKey(sz.width, sz.height, md5(sample));
}

// Files by names and sizes (the same on every device); folders count by name.
function filesInfo(paths) {
  const list = [];
  for (const p of paths) {
    let size = 0;
    try { const st = fs.statSync(p); size = st.isFile() ? st.size : 0; } catch (_) { /* gone */ }
    list.push({ name: path.basename(p), size });
  }
  return { paths, key: paths.length ? G.filesKey(list) : '' };
}

// A cheap fingerprint of the file-copy formats ('' = none).
function fileKey(clipboard) {
  let k = '';
  for (const f of FILE_FORMATS) {
    try {
      const b = clipboard.readBuffer(f);
      if (b && b.length) k += f + ':' + b.length + ':' + md5(b) + ';';
    } catch (_) { /* unknown format */ }
  }
  return k;
}

// Received files live in <dir>/<offer id>: the newest few stay, the others go when older than an hour.
function pruneCache(dir, now = Date.now(), keep = CACHE_KEEP, maxAge = CACHE_AGE_MS) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return; }
  const sets = [];
  for (const n of names) {
    try { sets.push({ p: path.join(dir, n), t: fs.statSync(path.join(dir, n)).mtimeMs }); } catch (_) { /* gone */ }
  }
  sets.sort((a, b) => b.t - a.t);
  for (const s of sets.slice(keep)) {
    if (now - s.t > maxAge) try { fs.rmSync(s.p, { recursive: true, force: true }); } catch (_) { /* in use */ }
  }
}

// The Pool's view of the mesh for the clipboard. Items from a device are always applied (its
// clip.policy says what it wants from us, not what it sends); items go only to devices whose
// clip.policy accepted (mesh entry .pool), and images / files only to those that take them
// (.images / .files, default true), which is checked in send().
function clipPeers(mesh) {
  return mesh.peers().map((e) => ({
    id: e.id,
    mesh: e.mesh,
    pool: true,
    send: (msg) => e.pool !== false && !(msg.t === P.T.CLIP_IMAGE && e.images === false) && e.send(msg),
  }));
}

class Clip {
  // opts:
  //   bus      { on(type, fn(msg, fromId)), onPeer(event, fn(peerId, info)), send(peerId, msg) -> bool,
  //              selectedId() -> string|null, connectedIds() -> string[] }
  //   mesh     shared/mesh.js Mesh (entries: {id, name, send, mesh, pool, images, files})
  //   getSettings()  -> settings.clipboard
  //   onChange()     the view changed
  //   clipboard, nativeImage   optional; default Electron's
  constructor(opts) {
    this.bus = opts.bus;
    this.mesh = opts.mesh;
    this.getSettings = opts.getSettings;
    this.onChange = opts.onChange;
    this.clipboard = opts.clipboard || electronClipboard;
    this.nativeImage = opts.nativeImage || electronImage;
    this.pool = new Pool({ name: 'clip', selfId: this.mesh.selfId, peers: () => clipPeers(this.mesh) });
    this.latest = new S.Latest({ selfId: this.mesh.selfId });
    this.hist = new ClipHistory({ dir: '', max: 0 }); // the Recent list; dir is set by attachFiles
    this.thumbs = new Map(); // history id -> thumbnail data URL
    this.lastSkip = '';
    this.echo = new G.EchoGuard(); // what we wrote or sent a moment ago: its echo is not a new copy
    this.breaker = new G.Breaker(); // copies faster than a person can make them pause the sync
    this.trips = 0; // breaker trips already logged
    this.fileInfo = null; // the file list as last resolved: {raw, paths, key}
    this.poll = null;
    this.sig = null; // content key of the clipboard as last seen (null = not looked at yet)
    this.item = null; // what the clipboard holds: {kind, id, stamp, text|image|paths, sent, received, concealed}
    this.busy = null; // the poll in progress (a promise)
    this.applying = false; // writing an item from another device: not a copy made here
    this.queue = Promise.resolve(); // incoming items one after the other
    this.img = null; // last image look: {fk, at, key, image}
    this.pulling = null; // files being fetched: {id, from}
    this.offers = new Map(); // fclip.offer id -> true/false: Latest's answer, so two handlers ask it once
    this.ticks = 0;
    this.helper = null;
    this.fileClip = null;
    this.cacheDir = '';
    this.historyDir = '';

    const bus = this.bus;
    bus.on(P.T.CLIP, (m, from) => this._later(() => this._onClip(m, from)));
    bus.on(P.T.CLIP_IMAGE, (m, from) => this._later(() => this._onImage(m, from)));
    bus.on(P.T.CLIP_POLICY, (m, from) => {
      const e = this.mesh.get(from);
      if (e) {
        e.pool = m.accept !== false;
        e.images = m.images !== false;
        e.files = m.files !== false;
      }
      this.onChange();
    });
    bus.on(P.T.CLIP_LATEST, (m, from) => {
      const newer = this.latest.isNewer(m);
      const c = this.cfg;
      if (!newer || !c.enabled || !c.receive) return;
      if ((m.kind === 'image' && !c.images) || (m.kind === 'files' && !c.files)) return;
      this.bus.send(from, { t: P.T.CLIP_REQUEST }); // that device copied last: ask it (it answers with the copy's own time)
    });
    bus.on(P.T.CLIP_REQUEST, () => this.sendIfChanged('request'));
    bus.on(P.T.FCLIP_OFFER, (m, from) => {
      // The selected device's offers are taken by fclip.js (acceptOffer there). From any other
      // device we only note the copy, so an older text cannot replace it later.
      if (from === this.bus.selectedId() || !m || typeof m.id !== 'string') return;
      const c = this.cfg;
      if (c.enabled && c.receive && c.files) this.acceptOffer(m, from);
    });
    bus.on(P.T.FCLIP_GONE, (m) => {
      if (this.pulling && this.pulling.id === m.id) this.pulling = null;
    });
    bus.onPeer('welcome', (id) => {
      const e = this.mesh.get(id);
      if (e) { e.pool = true; e.images = true; e.files = true; } // until its clip.policy says otherwise
      if (this.item && !this.item.received) this.item.sent = false; // a new device: it may not have it
      this._sendPolicy(id);
      const latest = this.latest.latestMessage();
      if (latest) this.bus.send(id, latest); // to the new device only
      this.onChange();
    });
    bus.onPeer('closed', (id) => {
      if (this.pulling && this.pulling.from === id) this.pulling = null;
      this.onChange();
    });
  }

  get cfg() {
    return this.getSettings();
  }

  // True when some connected device accepts clipboard from us (true with nobody connected, as before).
  get peerAccepts() {
    const ids = this.bus.connectedIds();
    if (!ids.length) return true;
    return ids.some((id) => this._accepts(id));
  }

  _accepts(id) {
    const e = this.mesh.get(id);
    return !!e && e.pool !== false;
  }

  // The helper (file list, CF_HDROP), FileClip (announce/fetch files) and the folder for received
  // files; set once they exist.
  attachFiles({ helper, fileClip, cacheDir, historyDir }) {
    this.helper = helper;
    this.fileClip = fileClip;
    this.cacheDir = cacheDir;
    this.historyDir = historyDir || path.join(path.dirname(cacheDir), 'cliphistory');
    this.hist.dir = this.historyDir;
  }

  // Watch the clipboard from now on (always, so every copy is stamped even when nothing is sent).
  start() {
    if (this.poll) return;
    if (this.cacheDir) try { fs.rmSync(this.cacheDir, { recursive: true, force: true }); } catch (_) { /* leftovers */ }
    this._wipeHistory(); // kept images and files of an earlier run
    this.poll = setInterval(() => {
      if (++this.ticks % PRUNE_EVERY === 0 && this.cacheDir) pruneCache(this.cacheDir);
      this.tick().catch(() => {});
    }, POLL_MS);
    if (this.poll.unref) this.poll.unref();
    this.tick().catch(() => {}); // what is on the clipboard now counts as copied now
  }

  stop() {
    clearInterval(this.poll);
    this.poll = null;
  }

  destroy() {
    this.stop();
  }

  // The app is quitting: nothing kept stays on disk.
  shutdown() {
    this.stop();
    this._wipeHistory();
  }

  _wipeHistory() {
    this.thumbs.clear();
    try { this.hist.wipe(); } catch (_) { /* in use */ }
  }

  // Call after settings.clipboard changed.
  applySettings() {
    const c = this.cfg;
    this.hist.setMax(c.historySize);
    this.sendPolicy();
    this.onChange();
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

  _later(fn) {
    this.queue = this.queue.then(fn).catch(() => {});
    return this.queue;
  }

  async _readText() {
    // Newer Electron returns a Promise from clipboard.readText() in main; await works for both.
    return String((await this.clipboard.readText()) || '');
  }

  // ---- local copies ----

  // Look at the clipboard once; a change is stamped as a copy made now (and sent in instant mode).
  tick() {
    if (this.busy) return this.busy;
    if (this.applying) return Promise.resolve();
    this.busy = (async () => {
      const s = await this._signature();
      if (this.applying || s.sig === this.sig) return;
      const first = this.sig === null;
      this.sig = s.sig;
      if (first) return; // what was already there when the app started stays here, unstamped
      await this._changed(s);
    })().finally(() => { this.busy = null; });
    return this.busy;
  }

  pollOnce() {
    return this.tick();
  }

  // What the clipboard holds, decided by CONTENT only (the format list just tells the kind): the OS
  // adding formats, converting an image or rewriting line breaks or the file list is not a change.
  async _signature() {
    let formats = [];
    try { formats = this.clipboard.availableFormats(); } catch (_) { /* none */ }
    const text = await this._readText();
    const raw = fileKey(this.clipboard);
    const finfo = raw ? await this._files(raw) : null;
    const files = !!(finfo && finfo.key);
    const isImage = !text && !files && formats.some((f) => f.startsWith('image/'));
    if (!isImage) this.img = null; // the next image is looked at fresh (not the one from before a text copy)
    const image = isImage ? this._imageKey(formats.join()) : '';
    const key = files ? finfo.key : text ? G.textKey(text) : image;
    return { sig: key, key, text, files, image: !!image, finfo };
  }

  // The files on the clipboard (names and sizes), asked of the helper only when the file formats changed.
  async _files(raw) {
    if (this.fileInfo && this.fileInfo.raw === raw) return this.fileInfo;
    let paths = [];
    if (this.helper) try { paths = await this.helper.clipFiles(); } catch (_) { /* no helper */ }
    paths = paths.filter((p) => typeof p === 'string' && fs.existsSync(p));
    this.fileInfo = { raw, ...filesInfo(paths) };
    return this.fileInfo;
  }

  // The pixel key of the image on the clipboard; read at most every IMAGE_POLL_MS while nothing else changed.
  _imageKey(fk) {
    const now = Date.now();
    if (this.img && this.img.fk === fk && now - this.img.at < IMAGE_POLL_MS) return this.img.key;
    const r = this._readImage();
    this.img = { fk, at: now, ...r };
    return r.key;
  }

  _readImage() {
    try {
      const im = this.clipboard.readImage();
      if (im && !im.isEmpty()) return { key: imageKeyOf(im), image: im };
    } catch (_) { /* unreadable: no image */ }
    return { key: '', image: null };
  }

  async _changed(s) {
    if (!s.key || this.echo.isEcho(s.key)) return; // emptied, or the echo of our own write: not a copy
    let item = null;
    if (s.files) item = { kind: 'files', id: crypto.randomUUID(), paths: s.finfo.paths };
    if (!item && s.text) item = { kind: 'text', id: md5(s.text).slice(0, 16), text: s.text, concealed: isConcealed(this.clipboard) };
    if (!item && s.image && this.img && this.img.image) item = { kind: 'image', id: this.img.key, image: this.img.image, concealed: isConcealed(this.clipboard) };
    if (!item) return; // something that is not shared
    if (!this.breaker.hit()) return this._tripped(); // copies faster than a person: a loop?
    item.key = s.key;
    item.stamp = this.latest.copied(item.kind, item.id);
    item.sent = false;
    this.echo.note(item.key);
    this.item = item;
    if (this.cfg.mode === 'instant') await this._sendPending();
  }

  // The breaker stopped the sync for a while (logged once per trip, shown on the page).
  _tripped() {
    if (this.trips !== this.breaker.trips) {
      this.trips = this.breaker.trips;
      console.warn('clipboard sync paused for 30 s: copies were coming in too fast (a loop?)');
    }
    this.onChange();
  }

  // Add to the Recent list (nothing at all when it is off); from: the name of the device it came from.
  _remember(entry, from) {
    this.hist.max = this.cfg.historySize | 0;
    if (!this.hist.max) return;
    try {
      const id = this.hist.add(entry);
      const it = id && this.hist.get(id);
      if (it && from) it.from = from;
    } catch (_) { /* unwritable cache: not listed */ }
  }

  // Name of the device where an item started: the mesh entry, else the sender's own name.
  _nameOf(origin, on, from) {
    const o = this.mesh.get(origin);
    if (o && o.name) return o.name;
    if (typeof on === 'string' && on) return on.slice(0, 100);
    const f = this.mesh.get(from);
    return (f && f.name) || from;
  }

  _connected() {
    return this.bus.connectedIds().length > 0;
  }

  // Send what this PC copied last, if allowed and not sent yet, to the pool. Always with the time
  // of the copy. An answer to clip.request is the same thing: the copy, published to every device
  // that accepts it (the requester included; the others already have it or ignore it by its time).
  // A targeted, unstamped answer would collide with this device's pool sequence numbers at the
  // receiver, so there is none.
  async sendIfChanged(why) {
    const c = this.cfg;
    if (!c.enabled || !c.send || !this._connected()) return;
    await this.tick(); // a copy made a moment ago is stamped first
    return this._sendPending();
  }

  async _sendPending() {
    const c = this.cfg;
    if (!c.enabled || !c.send || !this._connected()) return;
    const it = this.item;
    if (!it || it.sent || it.received) return;
    if (!this.peerAccepts) return this._skip("{name} doesn't accept {me}’s clipboard");
    if (it.kind === 'text') return this._sendText(it, c);
    if (it.kind === 'image') return this._sendImage(it, c);
    if (it.kind === 'files') return this._sendFiles(it, c);
  }

  _sendText(it, c) {
    if (c.skipConcealed && it.concealed) {
      it.sent = true; // don't retry this item
      return this._skip('skipped a password (concealed item)');
    }
    const size = Buffer.byteLength(it.text, 'utf8');
    if (size > c.maxKB * 1024 || !P.clipAllowed(it.text)) {
      it.sent = true;
      return this._skip('skipped ' + Math.round(size / 1024) + ' KB (over ' + c.maxKB + ' KB)');
    }
    if (!this.pool.publish(S.textMessage(it.text, it.stamp)).sent.length) return;
    it.sent = true;
    this._remember({ kind: 'text', dir: 'out', text: it.text });
    this.lastSkip = '';
    this.onChange();
  }

  _sendImage(it, c) {
    if (!c.images) return;
    if (c.skipConcealed && it.concealed) {
      it.sent = true;
      return this._skip('skipped a password (concealed item)');
    }
    const sz = it.image.getSize();
    const png = it.image.toPNG();
    const msg = S.imageMessage({ id: it.id, w: sz.width, h: sz.height, png }, it.stamp);
    if (!msg) {
      it.sent = true;
      return this._skip('skipped an image (over ' + Math.round(P.CLIP_IMAGE_MAX_BYTES / MB) + ' MB)');
    }
    if (!this.pool.publish(msg).sent.length) return;
    it.sent = true;
    this._remember({ kind: 'image', dir: 'out', png, w: sz.width, h: sz.height });
    this.lastSkip = '';
    this.onChange();
  }

  // Files are announced straight to every connected device that takes files (each fetches them
  // from us over its own link); an offer is never relayed.
  _sendFiles(it, c) {
    if (!c.files || !this.fileClip) return;
    const to = this.bus.connectedIds().filter((id) => {
      const e = this.mesh.get(id);
      return !!e && e.pool !== false && e.files !== false;
    });
    if (!to.length) return;
    const r = this.fileClip.announce(it.paths, it.stamp, it.id, c.filesMaxMB, true, to);
    it.sent = true; // announced (or nothing to announce)
    if (r) {
      this.lastSkip = '';
      if (!it.again) this._remember({ kind: 'files', dir: 'out', files: it.paths.map((p) => ({ path: p })) }); // a copy of the list's own files is already listed
    }
    this.onChange();
  }

  // Monitor 2 lost focus: ask the selected device for its newest copy (it answers only if it holds
  // one not sent yet).
  request() {
    const id = this.bus.selectedId();
    if (id) this.bus.send(id, { t: P.T.CLIP_REQUEST });
  }

  _skip(why) {
    if (this.lastSkip === why) return;
    this.lastSkip = why;
    this.onChange();
  }

  // ---- items from other devices ----

  // Write something to the clipboard without it counting as a copy made here: the fingerprint
  // is taken again right after, so the poll sees nothing new.
  async _apply(write, key) {
    this.applying = true;
    try {
      await write();
      this.img = null; // look at the image again, not at the cached look
      const s = await this._signature();
      this.sig = s.sig;
      this.echo.note(key); // what we wrote, and what the clipboard shows of it
      this.echo.note(s.key);
    } finally {
      this.applying = false;
    }
  }

  // A copy being noticed right now is stamped first, then the incoming item is compared with it.
  // m: the pooled message (its `o` is the device where the copy was made, `ts` its time).
  async _accept(m, kind, id) {
    if (this.busy) await this.busy.catch(() => {});
    if (!this.latest.accept({ ts: m.ts, o: m.o, from: m.o }, kind, id)) return null;
    const cur = this.latest.cur;
    this.item = { kind, id, stamp: { ts: cur.ts, o: cur.o }, sent: true, received: true };
    return this.item;
  }

  async _onClip(m, from) {
    const c = this.cfg;
    if (!c.enabled || !c.receive || !m || !P.clipAllowed(m.text)) return;
    const r = this.pool.receive(from, m);
    if (!r.fresh) return;
    if (!(await this._accept(r.msg, 'text', md5(m.text).slice(0, 16)))) return;
    const key = G.textKey(m.text);
    await this._apply(async () => {
      if (G.textKey(await this._readText()) !== key) this.clipboard.writeText(m.text); // the same content is left alone
    }, key);
    this._remember({ kind: 'text', dir: 'in', text: m.text }, this._nameOf(r.msg.o, m.on, from));
    this.onChange();
  }

  async _onImage(m, from) {
    const c = this.cfg;
    if (!c.enabled || !c.receive || !c.images) return;
    const img = S.readImage(m);
    if (!img) return;
    const im = this.nativeImage.createFromBuffer(img.png);
    if (im.isEmpty()) return;
    const r = this.pool.receive(from, m); // relayed as it came: one image per hop, not re-encoded
    if (!r.fresh) return;
    if (!(await this._accept(r.msg, 'image', img.id))) return;
    const key = imageKeyOf(im);
    await this._apply(() => {
      if (this._readImage().key !== key) this.clipboard.writeImage(im);
    }, key);
    this._remember({ kind: 'image', dir: 'in', png: img.png, w: img.w, h: img.h }, this._nameOf(r.msg.o, null, from));
    this.onChange();
  }

  // fclip.offer from `from`: true when it is the newest copy known (fclip.js asks for the selected
  // device, this file for the others). Memoised per offer: both may ask.
  acceptOffer(m, from) {
    if (this.offers.has(m.id)) return this.offers.get(m.id);
    const ok = this.latest.accept({ ts: m.ts, o: m.o, from: m.o || from }, 'files', m.id);
    this.offers.set(m.id, ok);
    if (this.offers.size > 50) this.offers.delete(this.offers.keys().next().value);
    if (ok) this.item = { kind: 'files', id: m.id, stamp: { ts: this.latest.cur.ts, o: this.latest.cur.o }, sent: true, received: true };
    return ok;
  }

  // fclip.offer of the selected device accepted as the newest copy (fclip.js): fetch it now when it
  // is small and sent for that (`eager`), else tell how to paste it. Only the selected device can
  // serve a fetch (the file machinery follows it, docs/mesh.md).
  fileOffered(inc, m) {
    const c = this.cfg;
    if (!c.enabled || !c.receive || !c.files || !this.fileClip) return;
    if (m.eager === true && inc.bytes <= c.filesMaxMB * MB) return this._pull(inc);
    if (m.eager === true || m.lazy === true) this.fileClip.notice(inc);
  }

  _pull(inc) {
    const from = this.bus.selectedId();
    if (!from) return;
    const dir = path.join(this.cacheDir, inc.id.replace(/[^\w-]/g, '_').slice(0, 64));
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { return; }
    this.pulling = { id: inc.id, from };
    this.fileClip.fileRecv.expectBatch(inc.id, dir, inc.bytes, true);
    this.bus.send(from, { t: P.T.FCLIP_PASTE, id: inc.id });
    const t = setTimeout(() => { if (this.pulling && this.pulling.id === inc.id) this.pulling = null; }, 10 * 60 * 1000);
    if (t.unref) t.unref();
  }

  // The files of a fetch landed (main.js, fileRecv.onBatch). True = it was ours.
  filesArrived(b) {
    if (!b.quiet) return false;
    const mine = this.pulling && this.pulling.id === b.batch;
    if (mine) this.pulling = null;
    if (this.cacheDir) pruneCache(this.cacheDir);
    const cur = this.latest.cur;
    if (mine && b.ok && Array.isArray(b.placed) && b.placed.length && cur && cur.id === b.batch) {
      this.item = { kind: 'files', id: b.batch, stamp: { ts: cur.ts, o: cur.o }, sent: true, received: true };
      const key = filesInfo(b.placed).key;
      this._later(() => this._apply(async () => {
        if ((await this._signature()).key !== key) await this.helper.setFileDrop(b.placed);
      }, key).then(() => {
        this._remember({ kind: 'files', dir: 'in', files: b.placed.map((p) => ({ path: p })) }, this._nameOf(cur.o, null, cur.o));
        this.onChange();
      }));
    }
    return true;
  }

  // Put a Recent item back on the clipboard as a new copy: stamped now, so it goes out to the pool by
  // the normal rules and wins over older ones. False when it is not kept (or gone).
  copyHistory(id) {
    return this._later(async () => {
      const c = this.hist.content(id);
      if (!c) return false;
      if (this.busy) await this.busy.catch(() => {}); // a copy being noticed is stamped first
      if (!this.breaker.hit()) { this._tripped(); return false; }
      const im = c.kind === 'image' ? this.nativeImage.createFromBuffer(c.png) : null;
      const item = c.kind === 'text' ? { kind: 'text', id: md5(c.text).slice(0, 16), text: c.text, concealed: false, key: G.textKey(c.text) }
        : c.kind === 'image' ? { kind: 'image', id: md5(c.png).slice(0, 16), image: im, concealed: false, key: imageKeyOf(im) }
          : { kind: 'files', id: crypto.randomUUID(), paths: c.paths, again: true, key: filesInfo(c.paths).key };
      await this._apply(async () => {
        if (c.kind === 'text') this.clipboard.writeText(c.text);
        else if (c.kind === 'image') this.clipboard.writeImage(im);
        else await this.helper.setFileDrop(c.paths);
      }, item.key);
      item.stamp = this.latest.copied(item.kind, item.id);
      item.sent = false;
      this.item = item;
      if (this.cfg.mode === 'instant') await this._sendPending();
      this.onChange();
      return true;
    });
  }

  // Everything of one Recent item for the Preview window (null = gone).
  previewHistory(id) {
    return this.hist.preview(id);
  }

  clearHistory() {
    this._wipeHistory();
    this.onChange();
  }

  // A small picture for an image row, made once per item.
  _thumb(id) {
    if (this.thumbs.has(id)) return this.thumbs.get(id);
    let url = '';
    try {
      const c = this.hist.content(id);
      if (c) url = this.nativeImage.createFromBuffer(c.png).resize({ width: THUMB_W }).toDataURL();
    } catch (_) { /* no thumbnail */ }
    this.thumbs.set(id, url);
    return url;
  }

  get view() {
    const rows = this.hist.list();
    for (const id of this.thumbs.keys()) if (!rows.some((r) => r.id === id)) this.thumbs.delete(id);
    return {
      peerAccepts: this.peerAccepts,
      lastSkip: this.lastSkip,
      paused: this.breaker.paused,
      pausedUntil: this.breaker.paused ? this.breaker.until : 0,
      history: rows.map((r) => {
        const from = (this.hist.get(r.id) || {}).from || '';
        return r.kind === 'image' && r.kept ? { ...r, from, thumb: this._thumb(r.id) } : { ...r, from };
      }),
    };
  }
}

Clip.pruneCache = pruneCache;
module.exports = Clip;
