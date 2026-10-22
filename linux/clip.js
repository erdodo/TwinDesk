// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Clipboard sharing: text, images and (with fclip.js) files. What was copied last, on either computer,
// is what both paste (shared/clipsync.js): the clipboard is watched all the time and every copy gets
// its time when it happens, even when nothing is sent; what goes out carries that time, and what
// comes in is applied only when it is newer than the newest copy known here. Also: directions,
// switch/instant mode, concealed filter, size limits, clip.policy both ways, and the Recent list
// (shared/clip-history.js): texts in memory, images and files kept in the app's cache folder.
const path = require('path');
const { app, clipboard, nativeImage } = require('electron');
const { ClipHistory } = require('../shared/clip-history.js');
const P = require('../shared/protocol.js');
const sync = require('../shared/clipsync.js');
const { EchoGuard, Breaker } = require('../shared/clipguard.js');
const io = require('./clipio');

const POLL_MS = 500; // how often the clipboard is checked for a new copy
const THUMB_W = 64; // width of the thumbnail of an image in the Recent list

// Password managers mark secrets so clipboard tools leave them alone. clipboard.has() doesn't see
// these registered formats; readBuffer() does (empty buffer = format absent).
function isConcealed() {
  try {
    if (clipboard.readBuffer('ExcludeClipboardContentFromMonitorProcessing').length) return true;
    if (clipboard.readBuffer('Clipboard Viewer Ignore').length) return true;
    const b = clipboard.readBuffer('CanIncludeInClipboardHistory');
    if (b && b.length >= 4 && b.readUInt32LE(0) === 0) return true;
  } catch (_) { /* unknown format: not concealed */ }
  return false;
}

class Clip {
  // getSettings() → settings.clipboard; onChange() → the view changed;
  // opts: selfId (this device, for the copy times), now() (tests)
  constructor(link, getSettings, onChange, opts = {}) {
    this.link = link;
    this.getSettings = getSettings;
    this.onChange = onChange;
    this.selfId = opts.selfId || 'linux';
    this.latest = new sync.Latest({ selfId: this.selfId, clock: new sync.Clock(opts.now) });
    this.fileClip = null; // fclip.js, set by main: files copied and received
    this.peerAccepts = true; // the other side's last clip.policy
    this.history = new ClipHistory({ dir: opts.historyDir || path.join(app.getPath('userData'), 'cliphist'), max: this.cfg.historySize, maxBytes: 200 * 1048576 });
    this.history.wipe(); // nothing from an earlier run stays on disk
    this.thumbs = new Map(); // history id → data URL
    this.fromHistory = null;
    this.echo = new EchoGuard({ now: opts.now }); // content we wrote or sent a moment ago: its change is ours
    this.breaker = new Breaker({ now: opts.now }); // copies faster than a person: pause
    this.pausedNote = false; // id of the Recent item being copied again; the next copy seen is that one
    this.lastSkip = '';
    this.seen = undefined; // key of the clipboard at the last check (undefined = not looked yet)
    this.item = null; // the copy on the clipboard now: {kind, stamp, p, concealed, sent}
    this.force = false; // the next check counts as a new copy even if nothing changed
    this.chain = Promise.resolve(); // checks and applies one after another
    this.checking = false;

    link.on(P.T.CLIP, (m) => this._onClip(m));
    link.on(P.T.CLIP_IMAGE, (m) => this._onImage(m));
    link.on(P.T.CLIP_LATEST, (m) => this._onLatest(m));
    link.on(P.T.CLIP_POLICY, (m) => {
      this.peerAccepts = m.accept !== false;
      this.onChange();
    });
    link.on('welcome', () => {
      this.peerAccepts = true;
      this.applySettings(); // sends clip.policy
      const l = this.latest.latestMessage();
      if (l) this.link.send(l); // the other side asks for ours if it is newer than its newest
    });
    link.on(P.T.CLIP_REQUEST, (m) => this._onRequest(m));

    this.poll = setInterval(() => {
      if (this.checking) return;
      this.checking = true;
      this._scan().finally(() => { this.checking = false; });
    }, POLL_MS);
    if (this.poll.unref) this.poll.unref();
  }

  get cfg() {
    return this.getSettings();
  }

  get connected() {
    return this.link.status.state === 'connected';
  }

  // Call after settings.clipboard changed.
  applySettings() {
    const c = this.cfg;
    this.history.setMax(c.historySize);
    this.sendPolicy();
    this.onChange();
  }

  sendPolicy() {
    const c = this.cfg;
    this.link.send({ t: P.T.CLIP_POLICY, accept: !!(c.enabled && c.receive) });
  }

  // Runs fn after everything queued before it.
  _run(fn) {
    const r = this.chain.then(fn);
    this.chain = r.catch(() => {});
    return r;
  }

  _scan() {
    return this._run(() => this._check()).catch(() => {});
  }

