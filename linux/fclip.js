// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Copy and paste files between the computers with two shortcuts (default Ctrl+Alt+C /
// Ctrl+Alt+V, Files tab). Port of windows/fclip.js.
// The helper sees the shortcuts at home (shortcut.c: Electron's global shortcuts need X11 and an X
// window in front); while this computer drives the other one, kvm.js passes our key events
// through intercept() first, so the shortcut happens where the pointer is (`fclip.key`).
// Copy: with a file manager in front (fm.js) we send it Ctrl+C, then take the files on the
// clipboard (text/uri-list, or GNOME's x-special/gnome-copied-files); files copied earlier in any
// app count too. The helper reads the clipboard as an X client (xclip.c): a Wayland desktop only
// shows it to the app in front, but mirrors it to XWayland. `fclip.offer` announces them; the other computer's paste asks for them with
// `fclip.paste` and they go as a batch (filedrop.js, drop:'paste'). Paste here: the batch lands in
// the folder of the file manager window in front, else Downloads (filerecv.js).
// Files copied normally (Ctrl+C in a file manager) are watched by clip.js: when they are small enough
// (clipboard.filesMaxMB) the offer says `eager`, the other computer pulls them at once into a cache
// folder and puts them on its clipboard as a file list, so its normal paste works; bigger ones are
// announced for the shortcut as before. Files received this way are never offered again.
const { app, clipboard } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const P = require('../shared/protocol.js');
const fm = require('./fm');
const { filesIn, missingTool } = require('./clipio');

const T = P.T;
const CACHE_KEEP = 3; // received clipboard files kept besides the one in use
const CACHE_MAX_AGE_MS = 60 * 60 * 1000;

class FileClip {
  // opts: link, helper, fileDrop, fileRecv, settings (shared), clip (clip.js), peerName(), popup(kind, text), onChange()
  constructor(opts) {
    Object.assign(this, opts);
    this.cacheDir = path.join(app.getPath('userData'), 'clipfiles'); // files received for the clipboard, one folder per copy
    try { fs.rmSync(this.cacheDir, { recursive: true, force: true }); } catch (_) { /* leftovers */ }
    this.pulling = null; // {id, dir}: a copy being fetched for our clipboard
    this.offer = null; // ours: {id, paths, items, files, bytes, sig, at, eager}
    this.incoming = null; // theirs: {id, items, files, bytes, at}
    this.pasting = null; // {id, files}
    this.held = new Set(); // modifiers held while driving (intercept)
    this.eaten = new Set(); // shortcut keys whose release isn't sent
    this.busy = false;

    const link = this.link;
    link.on(T.FCLIP_OFFER, (m) => this._onOffer(m));
    link.on(T.FCLIP_GONE, (m) => {
      if (this.incoming && this.incoming.id === m.id) this.incoming = null;
      if (this.pulling && this.pulling.id === m.id) this._cleanPull();
      if (this.pasting && this.pasting.id === m.id) {
        this.pasting = null;
        this.popup('home', 'Those files aren’t there any more');
      }
      this.onChange();
    });
    link.on(T.FCLIP_PASTE, (m) => this._send(m.id));
    // The other computer pressed its copy/paste shortcut while the pointer is here (it drives
    // this computer): do it here.
    link.on(T.FCLIP_KEY, (m) => {
      if (m.action === 'copy') this.copy();
      else if (m.action === 'paste') this.paste();
    });
    link.on('closed', () => {
      this.incoming = null;
      this.pasting = null;
      this._cleanPull();
      this.onChange();
    });
    this.helper.on('event', (name, m) => {
      if (name !== 'shortcut' || !this.cfg.shortcuts) return;
      if (m.action === 'copy') this.copy();
      else if (m.action === 'paste') this.paste();
    });
  }

  get cfg() {
    return this.settings.files;
  }

  get connected() {
    return this.link.status.state === 'connected';
  }

  // The other computer copied files. Only the newest copy counts; a copy from the normal clipboard
  // (`eager`) that fits clipboard.filesMaxMB is fetched at once, else the paste shortcut gets it.
  async _onOffer(m) {
    if (typeof m.id !== 'string' || !Array.isArray(m.items)) return;
    const c = this.settings.clipboard;
    const wants = !!(this.clip && c.enabled && c.receive && c.files);
    if (wants && !(await this.clip.acceptFiles(m))) return; // older than a copy we already have
    const items = m.items.slice(0, 1000).map((i) => ({ name: String((i && i.name) || '').slice(0, 200), dir: !!(i && i.dir), size: Number(i && i.size) || 0 }));
    const inc = { id: m.id, items, files: Number(m.files) || 0, bytes: Number(m.bytes) || 0, at: Date.now() };
    this.incoming = inc;
    this.onChange();
    if (!wants || typeof m.eager !== 'boolean') return;
    if (m.eager && inc.bytes <= c.filesMaxMB * 1024 * 1024 && !missingTool()) return this._pull(inc);
    const mb = Math.max(1, Math.round(inc.bytes / 1048576));
    this.popup('home', mb + ' MB copied on ' + this.peerName() + ': use ' + this.cfg.pasteKeys.replace(/Control/g, 'Ctrl') + ' to paste');
  }

