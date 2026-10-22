// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Clipboard sharing: text, images and (with fclip.js) files. What was copied last, on either computer,
// is what both paste (shared/clipsync.js): the clipboard is watched all the time and every copy gets
// its time when it happens, even when nothing is sent; what goes out carries that time, and what
// comes in is applied only when it is newer than the newest copy known here. Also: directions,
// switch/instant mode, concealed filter, size limits, clip.policy both ways, and the in-memory Recent
// list of texts (never on disk).
const { clipboard } = require('electron');
const P = require('../shared/protocol.js');
const sync = require('../shared/clipsync.js');
const io = require('./clipio');

const POLL_MS = 500; // how often the clipboard is checked for a new copy
const PREVIEW = 300; // characters kept per history item for the UI

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
    this.history = []; // newest first: {dir: 'out'|'in', at, text, size}
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
    if (c.historySize < this.history.length) this.history.length = c.historySize;
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
      if (paths.length) p = { kind: 'files', key: 'f:' + paths.join('\n'), paths };
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
    const id = p.kind === 'files' ? io.sha(Buffer.from(p.paths.join('\n'))) : p.kind === 'image' ? io.sha(p.png) : undefined;
    const item = { kind: p.kind, stamp: this.latest.copied(p.kind, id), p, concealed: !!this.cfg.skipConcealed && isConcealed(), sent: false };
    this.item = item;
    if (p.kind !== 'files' && this.fileClip) this.fileClip.retract();
    if (this.cfg.mode === 'instant') await this._send(item);
  }

  // What the clipboard holds now, remembered so that putting something on it is not seen as a copy.
  async _settle(kind, stamp) {
    const now = await io.probe();
    if (now.kind !== 'none') this.seen = now.key;
    this.item = { kind, stamp, p: now, concealed: false, sent: true };
    this.onChange();
  }

  _wants(kind) {
    const c = this.cfg;
    return c.enabled && c.receive && (kind === 'text' || (kind === 'image' ? c.images : c.files));
  }

  _remember(dir, text) {
    const n = this.cfg.historySize;
    if (!n) return;
    this.history = this.history.filter((h) => h.text !== text || h.dir !== dir);
    this.history.unshift({ dir, at: Date.now(), text, size: Buffer.byteLength(text, 'utf8') });
    if (this.history.length > n) this.history.length = n;
  }

  async _onClip(m) {
    if (!this._wants('text') || !P.clipAllowed(m.text)) return;
    await this._run(async () => {
      await this._check(); // a copy made here a moment ago must be known before judging this one
      if (!this.latest.accept(m, 'text')) return;
      const stamp = this.latest.cur;
      if ((await io.readText()) !== m.text) io.writeText(m.text);
      await this._settle('text', stamp);
      this._remember('in', m.text);
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
      if (io.writeImage(img.png)) await this._settle('image', stamp);
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
      return;
    }
    if (it.concealed) {
      it.sent = true; // don't retry this item
      return this._skip('skipped a password (concealed item)');
    }
    if (it.kind === 'image') {
      const png = it.p.png;
      const size = io.imageSize(png);
      const msg = sync.imageMessage({ id: io.sha(png), w: size.width, h: size.height, png }, it.stamp);
      it.sent = true;
      if (!msg) return this._skip('skipped an image of ' + Math.round(png.length / 1048576) + ' MB (over ' + P.CLIP_IMAGE_MAX_BYTES / 1048576 + ' MB)');
      if (!this.link.send(msg)) it.sent = false;
      else this.lastSkip = '';
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
    this._remember('out', text);
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
      if (!(await io.writeFiles(paths))) return false;
      await this._settle('files', cur);
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

  // Put a Recent item back on the clipboard (it then goes out by the normal rules).
  copyHistory(index) {
    const h = this.history[index];
    if (!h) return;
    io.writeText(h.text);
    this.force = true;
  }

  clearHistory() {
    this.history = [];
    this.onChange();
  }

  get view() {
    return {
      peerAccepts: this.peerAccepts,
      lastSkip: this.lastSkip,
      filesNote: this.cfg.files && this.cfg.enabled && this.cfg.receive ? io.missingTool() : '',
      history: this.history.map((h) => ({ dir: h.dir, at: h.at, size: h.size, text: h.text.slice(0, PREVIEW) })),
    };
  }
}

module.exports = Clip;
