// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Copy and paste files with the computer's shortcuts (mac/fclip.js):
//   The computer copied files (⌃⌥C): `fclip.offer` → a notification here, "Copy to clipboard" or
//   "Save to Downloads". Copy fetches them (`fclip.paste`, then a 'paste' batch) and puts them on
//   the clipboard as content: links, so they paste natively into any app that takes files; the
//   notification also offers Share. Save puts them in Download/TwinDesk.
//   Files copied normally (a file list on the clipboard, Clip.kt) go the same way, at once: the
//   offer carries the time of the copy, the other side asks for them (`fclip.paste`) when they are
//   no more than clipboard.filesMaxMB, and they land on its clipboard; bigger ones wait for its
//   paste shortcut. The latest copy wins (ClipSync.kt): an older offer is ignored.
//   The phone copies files ("Copy to computer" in the share sheet): our `fclip.offer`; when the
//   computer pastes (⌃⌥V), its `fclip.paste` asks for them and they go as a 'paste' batch.
package com.twindesk.android

import android.content.ClipData
import android.content.Intent
import android.net.Uri
import org.json.JSONObject
import java.io.File
import java.util.UUID

class FileClip(core: Core) : Feature(core) {
    data class Offer(val id: String, val names: List<String>, val files: Int, val bytes: Long, val at: Long)

    @Volatile var incoming: Offer? = null; private set // theirs
    @Volatile var ours: Pair<String, List<Files.Item>>? = null; private set // (id, items) copied here
    @Volatile var status = ""; private set
    @Volatile private var oursStamp: ClipSync.Stamp? = null

    private val clipDir get() = File(core.ctx.cacheDir, "clip")

    override fun onMessage(t: String, m: JSONObject): Boolean {
        when (t) {
            Proto.T.FCLIP_OFFER -> {
                val items = m.optJSONArray("items") ?: return true
                val names = (0 until minOf(items.length(), 1000)).map { items.getJSONObject(it).optString("name").take(200) }
                val o = Offer(m.optString("id"), names, m.optInt("files"), m.optLong("bytes"), System.currentTimeMillis())
                if (o.id.isEmpty()) return true
                if (!core.clip.accepts(m, "files", o.id)) return true // an older copy than the newest known
                retire()
                incoming = o
                val eager = m.optBoolean("eager", false) && core.sync.get("clipboard", "in") && core.store.flag("clipboard.files", true) && o.bytes <= core.clip.filesMaxBytes()
                if (eager) fetch(o.id, save = false, quiet = true)
                else Notify.fclipOffer(core.ctx, core.host?.name ?: "your computer", "${describe(o)} · ${size(o.bytes)}", o.id)
            }
            Proto.T.FCLIP_GONE -> {
                if (incoming?.id == m.optString("id")) {
                    incoming = null
                    Notify.cancelFclip(core.ctx)
                }
            }
            // The Mac's paste shortcut while its keyboard is on the phone: its copied files onto our clipboard.
            Proto.T.FCLIP_KEY -> {
                if (m.optString("action") == "paste") incoming?.let { fetch(it.id, save = false) }
            }
            Proto.T.FCLIP_PASTE -> {
                val (id, items) = ours ?: return true
                if (m.optString("id") != id) {
                    core.send(msg(Proto.T.FCLIP_GONE, "id" to m.optString("id")))
                    return true
                }
                core.files.send(items, "paste", id)
            }
            else -> return false
        }
        core.changed()
        return true
    }

    override fun onClosed() {
        if (incoming != null) Notify.cancelFclip(core.ctx)
        incoming = null
    }

    private fun describe(o: Offer) = if (o.names.size == 1) o.names[0] else "${o.names.size} items"

    // "Copy to clipboard" / "Save to Downloads" on the computer's copy.
    // quiet: the files were copied on the computer and come at once, with no notifications.
    fun fetch(id: String, save: Boolean, quiet: Boolean = false) {
        val o = incoming
        if (o == null || o.id != id || !core.link.connected) {
            if (!quiet) Notify.fclipReady(core.ctx, "Nothing to copy any more", "Copy the files again on your computer.", null)
            return
        }
        val from = core.host?.name ?: "your computer"
        if (save) {
            core.files.expect(id, Files.Target(true))
        } else {
            val dir = File(clipDir, id.filter { it.isLetterOrDigit() || it == '-' || it == '_' }.take(64).ifEmpty { "clip" })
            dir.mkdirs()
            core.clip.tidy(dir) // older copies go after an hour, the newest few stay
            core.files.expect(id, Files.Target(false, dir) { b -> onCopied(o, b, from, quiet) })
        }
        status = if (save) "Saving ${describe(o)}…" else "Copying ${describe(o)}…"
        core.send(msg(Proto.T.FCLIP_PASTE, "id" to id))
        if (!quiet) Notify.fclipProgress(core.ctx, "${if (save) "Saving" else "Copying"} ${describe(o)} from $from", -1)
        core.changed()
    }