  // Fetch a copy into the cache folder (the copier answers fclip.paste at once).
  _pull(inc) {
    this._cleanPull();
    this._sweep();
    this.pulling = { id: inc.id, dir: path.join(this.cacheDir, inc.id) };
    this.fileRecv.expectBatch(inc.id, this.pulling.dir, inc.bytes, false);
    this.link.send({ t: T.FCLIP_PASTE, id: inc.id });
  }

  // The copy being fetched is not wanted any more (a newer copy, gone, disconnected).
  _cleanPull() {
    if (!this.pulling) return;
    try { fs.rmSync(this.pulling.dir, { recursive: true, force: true }); } catch (_) { /* not there */ }
    this.pulling = null;
  }

  // Keep the cache small: folders older than an hour go, and all but the newest few.
  _sweep() {
    let dirs = [];
    try { dirs = fs.readdirSync(this.cacheDir).map((n) => path.join(this.cacheDir, n)).map((p) => ({ p, t: fs.statSync(p).mtimeMs })); } catch (_) { return; }
    dirs.sort((a, b) => b.t - a.t);
    dirs.forEach((d, i) => {
      if (this.pulling && d.p === this.pulling.dir) return;
      if (i >= CACHE_KEEP || Date.now() - d.t > CACHE_MAX_AGE_MS) try { fs.rmSync(d.p, { recursive: true, force: true }); } catch (_) { /* in use */ }
    });
  }

  // Files in the cache are ones we received: never announced again.
  isCache(paths) {
    const root = this.cacheDir + path.sep;
    return paths.some((p) => p.startsWith(root));
  }

  // The batch of a pulled copy landed: it becomes our clipboard unless a newer copy came meanwhile.
  async _pulled(b) {
    const pl = this.pulling;
    this.pulling = null;
    const ok = b.ok && Array.isArray(b.placed) && b.placed.length && await this.clip.applyFiles(b.placed, pl.id);
    if (!ok) try { fs.rmSync(pl.dir, { recursive: true, force: true }); } catch (_) { /* not there */ }
    this.onChange();
  }

  // The paste batch landed (filerecv.js onBatch).
  pasted(b) {
    if (this.pulling && b.batch === this.pulling.id) return this._pulled(b);
    this.pasting = null;
    this.popup('home', b.ok ? 'Pasted ' + plural(b.files, 'file') : 'Pasted ' + b.files + ' of ' + b.count + ' files');
    this.onChange();
  }

  // Settings changed: the helper watches the keys (kvmConfig, sent by kvm.applyConfig).
  apply() {
    this.onChange();
  }

  // While this computer drives the other one its key events pass through here (kvm.js) before
  // they're sent: our own copy/paste shortcut becomes `fclip.key`. Modifiers still go over as keys;
  // the shortcut's key and its release are used up. Returns true when the event was used up.
  intercept(e) {
    const MODS = { ControlLeft: 'Control', ControlRight: 'Control', AltLeft: 'Alt', AltRight: 'Alt', ShiftLeft: 'Shift', ShiftRight: 'Shift', MetaLeft: 'Super', MetaRight: 'Super' };
    if (e.t !== T.K_KEY_DOWN && e.t !== T.K_KEY_UP) return false;
    if (MODS[e.code]) {
      if (e.t === T.K_KEY_DOWN) this.held.add(e.code);
      else this.held.delete(e.code);
      return false;
    }
    if (e.t === T.K_KEY_UP) return this.eaten.delete(e.code);
    if (!this.cfg.shortcuts) return false;
    const mods = [...new Set([...this.held].map((c) => MODS[c]))].sort().join('+');
    const key = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : /^Digit\d$/.test(e.code) ? e.code.slice(5) : e.code;
    const match = (acc) => {
      const parts = String(acc || '').split('+');
      return parts.pop() === key && parts.sort().join('+') === mods;
    };
    const action = match(this.cfg.copyKeys) ? 'copy' : match(this.cfg.pasteKeys) ? 'paste' : '';
    if (!action) return false;
    this.eaten.add(e.code);
    this.link.send({ t: T.FCLIP_KEY, action });
    return true;
  }

  // Capture ended: nothing is held any more.
  resetKeys() {
    this.held.clear();
    this.eaten.clear();
  }

  // The files on the clipboard as the helper sees them (also with TwinDesk in the background on Wayland).
  async clipboardFiles() {
    const r = await this.helper.request('clipFiles').catch(() => null);
    return r ? filesIn(r.text).filter((p) => fs.existsSync(p)) : [];
  }

  // The files to copy: the file manager's selection (sent Ctrl+C), else what's on the clipboard.
  async _selection() {
    const win = await fm.front(this.helper);
    if (win && (win.fm || win.desktop)) { // desktop icons copy their selection too
      const before = (await this._clipboard()).join('\n');
      for (const [t, code] of [['k.kd', 'ControlLeft'], ['k.kd', 'KeyC'], ['k.ku', 'KeyC'], ['k.ku', 'ControlLeft']]) this.helper.send('inject', { ev: { t, code } });
      // The file manager answers within a moment; a selection identical to the old clipboard is fine too.
      for (let i = 0; i < 10; i++) {
        await sleep(80);
        const now = await this._clipboard();
        if (now.length && now.join('\n') !== before) return now;
      }
    }
    return this._clipboard();
  }

