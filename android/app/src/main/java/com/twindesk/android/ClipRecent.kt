// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Recent card of the Clipboard page: each row has a picture or kind icon, a title, the
// direction and time, Preview (the whole data in a dialog) and Copy (put it back on the clipboard
// as a new copy). The data comes from Clip.hist (ClipHistory.kt).
package com.twindesk.android

import android.text.format.DateUtils
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

@Composable
fun ClipRecentCard(core: Core, name: String) {
    val rows = core.clip.recent().take(20)
    var preview by remember { mutableStateOf<String?>(null) }
    if (rows.isEmpty()) return
    MacCard("Recent") {
        Text(
            "Text stays in memory; images and files are kept in the app’s cache folder until you clear them or the app restarts.",
            color = pal.muted, fontSize = 12.5.sp, modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 4.dp),
        )
        rows.forEach { r -> RecentRow(core, name, r, onPreview = { preview = r.id }) }
        MacRow("Clear the list", "Also deletes the kept images and files") { Secondary("Clear") { core.clip.clearHistory() } }
    }
    preview?.let { id ->
        val p = core.clip.hist.preview(id)
        if (p == null) preview = null else ClipPreviewDialog(core, name, p) { preview = null }
    }
}

@Composable
private fun Secondary(label: String, onClick: () -> Unit) =
    androidx.compose.material3.OutlinedButton(onClick = onClick, shape = RoundedCornerShape(8.dp)) { Text(label, color = pal.text) }

private fun ago(at: Long): String = DateUtils.getRelativeTimeSpanString(at, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS).toString()

@Composable
private fun RecentRow(core: Core, name: String, r: ClipHistory.Row, onPreview: () -> Unit) {
    val thumb by produceState<ImageBitmap?>(null, r.id) {
        value = if (r.kind == "image" && r.kept) withContext(Dispatchers.IO) { core.clip.thumbnail(r.id)?.asImageBitmap() } else null
    }
    Box(Modifier.padding(start = 16.dp).fillMaxWidth().height(1.dp).background(pal.line))
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(44.dp).clip(RoundedCornerShape(8.dp)).background(pal.accentSoft), contentAlignment = Alignment.Center) {
            val t = thumb
            if (t != null) Image(t, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            else Icon(when (r.kind) { "image" -> Ico.photo; "files" -> Ico.files; else -> Ico.clipboard }, null, tint = pal.accent, modifier = Modifier.size(22.dp))
        }
        Column(Modifier.weight(1f).padding(start = 12.dp, end = 4.dp)) {
            Text(r.title, color = pal.text, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val extra = if (r.sub.isEmpty()) "" else " · ${r.sub}"
            Text((if (r.dir == "in") "From $name" else "To $name") + " · ${ago(r.at)}$extra", color = pal.muted, fontSize = 12.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        TextButton(onClick = onPreview) { Text("Preview", color = pal.accent) }
        TextButton(onClick = { core.clip.copyAgain(r.id) }, enabled = r.kept) { Text("Copy", color = if (r.kept) pal.accent else pal.faint) }
    }
}

// The whole data: scrollable selectable text, the full picture fit to the width, every file with its size.
@Composable
private fun ClipPreviewDialog(core: Core, name: String, p: ClipHistory.Preview, close: () -> Unit) {
    AlertDialog(
        onDismissRequest = close,
        containerColor = pal.card,
        title = { Text(p.row.title, color = pal.text, maxLines = 2, overflow = TextOverflow.Ellipsis) },
        text = {
            Column(Modifier.heightIn(max = 460.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("${FileClip.size(p.row.size)} · ${if (p.row.dir == "in") "from" else "to"} $name · ${ago(p.row.at)}", color = pal.muted, fontSize = 12.5.sp)
                when (p.row.kind) {
                    "text" -> SelectionContainer { Text(p.text, color = pal.text, fontSize = 14.sp) }
                    "image" -> {
                        val bmp by produceState<ImageBitmap?>(null, p.row.id) {
                            value = p.image?.let { f -> withContext(Dispatchers.IO) { Clip.decode(f, 1600)?.asImageBitmap() } }
                        }
                        val b = bmp
                        if (b != null) Image(b, null, contentScale = ContentScale.FillWidth, modifier = Modifier.fillMaxWidth())
                        else Text(if (p.image == null) "This picture is not kept (too big)." else "Loading…", color = pal.muted)
                    }
                    else -> {
                        p.files.forEach { f ->
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text(f.name, color = pal.text, fontSize = 14.sp, modifier = Modifier.weight(1f))
                                Text(if (f.isDir) "folder" else FileClip.size(f.size), color = pal.muted, fontSize = 13.sp, fontWeight = FontWeight.Normal)
                            }
                        }
                        if (p.more > 0) Text("… and ${p.more} more", color = pal.muted)
                        if (!p.row.kept) Text("Only the names are kept: this cannot be copied again.", color = pal.muted)
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = { core.clip.copyAgain(p.row.id); close() }, enabled = p.row.kept) { Text("Copy", color = if (p.row.kept) pal.accent else pal.faint) } },
        dismissButton = { TextButton(onClick = close) { Text("Close", color = pal.muted) } },
    )
}
