// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Copy and paste files between the computers with two global shortcuts (default
// ⌃⌥C / ⌃⌥V, Files tab). Copy announces the files selected in Finder (else the files on the
// clipboard) with `fclip.offer`; paste on the other computer asks for them with `fclip.paste` and
// they arrive as a batch (filesend.js / drop.js, drop:'paste') in the folder that was in front.
//
// Files copied normally (Finder ⌘C) are shared through here too, with the clipboard sharing's
// rules (clipboard.js): a small enough copy is announced as `fclip.offer` {eager, auto, ts, o} and
// the other side fetches it at once (`fclip.paste`) into a cache folder, then puts the received
// local files on its clipboard; a bigger one waits for the paste shortcut as before.
//
// Events: 'change' — this.view changed; 'popup' (kind, text) — for hud.js.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { globalShortcut, app } = require('electron');
const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');

const T = P.T;
const DESKTOP = path.join(os.homedir(), 'Desktop');

const CACHE_KEEP = 3; // received clipboard copies kept besides the newest
const CACHE_MAX_AGE_MS = 60 * 60 * 1000;

// Delete cache folders (one per received copy) older than an hour, always keeping the newest few.
function pruneCache(root, { keep = CACHE_KEEP, maxAge = CACHE_MAX_AGE_MS, now = Date.now() } = {}) {
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => {
      const p = path.join(root, d.name);
      return { p, t: fs.statSync(p).mtimeMs };
    });
  } catch { return; }
  dirs.sort((a, b) => b.t - a.t);
  for (const d of dirs.slice(keep)) if (now - d.t > maxAge) fs.rmSync(d.p, { recursive: true, force: true });
}

// 'Control+Alt+V' as ⌃⌥V.
const symbols = (acc) => String(acc).replace(/Control/g, '⌃').replace(/Alt/g, '⌥').replace(/Shift/g, '⇧').replace(/Command/g, '⌘').replace(/\+/g, '');

function osascript(script) {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 3000 }, (err, out) => resolve(err ? '' : String(out).trim()));
  });
}

const finderSelection = () => osascript(
  'tell application "Finder"\nset out to ""\nrepeat with i in (get selection)\nset out to out & POSIX path of (i as alias) & linefeed\nend repeat\nreturn out\nend tell',
).then((o) => o.split('\n').map((l) => l.replace(/\/$/, '')).filter(Boolean));

const finderFolder = () => osascript(
  'tell application "Finder" to if (count of Finder windows) > 0 then return POSIX path of (target of front Finder window as alias)',
);

class FileClip extends EventEmitter {
  constructor({ server, helper, fileSend, drop, getSettings, clipboard = null }) {
    super();
    Object.assign(this, { server, helper, fileSend, drop, getSettings, clipboard });
    this.offer = null; // ours: { id, paths, items, files, bytes, auto }
    this.incoming = null; // theirs: { id, items, files, bytes, at, auto, eager }
    this.pasting = null; // { id, files }
    this.clipPending = null; // fclip id of a copy being fetched for the clipboard
    this.error = '';
    try {
      this.cacheRoot = path.join(app.getPath('userData'), 'clipboard-files');
      fs.rmSync(this.cacheRoot, { recursive: true, force: true }); // nothing from an earlier run
      setInterval(() => pruneCache(this.cacheRoot), 10 * 60 * 1000).unref();
    } catch {
      this.cacheRoot = path.join(os.tmpdir(), 'twindesk-clipboard-files');
    }

    server.on(`t:${T.FCLIP_OFFER}`, (m) => {
      if (typeof m.id !== 'string' || !Array.isArray(m.items)) return;
      const cb = this.clipboard;
      const c = cb ? cb.cfg : {};
      const shared = c.enabled && c.receive; // the clipboard sharing's rules and order apply
      if (m.auto && !(shared && c.files)) return; // a normal copy there; not taken here
      if (shared && !cb.latest.accept(m, 'files', m.id)) return; // older than a copy we already know
      const items = m.items.slice(0, 1000).map((i) => ({ name: String(i.name || '').slice(0, 200), dir: !!i.dir, size: Number(i.size) || 0 }));
      this.incoming = { id: m.id, items, files: Number(m.files) || 0, bytes: Number(m.bytes) || 0, at: Date.now(), auto: !!m.auto, eager: m.eager === true };
      this.emit('change');
      if (m.auto) this._autoReceive(this.incoming, c);
    });
    server.on(`t:${T.FCLIP_GONE}`, (m) => {
      if (this.incoming && this.incoming.id === m.id) this.incoming = null;
      if (this.pasting && this.pasting.id === m.id) {
        this.pasting = null;
        this.emit('popup', 'home', 'Those files aren’t there any more');
      }
      this.emit('change');
    });
    server.on(`t:${T.FCLIP_PASTE}`, (m) => this._send(m.id));
    // The other computer's keyboard pressed its copy/paste shortcut while the pointer is here.
    server.on(`t:${T.FCLIP_KEY}`, (m) => {
      if (m.action === 'copy') this.copy();
      else if (m.action === 'paste') this.paste();
    });
    server.on('closed', () => {
      if (server.current) return;
      this.incoming = null;
      this.pasting = null;
      this.emit('change');
    });
    drop.on('batch', (b) => {
      if (b.kind !== 'paste') return;
      if (b.quiet) return this._clipArrived(b);
      this.pasting = null;
      this.emit('popup', 'home', b.ok ? `Pasted ${plural(b.files, 'file')}` : `Pasted ${b.files} of ${b.count} files`);
      this.emit('change');
    });
    this.apply();
  }

