// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Recent list of the clipboard (shared/clip-history.js, ported; keep the two in step): text,
// images and files, in both directions, each kept so it can be copied again and shown in full.
//  - text lives in memory only,
//  - an image is kept as a PNG file, files as copies of the files, in `dir` (the app's own cache
//    folder). Kept data is limited by item count (`max`) and by total size (`maxBytes`), oldest
//    first, and wiped when the app starts (wipe()) and by clear(). A set bigger than a quarter of
//    `maxBytes`, or one that cannot be copied, keeps only its names (kept = false): it is listed and
//    previewed, but cannot be copied again.
// Pure model + file operations on `dir` (java.io only; ClipHistoryTest.kt runs it on the JVM).
package com.twindesk.android

import java.io.File
import java.io.InputStream
import java.security.MessageDigest

class ClipHistory(
    private val dir: File?,
    max: Int = 20,
    private val maxBytes: Long = 200L * MB,
    private val now: () -> Long = System::currentTimeMillis,
) {
    // A file to keep: a real file or folder (file), or anything that can be read (open: a content:// uri).
    class Src(val name: String?, val size: Long = 0, val file: File? = null, val open: (() -> InputStream?)? = null)

    // One name of a files item (the kept copy is `path`, null when only the name is known).
    class Entry(val name: String, val size: Long, val isDir: Boolean, var path: File?)

    class Item(val id: String, val kind: String, val dir: String, val at: Long, val key: String) {
        var text: String = ""
        var w = 0
        var h = 0
        var size = 0L
        var kept = false
        var bytes = 0L
        var file: File? = null // an image's PNG
        var files: List<Entry> = emptyList()
    }

    // What the list shows (newest first); no content.
    class Row(val id: String, val kind: String, val dir: String, val at: Long, val size: Long, val title: String, val sub: String, val kept: Boolean)

    // The data to put back on the clipboard.
    sealed class Content {
        class Text(val text: String) : Content()
        class Image(val file: File, val w: Int, val h: Int) : Content()
        class Files(val paths: List<File>) : Content()
    }

    // Everything for the Preview dialog: the whole text, the image file (null: too big or gone), every file with its size.
    class Preview(
        val row: Row,
        val text: String = "",
        val image: File? = null,
        val w: Int = 0,
        val h: Int = 0,
        val files: List<Entry> = emptyList(),
        val more: Int = 0,
    )

    @Volatile var max: Int = max.coerceAtLeast(0); private set
    private var items = ArrayList<Item>() // newest first
    private var seq = 0

    @Synchronized fun setMax(n: Int) {
        max = n.coerceAtLeast(0)
        trim()
    }

    // A fresh start: nothing from an earlier run stays on disk.
    @Synchronized fun wipe() {
        items = ArrayList()
        dir?.deleteRecursively()
    }

    @Synchronized fun addText(dir: String, text: String, at: Long = now()): String? {
        if (max == 0 || text.isEmpty()) return null
        val id = newId(at)
        val it = Item(id, "text", dir, at, "t" + sha(text.toByteArray()))
        it.text = text
        it.size = text.toByteArray().size.toLong()
        return put(it)
    }

    @Synchronized fun addImage(dir: String, png: ByteArray, w: Int, h: Int, at: Long = now()): String? {
        if (max == 0 || png.isEmpty()) return null
        val id = newId(at)
        val it = Item(id, "image", dir, at, "i" + sha(png))
        it.w = w.coerceAtLeast(0)
        it.h = h.coerceAtLeast(0)
        it.size = png.size.toLong()
        if (png.size <= maxBytes / 4 && this.dir != null) {
            try {
                val d = File(this.dir, id)
                d.mkdirs()
                val f = File(d, "image.png")
                f.writeBytes(png)
                it.kept = true
                it.bytes = png.size.toLong()
                it.file = f
            } catch (_: Exception) { // disk full or unwritable: listed, not kept
                File(this.dir, id).deleteRecursively()
            }
        }
        return put(it)
    }

    @Synchronized fun addFiles(dir: String, src: List<Src>, at: Long = now()): String? {
        if (max == 0 || src.isEmpty()) return null
        val id = newId(at)
        val entries = src.map { s ->
            val f = s.file
            val size = if (f != null && f.isFile) f.length() else s.size.coerceAtLeast(0)
            Entry(safeName(s.name ?: f?.name), size, f?.isDirectory == true, null)
        }
        val total = entries.sumOf { it.size }
        val it = Item(id, "files", dir, at, "f" + sha(src.indices.joinToString("|") { i -> "${src[i].file?.path ?: entries[i].name}:${entries[i].size}" }.toByteArray()))
        it.files = entries
        it.size = total
        if (this.dir != null && total <= maxBytes / 4) keepFiles(it, src)
        return put(it)
    }

    private fun newId(at: Long) = at.toString(36) + "-" + (++seq).toString(36)

    // The same content again moves to the top instead of piling up.
    private fun put(item: Item): String {
        for (old in items.filter { it.key == item.key && it.dir == item.dir }) drop(old)
        items.add(0, item)
        trim()
        return item.id
    }

    private class CopyState(val budget: Long) {
        var entries = 0
        var bytes = 0L
    }

    private fun keepFiles(item: Item, src: List<Src>) {
        val root = File(dir, item.id)
        try {
            root.mkdirs()
            val st = CopyState(maxBytes / 4)
            val used = HashSet<String>()
            val paths = ArrayList<File>()
            for ((i, e) in item.files.withIndex()) {
                var name = e.name
                var n = 2
                while (!used.add(name.lowercase())) name = numbered(e.name, n++)
                val to = File(root, name)
                val s = src[i]
                val ok = when {
                    s.file != null -> copyTree(s.file, to, st)
                    s.open != null -> copyStream(s.open, to, st)
                    else -> false
                }
                if (!ok) throw IllegalStateException("does not fit")
                paths.add(to)
            }
            for ((i, e) in item.files.withIndex()) e.path = paths[i]
            item.kept = true
            item.bytes = st.bytes
        } catch (_: Exception) {
            for (e in item.files) e.path = null
            root.deleteRecursively()
        }
    }

    private fun numbered(name: String, n: Int): String {
        val dot = name.lastIndexOf('.')
        return if (dot <= 0) "$name ($n)" else name.substring(0, dot) + " ($n)" + name.substring(dot)
    }

    private fun drop(item: Item) {
        items.remove(item)
        if (dir != null && (item.kind == "image" || item.kind == "files")) File(dir, item.id).deleteRecursively()
    }

    private fun trim() {
        while (items.size > max) drop(items[items.size - 1])
        var bytes = items.sumOf { it.bytes }
        var i = items.size - 1
        while (i > 0 && bytes > maxBytes) {
            val x = items[i]
            if (x.bytes != 0L) {
                bytes -= x.bytes
                drop(x) // index i stays valid: only older items are dropped, i counts down
            }
            i--
        }
    }

    @Synchronized fun remove(id: String): Boolean {
        val x = items.firstOrNull { it.id == id } ?: return false
        drop(x)
        return true
    }

    @Synchronized fun clear() {
        for (x in ArrayList(items)) drop(x)
        dir?.deleteRecursively() // (anything else left in the folder goes too)
    }

    @Synchronized fun list(): List<Row> = items.map { row(it) }

    private fun row(x: Item): Row {
        val title: String
        val sub: String
        when (x.kind) {
            "text" -> {
                title = x.text.replace(Regex("\\s+"), " ").trim().take(160).ifEmpty { "(whitespace)" }
                sub = ""
            }
            "image" -> {
                title = if (x.w > 0 && x.h > 0) "Image ${x.w}×${x.h}" else "Image"
                sub = if (x.kept) "" else "too big to keep"
            }
            else -> {
                val first = x.files[0].name
                title = if (x.files.size == 1) first else "$first +${x.files.size - 1} more"
                sub = "${x.files.size} ${if (x.files.size == 1) "file" else "files"}${if (x.kept) "" else " · names only"}"
            }
        }
        return Row(x.id, x.kind, x.dir, x.at, x.size, title, sub, x.kind == "text" || x.kept)
    }

    @Synchronized fun get(id: String): Item? = items.firstOrNull { it.id == id }

    // The data to put back on the clipboard, or null when it is not kept (or gone).
    @Synchronized fun content(id: String): Content? {
        val x = get(id) ?: return null
        return when (x.kind) {
            "text" -> Content.Text(x.text)
            "image" -> x.file?.takeIf { x.kept && it.isFile }?.let { Content.Image(it, x.w, x.h) }
            else -> {
                val paths = x.files.map { it.path }
                if (x.kept && paths.all { it != null && it.exists() }) Content.Files(paths.map { it!! }) else null
            }
        }
    }

    @Synchronized fun preview(id: String): Preview? {
        val x = get(id) ?: return null
        val r = row(x)
        return when (x.kind) {
            "text" -> Preview(r, text = x.text)
            "image" -> Preview(r, image = x.file?.takeIf { x.kept && it.isFile }, w = x.w, h = x.h)
            else -> Preview(r, files = x.files.take(PREVIEW_FILES), more = (x.files.size - PREVIEW_FILES).coerceAtLeast(0))
        }
    }

    companion object {
        const val MB = 1024L * 1024L
        const val MAX_TREE_ENTRIES = 2000
        const val PREVIEW_FILES = 500
        private val BAD_NAME = Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]")

        fun safeName(n: String?): String = (n ?: "file").replace(BAD_NAME, "_").take(200).ifEmpty { "file" }

        private fun sha(b: ByteArray): String =
            MessageDigest.getInstance("SHA-1").digest(b).joinToString("") { "%02x".format(it) }

        private fun copyTree(from: File, to: File, s: CopyState): Boolean {
            if (++s.entries > MAX_TREE_ENTRIES) return false
            if (from.isDirectory) {
                to.mkdirs()
                for (c in from.listFiles().orEmpty().sortedBy { it.name }) if (!copyTree(c, File(to, safeName(c.name)), s)) return false
                return true
            }
            if (!from.isFile) return true
            if (s.bytes + from.length() > s.budget) return false
            s.bytes += from.length()
            from.copyTo(to, overwrite = true)
            return true
        }

        private fun copyStream(open: () -> InputStream?, to: File, s: CopyState): Boolean {
            if (++s.entries > MAX_TREE_ENTRIES) return false
            val ins = open() ?: return false
            ins.use { i ->
                to.outputStream().use { o ->
                    val buf = ByteArray(65536)
                    while (true) {
                        val n = i.read(buf)
                        if (n < 0) break
                        if (s.bytes + n > s.budget) return false
                        s.bytes += n
                        o.write(buf, 0, n)
                    }
                }
            }
            return true
        }
    }
}