  // Is the clipboard different from last time? Then it is a new copy: it gets its time now.
  async _check() {
    let p = await io.probe();
    if (p.kind === 'none' && !p.formats.length && this.fileClip) { // Wayland, TwinDesk in the background: the helper still sees files
      const paths = await this.fileClip.clipboardFiles();
      if (paths.length) p = { kind: 'files', key: io.filesKeyOf(paths), paths };
    }
    if (p.kind === 'none') { // nothing to see (empty, or Wayland with TwinDesk in the background)
      if (this.seen === undefined) this.seen = '';
      return;
    }
    if (p.key === this.seen && !this.force) return;
    const first = this.seen === undefined;
    this.seen = p.key;
    this.force = false;
    if (first) return; // already there when TwinDesk started: not a new copy
    if (p.kind === 'files' && this.fileClip && this.fileClip.isCache(p.paths)) return; // files received from the other computer
    const again = this.fromHistory; // Copy again by the user: a person, never an echo
    this.fromHistory = null;
    if (!again && this.echo.isEcho(p.key)) return; // the system touching what we wrote: not a copy
    if (again ? this.breaker.paused : !this.breaker.hit()) { // faster than a person: a loop?
      if (!this.pausedNote) console.warn('clipboard sync paused: copies were coming in too fast');
      this.pausedNote = true;
      this.onChange();
      return;
    }
    this.pausedNote = false;
    this.echo.note(p.key);
    const id = p.kind === 'text' ? undefined : p.key;
    const item = { kind: p.kind, stamp: this.latest.copied(p.kind, id), p, concealed: !!this.cfg.skipConcealed && isConcealed(), sent: false, again };
    this.item = item;
    if (p.kind !== 'files' && this.fileClip) this.fileClip.retract();
    if (this.cfg.mode === 'instant') await this._send(item);
  }

  // What the clipboard holds now, remembered so that putting something on it is not seen as a copy.
  async _settle(kind, stamp, key) {
    this.echo.note(key);
    const now = await io.probe();
    if (now.kind !== 'none') this.echo.note(now.key);
    if (now.kind !== 'none') this.seen = now.key;
    this.item = { kind, stamp, p: now, concealed: false, sent: true };
    this.onChange();
  }

  _wants(kind) {
    const c = this.cfg;
    return c.enabled && c.receive && (kind === 'text' || (kind === 'image' ? c.images : c.files));
  }

  // Adds to the Recent list (nothing when it is off); a copy made by Copy again is already there.
  _remember(dir, entry, again) {
    if (again || !this.cfg.historySize) return;
    try { this.history.add({ ...entry, dir }); } catch (_) { /* disk trouble: the list is a convenience */ }
  }

  async _onClip(m) {
    if (!this._wants('text') || !P.clipAllowed(m.text)) return;
    await this._run(async () => {
      await this._check(); // a copy made here a moment ago must be known before judging this one
      if (!this.latest.accept(m, 'text')) return;
      const stamp = this.latest.cur;
      if (io.textKey(await io.readText()) !== io.textKey(m.text)) io.writeText(m.text); // already there: leave it alone
      await this._settle('text', stamp, io.textKey(m.text));
      this._remember('in', { kind: 'text', text: m.text });
    }).catch(() => {});
  }

  async _onImage(m) {
    if (!this._wants('image')) return;
    const img = sync.readImage(m);
    if (!img) return;
    await this._run(async () => {
      await this._check();
      if (!this.latest.accept(m, 'image', img.id)) return;
      const stamp = this.latest.cur;
      const key = io.imageKeyOf(img.png);
      if ((await io.probe()).key === key || io.writeImage(img.png)) { // already there: not written again
        await this._settle('image', stamp, key);
        this._remember('in', { kind: 'image', png: img.png, w: img.w, h: img.h });
      }
    }).catch(() => {});
  }

  // The other side's newest copy: ask for it when it is newer than ours.
  async _onLatest(m) {
    if (!this._wants(m.kind === 'image' ? 'image' : m.kind === 'files' ? 'files' : 'text')) return;
    await this._scan();
    if (this.latest.isNewer(m)) this.link.send({ t: P.T.CLIP_REQUEST, force: true });
  }

  // The other side asks for our clipboard: its copy if it changed since it was sent (older apps ask
  // at every focus change); force = it knows ours is newer, send it again.
  async _onRequest(m) {
    await this._scan();
    const it = this.item;
    if (it && (!it.sent || (m && m.force))) await this._send(it);
  }

  // Send this computer's copy if allowed. The message carries the time of the copy, not of sending.
  async sendIfChanged() {
    await this._scan();
    if (this.item && !this.item.sent) await this._send(this.item);
  }

