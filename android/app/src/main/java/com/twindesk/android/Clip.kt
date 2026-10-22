// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The clipboard both ways: text, images and files, and the latest copy wins (ClipSync.kt): every
// copy is stamped when we notice it and carries that time wherever it goes, an incoming item is
// applied only when it is newer than everything known here. The computer's copies land on the
// phone's clipboard at once (apps may write the clipboard from the background). Android lets only
// the app in front read it, so the phone's copies go over while TwinDesk is open, from the share
// sheet and the Quick Settings tile; with wireless debugging on (READ_CLIPBOARD_IN_BACKGROUND) the
// clipboard is read at once, the Mac also follows the phone's clipboard itself (scrcpy). A copy we
// cannot read yet is stamped when the clipboard changes (the listener always fires) and sent, with
// that time, as soon as we are in front, or at once when "Display over other apps" is allowed: then
// ClipFocus.kt takes the input focus for a moment (a 1 px overlay window) and reads it.
// The Recent list (ClipHistory.kt) keeps what went either way: text in memory, images and files in
// the cache folder (wiped when the app starts and by Clear), to copy again and to preview.
// Images are sent as PNG (clip.image) and come back as a cache file behind our FileProvider; files
// (a file list on the clipboard) go with fclip.offer, FileClip.kt moves them.
package com.twindesk.android

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Log
import android.util.LruCache
import androidx.core.content.FileProvider
import com.twindesk.android.ClipSync.Stamp
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.util.Base64
import java.util.concurrent.Executors

class Clip(core: Core) : Feature(core) {
    // What is on the clipboard, read: kind "text" | "image" | "files" (an image without png: not read, images are off).
    private class Content(
        val kind: String,
        val sig: String,
        val text: String? = null,
        val png: ByteArray? = null,
        val w: Int = 0,
        val h: Int = 0,
        val uris: List<Uri> = emptyList(),
        val sensitive: Boolean = false,
    )

    // The last copy made here, with its time (kept to answer clip.request with the original time).
    private class Own(val stamp: Stamp, val c: Content)

    private val cm get() = core.ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    private val io = Executors.newSingleThreadExecutor { r -> Thread(r, "td-clip").apply { isDaemon = true } }
    val latest = ClipSync.Latest(core.store.deviceId)
    @Volatile var peerAccepts = false; private set
    @Volatile var lastIn: String? = null; private set
    @Volatile var lastOut: String? = null; private set
    val hist = ClipHistory(File(core.ctx.cacheDir, "clip-history"), 20)
    private val thumbs = LruCache<String, Bitmap>(24)
    private val focus = ClipFocus(core.ctx, { core.link.connected && core.sync.get("clipboard", "out") && peerAccepts }) { sendCurrent(false) }

    private var own: Own? = null
    private var pending: Stamp? = null // copied, but not readable yet (we were not in front)
    private var lastSig: String? = null // of the clipboard as last read: the same again is no new copy
    @Volatile private var selfUntil = 0L // our own write to the clipboard is not a copy

    val clipDir get() = File(core.ctx.cacheDir, "clip")

    init {
        hist.wipe() // what an earlier run kept
        core.ctx.mainExecutor.execute {
            cm.addPrimaryClipChangedListener { noticed() }
        }
        io.execute { runCatching { clipDir.deleteRecursively() } } // what an earlier run left
    }

    // "Display over other apps" allowed: copies made while we are behind are read with a moment of focus.
    val overlayAllowed get() = focus.allowed

    // Wireless debugging granted the background clipboard read (adb pm grant ... READ_CLIPBOARD_IN_BACKGROUND).
    val backgroundGranted get() = core.ctx.checkSelfPermission("android.permission.READ_CLIPBOARD_IN_BACKGROUND") == PackageManager.PERMISSION_GRANTED

    // ---- the Recent list ----

    fun recent(): List<ClipHistory.Row> = hist.list()