  get cfg() {
    return this.getSettings().files;
  }

  get peerName() {
    return this.server.current ? this.server.current.name : 'the other computer';
  }

  // (Re)register the two shortcuts from settings.files.copyKeys / pasteKeys.
  apply() {
    globalShortcut.unregisterAll();
    this.error = '';
    if (this.cfg.shortcuts !== false) {
      const bad = [];
      for (const [acc, fn] of [[this.cfg.copyKeys, () => this.copy()], [this.cfg.pasteKeys, () => this.paste()]]) {
        try {
          if (!acc || !globalShortcut.register(acc, fn)) bad.push(acc);
        } catch {
          bad.push(acc);
        }
      }
      if (bad.length) this.error = `Couldn’t use ${bad.join(' and ')}. Another app may have it.`;
    }
    this.emit('change');
  }

  // While this Mac drives the other computer, its key events go through here (kvm.js) before they
  // are sent: our own copy/paste shortcut becomes `fclip.key`, so it happens where the pointer is.
  // Returns true when the event was used up.
  intercept(e) {
    const MODS = { ControlLeft: 'Control', ControlRight: 'Control', AltLeft: 'Alt', AltRight: 'Alt', ShiftLeft: 'Shift', ShiftRight: 'Shift', MetaLeft: 'Command', MetaRight: 'Command' };
    if (!this.held) this.held = new Set();
    if (!this.eaten) this.eaten = new Set();
    if (e.t !== T.K_KEY_DOWN && e.t !== T.K_KEY_UP) return false;
    if (MODS[e.code]) {
      if (e.t === T.K_KEY_DOWN) this.held.add(e.code);
      else this.held.delete(e.code);
      return false;
    }
    if (e.t === T.K_KEY_UP) return this.eaten.delete(e.code);
    if (this.cfg.shortcuts === false) return false;
    const mods = [...new Set([...this.held].map((c) => MODS[c]))].sort().join('+');
    const key = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : /^Digit\d$/.test(e.code) ? e.code.slice(5) : e.code;
    const match = (acc) => {
      const parts = String(acc || '').split('+');
      return parts.pop() === key && parts.sort().join('+') === mods;
    };
    const action = match(this.cfg.copyKeys) ? 'copy' : match(this.cfg.pasteKeys) ? 'paste' : '';
    if (!action) return false;
    this.eaten.add(e.code);
    this.server.sendToClient({ t: T.FCLIP_KEY, action });
    return true;
  }

  async copy() {
    if (!this.server.current) return this.emit('popup', 'home', 'Not connected');
    let paths = [];
    try {
      const src = await this.helper.request('fileSource');
      paths = src.front === 'com.apple.finder' ? await finderSelection() : [];
      if (!paths.length) paths = src.files || [];
    } catch { /* no helper: nothing to copy */ }
    paths = paths.filter((p) => fs.existsSync(p));
    if (!paths.length) return this.emit('popup', 'home', 'Select files in Finder first');
    const plan = this.fileSend.planDrag(paths);
    if (!plan) return this.emit('popup', 'home', 'Nothing to copy there');
    const id = crypto.randomUUID();
    this._announce(id, paths, plan, { stamp: this.clipboard ? this.clipboard.latest.copied('files', id) : null });
    this.emit('popup', 'away', `Copied ${plan.items.length === 1 ? plan.items[0].name : plural(plan.items.length, 'item')} for ${this.peerName}`);
    this.emit('change');
  }

