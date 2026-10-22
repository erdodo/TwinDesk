// Tests for shared/clip-history.js. Run with: node shared/test/clip-history.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ClipHistory } = require('../clip-history.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cliphist-'));
const dir = path.join(tmp, 'kept');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1000, 7)]);
let t = 1000;
const h = new ClipHistory({ dir, max: 5, maxBytes: 1024 * 1024, now: () => t++ });

// text: newest first, same text moves up
h.add({ kind: 'text', dir: 'out', text: 'one' });
h.add({ kind: 'text', dir: 'in', text: 'two\nlines' });
h.add({ kind: 'text', dir: 'out', text: 'one' });
let l = h.list();
assert.deepStrictEqual(l.map((x) => x.title), ['one', 'two lines']);
assert.strictEqual(h.preview(l[1].id).text, 'two\nlines', 'preview has the whole text');
assert.deepStrictEqual(h.content(l[0].id), { kind: 'text', text: 'one' });

// image: kept as a file, listed with its size, copied again and previewed in full
const iid = h.add({ kind: 'image', dir: 'in', png: PNG, w: 640, h: 480 });
l = h.list();
assert.strictEqual(l[0].title, 'Image 640×480');
assert.ok(h.content(iid).png.equals(PNG), 'the image can be copied again');
assert.ok(h.preview(iid).image.startsWith('data:image/png;base64,'), 'preview carries the picture');

// files: the files themselves are kept (a copy), listed by name
const src = path.join(tmp, 'src');
fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
fs.writeFileSync(path.join(src, 'report.pdf'), 'pdfdata');
fs.writeFileSync(path.join(src, 'sub', 'a.txt'), 'aaa');
const fid = h.add({ kind: 'files', dir: 'out', files: [{ path: path.join(src, 'report.pdf') }, { path: path.join(src, 'sub') }] });
l = h.list();
assert.strictEqual(l[0].title, 'report.pdf +1 more');
assert.strictEqual(l[0].sub, '2 files');
fs.rmSync(src, { recursive: true }); // the originals are gone: the kept copy is still there
const c = h.content(fid);
assert.ok(c && c.paths.length === 2 && c.paths.every((p) => fs.existsSync(p)), 'kept files can be copied again after the originals are deleted');
assert.strictEqual(fs.readFileSync(path.join(c.paths[1], 'a.txt'), 'utf8'), 'aaa', 'folders are kept whole');
const pv = h.preview(fid);
assert.deepStrictEqual(pv.files.map((f) => f.name), ['report.pdf', 'sub']);
assert.strictEqual(pv.files[1].dir, true);

// limits: count and bytes, oldest first, folders removed from disk
for (let i = 0; i < 6; i++) h.add({ kind: 'text', dir: 'in', text: 'x' + i });
assert.strictEqual(h.list().length, 5, 'at most max items');
assert.ok(!fs.existsSync(path.join(dir, iid)), 'an evicted image is deleted from disk');
const big = new ClipHistory({ dir: path.join(tmp, 'big'), max: 10, maxBytes: 4100, now: () => t++ });
const a = big.add({ kind: 'image', dir: 'in', png: Buffer.concat([PNG]), w: 1, h: 1 });
for (let i = 0; i < 4; i++) big.add({ kind: 'image', dir: 'in', png: Buffer.concat([PNG, Buffer.from('b' + i)]), w: 1, h: 1 });
assert.strictEqual(big.get(a), null, 'over the byte budget the oldest kept image goes');
assert.ok(big.list().length >= 3, 'the newer ones stay');
const huge = big.add({ kind: 'image', dir: 'in', png: Buffer.alloc(2000, 9), w: 9, h: 9 });
assert.strictEqual(big.list()[0].kept, false, 'bigger than a quarter of the budget: listed, not kept');
assert.strictEqual(big.content(huge), null);
assert.strictEqual(big.preview(huge).image, '');

// off, remove, clear, wipe
assert.strictEqual(new ClipHistory({ dir, max: 0 }).add({ kind: 'text', dir: 'in', text: 'x' }), null, 'history off keeps nothing');
assert.strictEqual(h.remove(h.list()[0].id), true);
h.clear();
assert.strictEqual(h.list().length, 0);
h.add({ kind: 'image', dir: 'in', png: PNG });
h.wipe();
assert.ok(!fs.existsSync(dir) && h.list().length === 0, 'wipe removes everything from disk');
fs.rmSync(tmp, { recursive: true, force: true });
console.log('clip-history: passed');