    fun clearHistory() {
        hist.clear()
        thumbs.evictAll()
        core.changed()
    }

    // A small picture of a kept image (sampled while decoding), or null.
    fun thumbnail(id: String): Bitmap? {
        thumbs.get(id)?.let { return it }
        val f = (hist.content(id) as? ClipHistory.Content.Image)?.file ?: return null
        return decode(f, 160)?.also { thumbs.put(id, it) }
    }

    // Put an item of the list on the clipboard again: a new copy made now, it goes out like any copy.
    fun copyAgain(id: String) {
        io.execute { runCatching { copyHistory(id) }.onFailure { Log.w("TwinDesk", "clip copy again: ${it.message}") } }
    }

    @Synchronized private fun copyHistory(id: String) {
        val cr = core.ctx.contentResolver
        fun uri(f: File) = FileProvider.getUriForFile(core.ctx, "${core.ctx.packageName}.files", f)
        // (labelled as ours so the listener leaves it alone; the copy is stamped here, once)
        val (clip, c) = when (val h = hist.content(id) ?: return) {
            is ClipHistory.Content.Text ->
                ClipData.newPlainText(IN_LABEL, h.text) to Content("text", "t:${h.text}", text = h.text)
            is ClipHistory.Content.Image -> {
                val png = h.file.readBytes()
                ClipData.newUri(cr, IN_LABEL, uri(h.file)) to Content("image", "i:${png.size}:${Proto.sha256(png).hex().take(16)}", png = png, w = h.w, h = h.h)
            }
            is ClipHistory.Content.Files -> {
                val uris = h.paths.filter { it.isFile }.map { uri(it) }
                if (uris.isEmpty()) return
                val d = ClipData.newUri(cr, IN_LABEL, uris[0])
                for (u in uris.drop(1)) d.addItem(cr, ClipData.Item(u))
                d to Content("files", "u:" + uris.joinToString("|"), uris = uris)
            }
        }
        selfUntil = System.currentTimeMillis() + 2000
        cm.setPrimaryClip(clip)
        pending = null
        lastSig = c.sig
        val o = Own(latest.copied(c.kind), c)
        own = o
        if (c.kind != "files") core.fclip.retire()
        transmit(o, false)
        core.changed()
    }

    fun sendPolicy() {
        core.send(msg(Proto.T.CLIP_POLICY, "accept" to core.sync.get("clipboard", "in")))
    }

    override fun onWelcome(host: Host) {
        peerAccepts = false
        sendPolicy()
        latest.latest()?.let { core.send(msg(Proto.T.CLIP_LATEST, "ts" to it.ts, "o" to it.o, "kind" to it.kind)) }
    }

    override fun onClosed() {
        peerAccepts = false
    }

    fun filesMaxBytes(): Long = core.store.int("clipboard.filesMaxMB", 50).coerceIn(1, 4096) * 1024L * 1024L

    // ---- out ----

    // The clipboard changed (the listener fires in the background too). A copy is stamped now.
    private fun noticed() {
        val d = runCatching { cm.primaryClipDescription }.getOrNull()
        if (ours(d)) return
        val clip = readClip()
        io.execute { runCatching { local(clip, d) }.onFailure { Log.w("TwinDesk", "clip: ${it.message}") } }
    }

    // Our own write (an item from the computer): not a copy made here. Told by its label; when the
    // description is not readable, by the moment.
    private fun ours(d: ClipDescription?): Boolean =
        if (d != null) d.label?.toString() == IN_LABEL else System.currentTimeMillis() < selfUntil

    private fun readClip(): ClipData? = runCatching { cm.primaryClip?.takeIf { it.itemCount > 0 } }.getOrNull()

    private fun kindOf(d: ClipDescription?) = when {
        d == null -> "text"
        d.hasMimeType("image/*") -> "image"
        d.hasMimeType("text/*") -> "text"
        else -> "files"
    }