  // Send the offer: items, the whole tree (list / dirs: a PC pastes it with Windows' own copy
  // dialog), the time of the copy. auto: found on the clipboard (not the shortcut); eager: the other
  // side may fetch it at once.
  _announce(id, paths, plan, { stamp = null, auto = false, eager = false } = {}) {
    if (this.offer) this.server.sendToClient({ t: T.FCLIP_GONE, id: this.offer.id }); // newest copy wins
    this.offer = { id, paths, items: plan.items, files: plan.files, bytes: plan.bytes, auto };
    this.server.sendToClient({
      t: T.FCLIP_OFFER, id, items: plan.items, files: plan.files, bytes: plan.bytes,
      list: plan.list.map((f) => ({ rel: f.rel, size: f.size })), dirs: plan.dirs,
      ...(stamp ? { ts: stamp.ts, o: stamp.o } : {}), ...(auto ? { auto: true, eager } : {}),
    });
    this.emit('change');
  }

  // Files found on the clipboard (a normal copy, clipboard.js): announce them with the time of the copy.
  async announceClipboard(paths, stamp, maxMB) {
    if (!this.server.current) return;
    paths = paths.filter((p) => fs.existsSync(p));
    const plan = paths.length ? this.fileSend.planDrag(paths) : null;
    if (!plan) return;
    this._announce(crypto.randomUUID(), paths, plan, { stamp, auto: true, eager: plan.bytes <= maxMB * 1024 * 1024 });
  }

  // A newer copy that is not these files: they are not on the clipboard any more.
  retractAuto() {
    if (!this.offer || !this.offer.auto) return;
    this.server.sendToClient({ t: T.FCLIP_GONE, id: this.offer.id });
    this.offer = null;
    this.emit('change');
  }

  // A copy announced from the other computer's normal copy: fetch it now into the cache folder
  // when it is small enough, else say how to paste it.
  _autoReceive(inc, c) {
    const max = c.filesMaxMB * 1024 * 1024;
    if (inc.eager && inc.bytes <= max) {
      const dir = path.join(this.cacheRoot, crypto.createHash('sha1').update(inc.id).digest('hex').slice(0, 16));
      this.drop.expectBatch(inc.id, dir, true);
      this.clipPending = inc.id;
      this.server.sendToClient({ t: T.FCLIP_PASTE, id: inc.id });
      return;
    }
    const mb = Math.max(1, Math.round(inc.bytes / 1048576));
    this.emit('popup', 'home', `${mb} MB of files on ${this.peerName}: use ${symbols(this.getSettings().files.pasteKeys)} to paste`);
  }

  // The files fetched for the clipboard are in the cache folder: they become the clipboard.
  _clipArrived(b) {
    if (this.clipPending !== b.batch) return;
    this.clipPending = null;
    pruneCache(this.cacheRoot);
    if (b.ok && b.placed.length && this.clipboard) this.clipboard.applyFiles(b.placed, b.batch);
  }

  async paste() {
    const inc = this.incoming;
    if (!this.server.current) return this.emit('popup', 'home', 'Not connected');
    if (!inc) return this.emit('popup', 'home', `Nothing copied on ${this.peerName}`);
    let dir = '';
    try {
      const src = await this.helper.request('fileSource');
      if (src.front === 'com.apple.finder') dir = await finderFolder();
    } catch { /* Desktop */ }
    dir = dir && fs.existsSync(dir) ? dir.replace(/\/$/, '') : DESKTOP;
    this.drop.expectBatch(inc.id, dir);
    this.pasting = { id: inc.id, files: inc.files };
    this.server.sendToClient({ t: T.FCLIP_PASTE, id: inc.id });
    this.emit('popup', 'driven', `Pasting ${plural(inc.files, 'file')}…`);
    this.emit('change');
  }

  // The peer pasted: send our copied files (or say they're gone).
  _send(id) {
    const o = this.offer;
    if (!o || o.id !== id || !o.paths.some((p) => fs.existsSync(p))) {
      return this.server.sendToClient({ t: T.FCLIP_GONE, id });
    }
    if (!this.fileSend.sendBatch(o.paths.filter((p) => fs.existsSync(p)), 'paste', id)) {
      this.server.sendToClient({ t: T.FCLIP_GONE, id });
    }
  }

  get view() {
    return {
      error: this.error,
      offer: this.offer && !this.offer.auto && { files: this.offer.files, items: this.offer.items.length },
      incoming: this.incoming && !(this.incoming.auto && this.incoming.eager) && { files: this.incoming.files, items: this.incoming.items.length, name: this.incoming.items.length === 1 ? this.incoming.items[0].name : '' },
      pasting: !!this.pasting,
    };
  }
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

module.exports = { FileClip, pruneCache };
