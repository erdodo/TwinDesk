// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The system clipboard for clip.js: what is on it (probe) and putting text, an image or a list of
// files on it. Text and images go through Electron; a file list is text/uri-list or GNOME's
// x-special/gnome-copied-files, which Electron cannot offer together with anything else, so it is
// written with wl-copy (Wayland) or xclip (X11), else Electron's own writeBuffer (X11 only).
'use strict';
const { clipboard, nativeImage } = require('electron');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const { pathToFileURL, fileURLToPath } = require('url');

const FILE_FORMATS = ['x-special/gnome-copied-files', 'text/uri-list'];

// Newer Electron returns a Promise from clipboard.readText() in main; await works for both.
const readText = async () => String((await clipboard.readText()) || '');

const sha = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

// text/uri-list (most file managers), GNOME's x-special/gnome-copied-files ("copy" or "cut", then
// one URI a line), or file:// lines as text → paths.
function filesIn(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const l = line.trim();
    if (!l.startsWith('file://')) continue;
    try { out.push(fileURLToPath(l)); } catch (_) { /* not a file URI */ }
  }
  return out.slice(0, 1000);
}

// What is on the clipboard now: {kind: 'text'|'image'|'files'|'none', key, text?, png?, paths?}.
// key tells two states apart (text itself, the PNG's hash, the list of paths). Files win over text
// (a file manager puts the names there too), text wins over an image (a page or a table copies both).
async function probe() {
  let formats = [];
  try { formats = clipboard.availableFormats(); } catch (_) { /* no clipboard */ }
  for (const f of FILE_FORMATS) {
    if (!formats.includes(f)) continue;
    let paths = [];
    try { paths = filesIn(clipboard.readBuffer(f).toString('utf8')); } catch (_) { /* gone meanwhile */ }
    if (paths.length) return { kind: 'files', key: 'f:' + paths.join('\n'), paths };
  }
  const text = await readText();
  if (text.trim()) return { kind: 'text', key: 't:' + text, text };
  let png = null;
  try {
    if (formats.includes('image/png')) png = clipboard.readBuffer('image/png');
    else if (formats.some((f) => f.startsWith('image/'))) png = clipboard.readImage().toPNG();
  } catch (_) { /* gone meanwhile */ }
  if (png && png.length) return { kind: 'image', key: 'i:' + sha(png), png };
  return text ? { kind: 'text', key: 't:' + text, text } : { kind: 'none', key: '', formats };
}

function writeText(text) {
  clipboard.writeText(text);
}

function writeImage(png) {
  const img = nativeImage.createFromBuffer(png);
  if (img.isEmpty()) return false;
  clipboard.writeImage(img);
  return true;
}

function imageSize(png) {
  try { return nativeImage.createFromBuffer(png).getSize(); } catch (_) { return { width: 0, height: 0 }; }
}

// ---- file lists ----

const has = (cmd) => {
  try { return spawnSync('sh', ['-c', 'command -v ' + cmd], { stdio: 'ignore' }).status === 0; } catch (_) { return false; }
};
let tool; // {cmd, kind: 'wl' | 'x' | 'electron'} | null, found once

// How a file list can be put on the clipboard here; null = it cannot.
function writer() {
  if (tool !== undefined) return tool;
  const wayland = !!process.env.WAYLAND_DISPLAY;
  if (wayland && has('wl-copy')) tool = { cmd: 'wl-copy', kind: 'wl' };
  else if (process.env.DISPLAY && has('xclip')) tool = { cmd: 'xclip', kind: 'x' };
  else if (!wayland) tool = { cmd: '', kind: 'electron' }; // X11 session without xclip
  else tool = null;
  return tool;
}

// Said on the Clipboard page when received files cannot be put on the clipboard.
function missingTool() {
  return writer() ? '' : 'Pasting files from the other computer needs wl-clipboard (wl-copy) or xclip';
}

const KDE = /KDE|LXQt|Razor/i;
function fileMime() {
  return KDE.test(process.env.XDG_CURRENT_DESKTOP || '') ? 'text/uri-list' : 'x-special/gnome-copied-files';
}

function fileData(paths, mime) {
  const uris = paths.map((p) => pathToFileURL(p).href);
  return mime === 'text/uri-list' ? uris.join('\r\n') + '\r\n' : 'copy\n' + uris.join('\n');
}

// Puts the files on the clipboard as a copy. Resolves true when it worked.
function writeFiles(paths) {
  const w = writer();
  if (!w || !paths.length) return Promise.resolve(false);
  const mime = fileMime();
  const data = fileData(paths, mime);
  if (w.kind === 'electron') {
    try { clipboard.writeBuffer(mime, Buffer.from(data)); return Promise.resolve(true); } catch (_) { return Promise.resolve(false); }
  }
  const args = w.kind === 'wl' ? ['--type', mime] : ['-selection', 'clipboard', '-t', mime, '-i'];
  return new Promise((resolve) => {
    let done = false;
    const end = (ok) => { if (!done) { done = true; clearTimeout(timer); resolve(ok); } };
    const p = spawn(w.cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => { try { p.kill(); } catch (_) { /* gone */ } end(false); }, 4000);
    p.on('error', () => end(false));
    p.on('close', (code) => end(code === 0)); // the tool forks into the background to own the clipboard and exits
    p.stdin.on('error', () => {});
    p.stdin.end(data);
  });
}

module.exports = { probe, readText, filesIn, writeText, writeImage, imageSize, writeFiles, missingTool, fileData, sha };