    @Synchronized private fun local(clip: ClipData?, d: ClipDescription?) {
        if (clip == null) {
            // Not readable now (not in front): stamp the copy now, read and send it when we are.
            pending = latest.copied(kindOf(d))
            own = null
            lastSig = null
            core.fclip.retire()
            focus.request()
            return
        }
        take(clip, false)
    }

    // What is on the clipboard now goes to the computer (works while we are in front, or from
    // the share sheet / tile, which bring us to the front for a moment). Unchanged since the last
    // time it was seen it is no new copy; force sends it again, with its original time.
    fun sendCurrent(force: Boolean): Boolean {
        val clip = readClip() ?: return false
        io.execute { runCatching { take(clip, force) }.onFailure { Log.w("TwinDesk", "clip: ${it.message}") } }
        return true
    }

    @Synchronized private fun take(clip: ClipData, force: Boolean) {
        val mine = clip.description?.label?.toString() == IN_LABEL
        if (mine && !force) return
        val c = content(clip) ?: return
        var o = own
        val fresh = c.sig != lastSig || o == null
        if (fresh) {
            val p = pending
            val st = if (!mine && p != null && latest.isCurrent(p)) p else latest.copied(c.kind)
            pending = null
            lastSig = c.sig
            o = Own(st, c)
            own = o
            if (c.kind != "files") core.fclip.retire()
        }
        if (fresh || force) transmit(o!!, force)
    }

    private fun content(clip: ClipData): Content? {
        if (clip.itemCount == 0) return null
        val sensitive = runCatching { clip.description.extras?.getBoolean("android.content.extra.IS_SENSITIVE") == true }.getOrDefault(false)
        val first = clip.getItemAt(0)
        val text = first.text?.toString()
        if (!text.isNullOrEmpty()) return Content("text", "t:$text", text = text, sensitive = sensitive)
        val uris = (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }.filter { it.scheme == "content" }
        if (uris.isEmpty()) {
            val t = runCatching { first.coerceToText(core.ctx)?.toString() }.getOrNull()
            return if (t.isNullOrEmpty()) null else Content("text", "t:$t", text = t, sensitive = sensitive)
        }
        val sig = "u:" + uris.joinToString("|")
        val image = uris.size == 1 && (clip.description.hasMimeType("image/*") || core.ctx.contentResolver.getType(uris[0])?.startsWith("image/") == true)
        if (image) {
            if (!core.store.flag("clipboard.images", true)) return Content("image", sig, sensitive = sensitive)
            val png = readPng(uris[0])
            if (png != null) return Content("image", "i:${png.first.size}:${Proto.sha256(png.first).hex().take(16)}", png = png.first, w = png.second, h = png.third, sensitive = sensitive)
        }
        return Content("files", sig, uris = uris, sensitive = sensitive)
    }