  // Files on the clipboard: through the helper (any session), else Electron's view of it.
  async _clipboard() {
    const r = await this.helper.request('clipFiles').catch(() => null);
    const list = r ? filesIn(r.text) : [];
    return list.length ? list : filesIn(electronClipboard());
  }

  async copy() {
    if (this.busy) return;
    if (!this.connected) return this.popup('home', 'Not connected');
    this.busy = true;
    let paths = [];
    try {
      paths = (await this._selection()).filter((p) => fs.existsSync(p));
    } finally {
      this.busy = false;
    }
    if (!paths.length) return this.popup('home', 'Select files in the file manager first');
    const plan = this.fileDrop.plan(paths);
    if (!plan || !plan.jobs.length) return this.popup('home', 'Nothing to copy there');
    this._announce(paths, plan, null);
    this.popup('away', 'Copied ' + (plan.items.length === 1 ? plan.items[0].name : plural(plan.items.length, 'item')) + ' for ' + this.peerName());
  }

  // Files copied normally (clip.js saw them on the clipboard at `stamp`): announce them, with
  // `eager` when they fit under `limit` bytes so the other computer fetches them at once.
  clipCopied(paths, stamp, limit) {
    if (!this.connected) return;
    const there = paths.filter((p) => fs.existsSync(p));
    const plan = there.length && this.fileDrop.plan(there);
    if (!plan || !plan.jobs.length) return;
    this._announce(there, plan, stamp, plan.bytes <= limit);
  }

  // fclip.offer for these files. stamp: when they were copied ({ts, o}), null = now (the shortcut);
  // eager: set only for the normal clipboard. The same files announced twice in a row (the shortcut
  // sends Ctrl+C, which clip.js sees too) are offered once, unless the second adds `eager`.
  _announce(paths, plan, stamp, eager) {
    const sig = paths.join('\n');
    const o = this.offer;
    if (o && o.sig === sig && Date.now() - o.at < 3000 && (o.eager || !eager)) return;
    if (o) this.link.send({ t: T.FCLIP_GONE, id: o.id }); // newest copy wins
    const files = plan.jobs.length;
    if (!stamp && this.clip) stamp = this.clip.latest.copied('files', sig);
    this.offer = { id: crypto.randomUUID(), paths, items: plan.items, files, bytes: plan.bytes, sig, at: Date.now(), eager: !!eager };
    // list/dirs: every file and folder, so a PC can paste it with Windows' own copy.
    this.link.send({
      t: T.FCLIP_OFFER, id: this.offer.id, items: plan.items, files, bytes: plan.bytes, list: plan.list, dirs: plan.dirs,
      ...(stamp ? { ts: stamp.ts, o: stamp.o } : {}), ...(typeof eager === 'boolean' ? { eager } : {}),
    });
    this.onChange();
  }

  async paste() {
    const inc = this.incoming;
    if (!this.connected) return this.popup('home', 'Not connected');
    if (!inc) return this.popup('home', 'Nothing copied on ' + this.peerName());
    if (this.pasting || (this.pulling && this.pulling.id === inc.id)) return;
    this.pasting = { id: inc.id, files: inc.files };
    const win = await fm.front(this.helper);
    const front = win && win.folder && fs.existsSync(win.folder) ? win.folder : '';
    this.fileRecv.expectBatch(inc.id, front || app.getPath('downloads'), inc.bytes, !front);
    this.link.send({ t: T.FCLIP_PASTE, id: inc.id });
    this.popup('driven', 'Pasting ' + plural(inc.files, 'file') + '…');
    this.onChange();
  }

  // The other side pasted: send our copied files (or say they're gone).
  _send(id) {
    const o = this.offer;
    const there = o && o.id === id ? o.paths.filter((p) => fs.existsSync(p)) : [];
    if (!there.length || !this.fileDrop.sendBatch(there, 'paste', id)) this.link.send({ t: T.FCLIP_GONE, id });
  }

  shutdown() {}

  view() {
    const why = !this.cfg.shortcuts ? '' : !this.helper.running ? 'Needs the mouse and keyboard helper (General)' : '';
    return {
      error: why,
      offer: this.offer && { files: this.offer.files, items: this.offer.items.length },
      incoming: this.incoming && { files: this.incoming.files, items: this.incoming.items.length, name: this.incoming.items.length === 1 ? this.incoming.items[0].name : '' },
      pasting: !!this.pasting,
    };
  }
}

// The clipboard as Electron sees it (when TwinDesk is in front on Wayland, or on X11).
function electronClipboard() {
  try {
    const formats = clipboard.availableFormats();
    for (const f of ['x-special/gnome-copied-files', 'text/uri-list']) {
      const text = formats.includes(f) ? clipboard.readBuffer(f).toString('utf8') : '';
      if (text) return text;
    }
    return clipboard.readText();
  } catch (_) { return ''; }
}

function plural(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = FileClip;
