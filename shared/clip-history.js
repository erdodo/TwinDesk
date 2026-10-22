// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Recent list of the clipboard: text, images and files, in both directions, each kept so it can
// be copied again and shown in full (the Preview button).
//  - text lives in memory only (as before),
//  - an image is kept as a PNG file, files as copies of the files, in `dir` (the app's own cache
//    folder). Kept data is limited by item count (`max`) and by total size (`maxBytes`), oldest
//    first, and wiped when the app starts (wipe()) and by Clear. A set bigger than a quarter of
//    `maxBytes`, or one that cannot be copied, keeps only its names (kept: false): it is listed and
//    previewed, but cannot be copied again.
// Pure model + file operations on `dir`; no clipboard, no sockets. Shared by Windows, Mac and Linux.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MB = 1024 * 1024;
const MAX_TREE_ENTRIES = 2000;
const PREVIEW_FILES = 500;
const PREVIEW_IMAGE_BYTES = 8 * MB;

const sha = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const safeName = (n) => String(n || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 200) || 'file';

// Copy a file or folder into `to`, refusing to go over `budget` bytes or MAX_TREE_ENTRIES entries.
// Returns the bytes copied, or -1 when it did not fit (the partial copy is removed by the caller).
function copyTree(from, to, state) {
  const st = fs.statSync(from);
  if (++state.entries > MAX_TREE_ENTRIES) return -1;
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    let total = 0;
    for (const n of fs.readdirSync(from)) {
      const c = copyTree(path.join(from, n), path.join(to, safeName(n)), state);
      if (c < 0) return -1;
      total += c;
    }
    return total;
  }
  if (!st.isFile()) return 0;
  if (state.bytes + st.size > state.budget) return -1;
  state.bytes += st.size;
  fs.copyFileSync(from, to);
  return st.size;
}

class ClipHistory {
  // dir: where kept images/files go. max: items (0 = off). maxBytes: total of kept data.
  constructor({ dir, max = 20, maxBytes = 200 * MB, now = Date.now } = {}) {
    this.dir = dir;
    this.max = max;
    this.maxBytes = maxBytes;
    this.now = now;
    this.items = []; // newest first
    this.seq = 0;
  }

  setMax(n) {
    this.max = Math.max(0, n | 0);
    this._trim();
  }

  // A fresh start: nothing from an earlier run stays on disk.
  wipe() {
    this.items = [];
    if (this.dir) fs.rmSync(this.dir, { recursive: true, force: true });
  }

  // entry: {kind: 'text'|'image'|'files', dir: 'in'|'out', at?, text?, png?: Buffer, w?, h?,
  //         files?: [{name?, size?, path}]} -> the item id, or null (history off / nothing to keep).
  add(entry) {
    if (!this.max || !entry) return null;
    const at = entry.at || this.now();
    const id = `${at.toString(36)}-${(++this.seq).toString(36)}`;
    let item;
    if (entry.kind === 'text') {
      const text = String(entry.text || '');
      if (!text) return null;
      item = { id, kind: 'text', dir: entry.dir, at, text, size: Buffer.byteLength(text, 'utf8'), key: 't' + sha(text) };
    } else if (entry.kind === 'image') {
      if (!entry.png || !entry.png.length) return null;
      item = { id, kind: 'image', dir: entry.dir, at, w: entry.w | 0, h: entry.h | 0, size: entry.png.length, key: 'i' + sha(entry.png), kept: false, bytes: 0 };
      if (entry.png.length <= this.maxBytes / 4 && this.dir) {
        try {
          const d = path.join(this.dir, id);
          fs.mkdirSync(d, { recursive: true });
          fs.writeFileSync(path.join(d, 'image.png'), entry.png);
          item.kept = true;
          item.bytes = entry.png.length;
          item.file = path.join(d, 'image.png');
        } catch (_) { /* disk full or unwritable: the item is listed, not kept */ }
      }
    } else if (entry.kind === 'files') {
      const src = (entry.files || []).filter((f) => f && f.path);
      if (!src.length) return null;
      const files = src.map((f) => {
        let size = Number(f.size) || 0;
        let isDir = false;
        try { const st = fs.statSync(f.path); size = st.isFile() ? st.size : size; isDir = st.isDirectory(); } catch (_) { /* gone: name only */ }
        return { name: safeName(f.name || path.basename(f.path)), size, isDir, from: f.path, path: null };
      });
      const total = files.reduce((n, f) => n + f.size, 0);
      item = { id, kind: 'files', dir: entry.dir, at, files, size: total, key: 'f' + sha(files.map((f) => f.from + ':' + f.size).join('|')), kept: false, bytes: 0 };
      if (this.dir && total <= this.maxBytes / 4) this._keepFiles(item);
      for (const f of files) delete f.from;
    } else {
      return null;
    }
    // The same content again moves to the top instead of piling up.
    for (const old of this.items.filter((x) => x.key === item.key && x.dir === item.dir)) this._drop(old);
    this.items.unshift(item);
    this._trim();
    return id;
  }