    // The picture as a PNG within the size limit (and its size), or null.
    private fun readPng(uri: Uri): Triple<ByteArray, Int, Int>? = runCatching {
        val bytes = core.ctx.contentResolver.openInputStream(uri)?.use { readCapped(it, 32 * 1024 * 1024) } ?: return@runCatching null
        val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, o)
        if (o.outWidth <= 0 || o.outHeight <= 0) return@runCatching null
        if (ClipSync.isPng(bytes)) {
            return@runCatching if (bytes.size > ClipSync.IMAGE_MAX_BYTES) null else Triple(bytes, o.outWidth, o.outHeight)
        }
        val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return@runCatching null
        val out = ByteArrayOutputStream()
        val ok = try { bmp.compress(Bitmap.CompressFormat.PNG, 100, out) } finally { bmp.recycle() }
        if (!ok || out.size() > ClipSync.IMAGE_MAX_BYTES) null else Triple(out.toByteArray(), o.outWidth, o.outHeight)
    }.getOrNull()

    private fun readCapped(s: InputStream, max: Int): ByteArray? {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(65536)
        while (true) {
            val n = s.read(buf)
            if (n < 0) break
            if (out.size() + n > max) return null
            out.write(buf, 0, n)
        }
        return out.toByteArray()
    }

    // Goes to the computer when it takes copies (force: whatever the switch says).
    private fun transmit(o: Own, force: Boolean): Boolean {
        val c = o.c
        if (!core.link.connected || c.sensitive) return false
        if (!force && !(core.sync.get("clipboard", "out") && peerAccepts)) return false
        return when (c.kind) {
            "text" -> sendTextMessage(c.text ?: return false, o.stamp)
            "image" -> sendImage(c, o.stamp)
            else -> sendFiles(c, o.stamp)
        }
    }

    private fun sendTextMessage(text: String, st: Stamp): Boolean {
        if (text.isEmpty() || text.toByteArray().size > Proto.CLIP_MAX_BYTES) return false
        lastOut = text
        hist.addText("out", text)
        core.send(msg(Proto.T.CLIP, "text" to text, "ts" to st.ts, "o" to st.o))
        core.changed()
        return true
    }

    private fun sendImage(c: Content, st: Stamp): Boolean {
        val png = c.png ?: return false
        if (!core.store.flag("clipboard.images", true) || png.size > ClipSync.IMAGE_MAX_BYTES) return false
        core.send(
            msg(
                Proto.T.CLIP_IMAGE, "id" to Proto.randomHex(8), "w" to c.w, "h" to c.h,
                "png" to Base64.getEncoder().encodeToString(png), "ts" to st.ts, "o" to st.o,
            ),
        )
        hist.addImage("out", png, c.w, c.h)
        core.changed()
        return true
    }

    // Files on the clipboard: the offer carries the time of the copy; the computer asks for them at
    // once when they are small enough for it (clipboard.filesMaxMB), else the person pastes there.
    private fun sendFiles(c: Content, st: Stamp): Boolean {
        if (!core.store.flag("clipboard.files", true)) return false
        val items = core.files.describe(c.uris)
        if (items.isEmpty()) return false
        val sent = core.fclip.copy(items, st)
        if (sent) recordFiles("out", items)
        return sent
    }

    // Files that went or came: kept in the Recent list (copied from where they are readable now).
    fun recordFiles(dir: String, items: List<Files.Item>) {
        val cr = core.ctx.contentResolver
        val src = items.map { i -> ClipHistory.Src(i.name, i.size) { runCatching { cr.openInputStream(i.uri) }.getOrNull() } }
        runCatching { hist.addFiles(dir, src) }.onFailure { Log.w("TwinDesk", "clip history: ${it.message}") }
        core.changed()
    }

    // The computer's files arrived and are on the clipboard.
    fun recordReceived(uris: List<Uri>) {
        io.execute { runCatching { recordFiles("in", core.files.describe(uris)) } }
    }

    // Text from outside the clipboard (the share sheet, a drop) or the clipboard's text again.
    @Synchronized fun sendText(text: String, force: Boolean = true): Boolean {
        if (!core.link.connected || text.isEmpty()) return false
        var o = own?.takeIf { it.c.text == text }
        if (o == null) {
            val p = pending?.takeIf { latest.isCurrent(it) }
            if (p != null) lastSig = "t:$text"
            pending = null
            o = Own(p ?: latest.copied("text"), Content("text", "t:$text", text = text))
            own = o
            core.fclip.retire()
        }
        return transmit(o, force)
    }

    // The computer asked for our newest copy (after clip.latest): it goes again with its original time.
    @Synchronized private fun answer() {
        if (!core.sync.get("clipboard", "out")) return
        val o = own ?: return
        if (!latest.isCurrent(o.stamp)) return
        if (o.c.kind == "files") core.fclip.reoffer(o.stamp) else transmit(o, true)
    }

    // ---- in ----

    // An incoming item is newer than everything known here (and becomes the newest copy)?
    fun accepts(m: JSONObject, kind: String, id: String? = null): Boolean =
        latest.accept(m.optLong("ts", 0), m.str("o", 129), m.str("from", 129).ifEmpty { null }, kind, id)

    // Put an item from the computer on the clipboard; it is not a copy made here.
    @Synchronized fun setIncoming(clip: ClipData) {
        selfUntil = System.currentTimeMillis() + 2000
        pending = null
        lastSig = null
        own = null
        cm.setPrimaryClip(clip)
    }

    // The computer's copy (text) here, as if copied on the phone.
    fun receiveText(text: String) {
        lastIn = text
        hist.addText("in", text)
        setIncoming(ClipData.newPlainText(IN_LABEL, text))
        core.fclip.retire()
        core.changed()
    }

    private fun receiveImage(m: JSONObject) {
        val img = ClipSync.readImage(m.str("id", 129), m.optInt("w"), m.optInt("h"), m.optString("png")) ?: return
        synchronized(this) {
            if (!accepts(m, "image", img.id)) return
            val f = File(clipDir, "img-${System.currentTimeMillis()}.png")
            f.parentFile?.mkdirs()
            f.writeBytes(img.png)
            val uri = FileProvider.getUriForFile(core.ctx, "${core.ctx.packageName}.files", f)
            setIncoming(ClipData.newUri(core.ctx.contentResolver, IN_LABEL, uri))
            hist.addImage("in", img.png, img.w, img.h)
            tidy(f)
        }
        core.fclip.retire()
        core.changed()
    }

    // Cache cleanup: what is older than an hour goes, the newest few stay (and `keep`).
    fun tidy(keep: File?) {
        val now = System.currentTimeMillis()
        (clipDir.listFiles() ?: return).sortedByDescending { it.lastModified() }.drop(3)
            .filter { it != keep && now - it.lastModified() > 3_600_000L }
            .forEach { runCatching { it.deleteRecursively() } }
    }

    override fun onMessage(t: String, m: JSONObject): Boolean {
        val receive = core.sync.get("clipboard", "in")
        when (t) {
            Proto.T.CLIP_POLICY -> peerAccepts = m.optBoolean("accept")
            Proto.T.CLIP -> {
                val text = m.optString("text")
                if (receive && text.isNotEmpty() && text.toByteArray().size <= Proto.CLIP_MAX_BYTES && accepts(m, "text")) receiveText(text)
            }
            Proto.T.CLIP_IMAGE -> if (receive && core.store.flag("clipboard.images", true)) io.execute { runCatching { receiveImage(m) }.onFailure { Log.w("TwinDesk", "clip image: ${it.message}") } }
            // The computer holds a newer copy than we know of: ask for it.
            Proto.T.CLIP_LATEST -> {
                val wanted = when (m.str("kind", 16)) {
                    "image" -> core.store.flag("clipboard.images", true)
                    "files" -> core.store.flag("clipboard.files", true)
                    else -> true
                }
                if (receive && wanted && latest.isNewer(m.optLong("ts", 0), m.str("o", 129))) core.send(msg(Proto.T.CLIP_REQUEST))
            }
            Proto.T.CLIP_REQUEST -> io.execute { runCatching { answer() } }
            else -> return false
        }
        core.changed()
        return true
    }

    companion object {
        // The label of what we put on the clipboard ourselves: the listener leaves it alone.
        const val IN_LABEL = "TwinDesk sync"

        // A picture file scaled down while decoding so that neither side is smaller than `px` (0.5 to 1x of it), or null.
        fun decode(f: File, px: Int): Bitmap? = runCatching {
            val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(f.path, o)
            if (o.outWidth <= 0 || o.outHeight <= 0) return@runCatching null
            var s = 1
            while (o.outWidth / (s * 2) >= px && o.outHeight / (s * 2) >= px) s *= 2
            BitmapFactory.decodeFile(f.path, BitmapFactory.Options().apply { inSampleSize = s })
        }.getOrNull()
    }
}