  async _send(it) {
    const c = this.cfg;
    if (!c.enabled || !c.send || !this.connected || it.stamp.o !== this.selfId) return;
    if (it.kind === 'image' ? !c.images : it.kind === 'files' ? !c.files : false) return;
    if (!this.peerAccepts) return this._skip("{name} doesn't accept {me}’s clipboard");
    if (it.kind === 'files') {
      it.sent = true;
      if (this.fileClip) this.fileClip.clipCopied(it.p.paths, it.stamp, (c.filesMaxMB || 0) * 1024 * 1024);
      this._remember('out', { kind: 'files', files: it.p.paths.map((p) => ({ path: p })) }, it.again);
      return;
    }
    if (it.concealed) {
      it.sent = true; // don't retry this item
      return this._skip('skipped a password (concealed item)');
    }
    if (it.kind === 'image') {
      const png = it.p.png;
      const size = io.imageSize(png);
      const msg = sync.imageMessage({ id: it.p.key, w: size.width, h: size.height, png }, it.stamp);
      it.sent = true;
      if (!msg) return this._skip('skipped an image of ' + Math.round(png.length / 1048576) + ' MB (over ' + P.CLIP_IMAGE_MAX_BYTES / 1048576 + ' MB)');
      if (!this.link.send(msg)) it.sent = false;
      else {
        this.lastSkip = '';
        this._remember('out', { kind: 'image', png, w: size.width, h: size.height }, it.again);
      }
      return this.onChange();
    }
    const text = it.p.text;
    const size = Buffer.byteLength(text, 'utf8');
    if (size > c.maxKB * 1024 || !P.clipAllowed(text)) {
      it.sent = true;
      return this._skip('skipped ' + Math.round(size / 1024) + ' KB (over ' + c.maxKB + ' KB)');
    }
    if (!this.link.send(sync.textMessage(text, it.stamp))) return;
    it.sent = true;
    this._remember('out', { kind: 'text', text }, it.again);
    this.lastSkip = '';
    this.onChange();
  }

  // Received files are ready (fclip.js): put them on the clipboard as a file list, if they are still
  // the newest copy. Resolves true when they are there.
  applyFiles(paths, id) {
    return this._run(async () => {
      await this._check();
      const cur = this.latest.cur;
      if (!cur || cur.kind !== 'files' || cur.id !== id) return false; // a newer copy came meanwhile
      const key = io.filesKeyOf(paths);
      if ((await io.probe()).key !== key && !(await io.writeFiles(paths))) return false;
      await this._settle('files', cur, key);
      this._remember('in', { kind: 'files', files: paths.map((p) => ({ path: p })) });
      return true;
    }).catch(() => false);
  }

  // The newest copy known here is this file offer? (fclip.js, before it asks for the files)
  acceptFiles(m) {
    return this._run(async () => {
      await this._check();
      return this.latest.accept(m, 'files', m.id);
    }).catch(() => false);
  }

  // Monitor 2 lost focus: ask the other side for its clipboard (it answers only if it changed).
  request() {
    this.link.send({ t: P.T.CLIP_REQUEST });
  }

  _skip(why) {
    if (this.lastSkip === why) return;
    this.lastSkip = why;
    this.onChange();
  }

  // Put a Recent item back on the clipboard as a new copy of now: it goes out by the normal rules and
  // beats older copies. Resolves false when the item is gone or was not kept (names only).
  copyHistory(id) {
    return this._run(async () => {
      const c = this.history.content(id);
      if (!c) return false;
      await this._check(); // whatever was copied before is stamped before this one
      let ok = true;
      this.echo.note(c.kind === 'text' ? io.textKey(c.text) : c.kind === 'image' ? io.imageKeyOf(c.png) : io.filesKeyOf(c.paths));
      if (c.kind === 'text') io.writeText(c.text);
      else if (c.kind === 'image') ok = io.writeImage(c.png);
      else ok = await io.writeFiles(c.paths);
      if (!ok) return false;
      this.fromHistory = id;
      this.force = true;
      await this._check(); // sees the new clipboard: stamps it now (the poll then finds nothing new)
      if (this.cfg.mode === 'instant' && this.item && !this.item.sent) await this._send(this.item);
      return true;
    }).catch(() => false);
  }

  // Everything of a Recent item for the Preview window.
  previewHistory(id) {
    return this.history.preview(id);
  }

  clearHistory() {
    this.history.wipe();
    this.thumbs.clear();
    this.onChange();
  }

  // The app quits: the kept images and files go.
  shutdown() {
    clearInterval(this.poll);
    this.history.wipe();
  }

  // Small picture for an image row, made once per item.
  _thumb(id) {
    if (this.thumbs.has(id)) return this.thumbs.get(id);
    let url = '';
    try {
      const c = this.history.content(id);
      if (c && c.png) url = nativeImage.createFromBuffer(c.png).resize({ width: THUMB_W }).toDataURL();
    } catch (_) { /* no thumbnail */ }
    this.thumbs.set(id, url);
    return url;
  }

  get view() {
    const rows = this.history.list();
    const ids = new Set(rows.map((r) => r.id));
    for (const id of this.thumbs.keys()) if (!ids.has(id)) this.thumbs.delete(id);
    return {
      peerAccepts: this.peerAccepts,
      lastSkip: this.lastSkip,
      paused: this.breaker.paused,
      pausedUntil: this.breaker.until,
      filesNote: this.cfg.files && this.cfg.enabled && this.cfg.receive ? io.missingTool() : '',
      history: rows.map((r) => (r.kind === 'image' && r.kept ? { ...r, thumb: this._thumb(r.id) } : r)),
    };
  }
}

module.exports = Clip;