    private fun onCopied(o: Offer, b: Files.Batch, from: String, quiet: Boolean) {
        if (quiet) Notify.cancelFclip(core.ctx)
        if (!b.ok || b.placed.isEmpty()) {
            status = "Copy failed"
            if (!quiet) Notify.fclipReady(core.ctx, "Couldn’t copy ${describe(o)}", "Not everything arrived from $from.", null)
            core.changed()
            return
        }
        if (quiet && !core.clip.latest.isCurrentId(o.id)) { // something newer was copied meanwhile
            status = ""
            if (incoming?.id == o.id) incoming = null
            core.changed()
            return
        }
        val cr = core.ctx.contentResolver
        // (the label tells Clip.kt this is not a copy made here: no echo back to the computer)
        val clip = ClipData.newUri(cr, Clip.IN_LABEL, b.placed[0].first)
        for ((uri, _) in b.placed.drop(1)) clip.addItem(cr, ClipData.Item(uri))
        core.clip.setIncoming(clip)
        status = "${describe(o)} copied"
        incoming = null
        if (quiet) return core.changed()
        val share = if (b.placed.size == 1) {
            Intent(Intent.ACTION_SEND).setType(b.placed[0].second ?: "*/*").putExtra(Intent.EXTRA_STREAM, b.placed[0].first)
        } else {
            Intent(Intent.ACTION_SEND_MULTIPLE).setType("*/*").putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList<Uri>(b.placed.map { it.first }))
        }.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        Notify.fclipReady(core.ctx, "${describe(o)} copied", "Paste it in any app, or share it.", share)
        core.changed()
    }

    // "Copy to computer" from the share sheet: the computer pastes with its shortcut.
    // stamp: the time of a copy Clip.kt noticed (files copied normally); none: copied just now.
    fun copy(items: List<Files.Item>, stamp: ClipSync.Stamp? = null): Boolean {
        if (!core.link.connected || items.isEmpty()) return false
        val id = UUID.randomUUID().toString()
        ours?.let { core.send(msg(Proto.T.FCLIP_GONE, "id" to it.first)) }
        val st = stamp ?: core.clip.latest.copied("files", id)
        ours = id to items
        oursStamp = st
        val bytes = items.sumOf { it.size }
        if (stamp != null) status = if (bytes > core.clip.filesMaxBytes()) "${size(bytes)}: paste on ${core.host?.name ?: "your computer"} with ⌃⌥V" else ""
        send(id, items, st, stamp != null && bytes <= core.clip.filesMaxBytes())
        core.changed()
        return true
    }

    // eager: copied files within clipboard.filesMaxMB; the other side asks for them at once.
    private fun send(id: String, items: List<Files.Item>, st: ClipSync.Stamp, eager: Boolean) {
        val arr = jsonArray(items.map { JSONObject().put("name", it.name).put("dir", false).put("size", it.size) })
        core.send(msg(Proto.T.FCLIP_OFFER, "id" to id, "items" to arr, "files" to items.size, "bytes" to items.sumOf { it.size }, "ts" to st.ts, "o" to st.o, "eager" to eager))
    }

    // The computer asked for our newest copy: the offer again, with its original time.
    fun reoffer(stamp: ClipSync.Stamp) {
        val (id, items) = ours ?: return
        if (oursStamp == stamp) send(id, items, stamp, items.sumOf { it.size } <= core.clip.filesMaxBytes())
    }

    // A newer copy (of anything) took the place of what we offered: nothing to paste any more.
    fun retire() {
        val (id, _) = ours ?: return
        ours = null
        core.send(msg(Proto.T.FCLIP_GONE, "id" to id))
    }

    companion object {
        fun size(n: Long) = when {
            n < 1024 -> "$n B"
            n < 1024 * 1024 -> "%.1f KB".format(n / 1024.0)
            n < 1024L * 1024 * 1024 -> "%.1f MB".format(n / 1048576.0)
            else -> "%.2f GB".format(n / 1073741824.0)
        }
    }
}
