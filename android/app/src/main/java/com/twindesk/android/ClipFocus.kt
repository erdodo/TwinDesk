// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Reading the phone's copies from the background. Android 10+ lets only the app that has input
// focus (or the keyboard) read the clipboard, so a copy made while TwinDesk is behind could only be
// sent once we were opened. With "Display over other apps" allowed (the same permission as the
// pointer overlay) we take the focus for a moment: a 1×1 px focusable overlay window is added, the
// clipboard is read as soon as the window has focus (or after a short wait), and the window is
// removed again. It never takes touches (FLAG_NOT_TOUCH_MODAL, one pixel in a corner), exists for
// well under a second, and one read runs at a time (copies in quick succession become one read).
// Some phone makers (MIUI / HyperOS, ColorOS, ...) refuse focus to overlays or block background
// windows; then the read gives nothing and the copy goes when TwinDesk is opened, as before.
package com.twindesk.android

import android.content.Context
import android.graphics.PixelFormat
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.WindowManager

class ClipFocus(
    private val ctx: Context,
    private val wanted: () -> Boolean, // is a background read worth it now (connected, sending on)?
    private val read: () -> Unit, // read the clipboard and send it; runs on the main thread, window up
) {
    private val main = Handler(Looper.getMainLooper())
    private val wm get() = ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    private var busy = false // main thread only
    private var again = false
    private val go = Runnable { start() }

    val allowed get() = Settings.canDrawOverlays(ctx)

    // A copy was made and could not be read: try to read it with a moment of focus.
    fun request() {
        main.removeCallbacks(go)
        main.postDelayed(go, DEBOUNCE_MS)
    }

    private fun start() {
        if (busy) { again = true; return }
        if (!allowed || MainActivity.shown || !wanted()) return // (in front, the normal path reads it)
        if (ctx.getSystemService(PowerManager::class.java)?.isInteractive == false) return
        busy = true
        again = false
        var view: View? = null
        var done = false
        lateinit var timeout: Runnable
        fun finish() {
            if (done) return
            done = true
            main.removeCallbacks(timeout)
            runCatching { read() } // (the window is still up here)
            view?.let { v -> runCatching { wm.removeView(v) } }
            view = null
            busy = false
            if (again) request()
        }
        timeout = Runnable { finish() } // no focus came: try the read anyway, then give up
        val v = object : View(ctx) {
            override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
                super.onWindowFocusChanged(hasWindowFocus)
                if (hasWindowFocus) main.postDelayed({ finish() }, SETTLE_MS)
            }
        }
        val lp = WindowManager.LayoutParams(
            1, 1, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL, // focusable, but touches outside it go through
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            title = "TwinDesk clipboard"
        }
        val added = runCatching { wm.addView(v, lp) }.isSuccess
        if (!added) {
            busy = false
            return
        }
        view = v
        main.postDelayed(timeout, TIMEOUT_MS)
    }

    companion object {
        const val DEBOUNCE_MS = 120L // copies in quick succession are one read
        const val SETTLE_MS = 60L // after the window got focus, before reading
        const val TIMEOUT_MS = 600L // without focus by then: read anyway, give up
    }
}