  _keepFiles(item) {
    const root = path.join(this.dir, item.id);
    try {
      fs.mkdirSync(root, { recursive: true });
      const state = { entries: 0, bytes: 0, budget: this.maxBytes / 4 };
      const used = new Set();
      for (const f of item.files) {
        let name = f.name;
        for (let i = 2; used.has(name.toLowerCase()); i++) name = f.name.replace(/(\.[^.]*)?$/, ` (${i})$1`);
        used.add(name.toLowerCase());
        const to = path.join(root, name);
        if (copyTree(f.from, to, state) < 0) throw new Error('does not fit');
        f.path = to;
      }
      item.kept = true;
      item.bytes = state.bytes;
    } catch (_) {
      for (const f of item.files) f.path = null;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  _drop(item) {
    this.items = this.items.filter((x) => x !== item);
    if (this.dir && (item.kind === 'image' || item.kind === 'files')) fs.rmSync(path.join(this.dir, item.id), { recursive: true, force: true });
  }

  _trim() {
    while (this.items.length > this.max) this._drop(this.items[this.items.length - 1]);
    let bytes = this.items.reduce((n, x) => n + (x.bytes || 0), 0);
    for (let i = this.items.length - 1; i > 0 && bytes > this.maxBytes; i--) {
      const x = this.items[i];
      if (!x.bytes) continue;
      bytes -= x.bytes;
      this._drop(x); // index i stays valid: only older items are dropped, i counts down
    }
  }

  remove(id) {
    const x = this.items.find((i) => i.id === id);
    if (x) this._drop(x);
    return !!x;
  }

  clear() {
    for (const x of [...this.items]) this._drop(x);
  }

  // What the list shows (newest first); no content.
  list() {
    return this.items.map((x) => {
      let title;
      let sub;
      if (x.kind === 'text') {
        title = x.text.replace(/\s+/g, ' ').trim().slice(0, 160) || '(whitespace)';
        sub = '';
      } else if (x.kind === 'image') {
        title = x.w && x.h ? `Image ${x.w}×${x.h}` : 'Image';
        sub = x.kept ? '' : 'too big to keep';
      } else {
        const first = x.files[0].name;
        title = x.files.length === 1 ? first : `${first} +${x.files.length - 1} more`;
        sub = `${x.files.length} ${x.files.length === 1 ? 'file' : 'files'}${x.kept ? '' : ' · names only'}`;
      }
      return { id: x.id, kind: x.kind, dir: x.dir, at: x.at, size: x.size, title, sub, kept: x.kind === 'text' ? true : x.kept };
    });
  }

  get(id) {
    return this.items.find((x) => x.id === id) || null;
  }

  // The data to put back on the clipboard: {kind, text} | {kind, png: Buffer} | {kind, paths: []} | null.
  content(id) {
    const x = this.get(id);
    if (!x) return null;
    if (x.kind === 'text') return { kind: 'text', text: x.text };
    try {
      if (x.kind === 'image') return x.kept ? { kind: 'image', png: fs.readFileSync(x.file), w: x.w, h: x.h } : null;
      if (x.kept && x.files.every((f) => f.path && fs.existsSync(f.path))) return { kind: 'files', paths: x.files.map((f) => f.path) };
    } catch (_) { /* gone: cannot copy again */ }
    return null;
  }

  // Everything for the Preview window, plain JSON: the whole text, the image as a data URL, every
  // file name with its size.
  preview(id) {
    const x = this.get(id);
    if (!x) return null;
    const base = { id: x.id, kind: x.kind, dir: x.dir, at: x.at, size: x.size, kept: x.kind === 'text' ? true : x.kept };
    if (x.kind === 'text') return { ...base, text: x.text };
    if (x.kind === 'image') {
      let url = '';
      try { if (x.kept && x.size <= PREVIEW_IMAGE_BYTES) url = 'data:image/png;base64,' + fs.readFileSync(x.file).toString('base64'); } catch (_) { /* gone */ }
      return { ...base, w: x.w, h: x.h, image: url };
    }
    return { ...base, files: x.files.slice(0, PREVIEW_FILES).map((f) => ({ name: f.name, size: f.size, dir: f.isDir })), more: Math.max(0, x.files.length - PREVIEW_FILES) };
  }
}

module.exports = { ClipHistory, copyTree, safeName };
