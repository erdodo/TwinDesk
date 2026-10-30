// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// Main-window actions (preload-app.js → here; copy of windows/mesh/ipc.js). Every value is validated by
// settings.apply().
const { app, ipcMain, dialog, shell, BrowserWindow, clipboard } = require('electron');
const path = require('path');
const P = require('../../shared/protocol.js');
const { receivedDir } = require('../../shared/received.js');
const { LINKS } = require('../../shared/about.js');
const { apply } = require('./settings');

// ctx: hub, link (the selected device's facade), discovery, screen, clip, kvm, terminal, fileDrop, smb, apps, phone, phoneViews, connectPhoneDev(d), settings, save(), push(), buildState(),
//      checkFirewall(), fixFirewall(), setStartup(on)
function setupIpc(ctx) {
  const { hub, link, discovery, screen, clip, kvm, layoutSync, terminal, sshd, fileDrop, smb, apps, sound, pcScreen, pcApps, peerApps, vdd, notifs, fileClip, wake, settings } = ctx;

  const handle = (name, fn) => ipcMain.handle(name, (_e, ...args) => fn(...args));
  const change = (section, partial, after) => {
    if (!apply(settings, section, partial)) return;
    ctx.save();
    if (after) after();
    ctx.push();
  };

  handle('getState', () => ctx.buildState());
  // Calls, Messages and Photos (shared/phonehub.js, loaded the first time it's used).
  handle('hub', (r) => ctx.phoneHub().act(r));

  const pairWith = (d) => {
    discovery.clearInvite(d.id);
    if (d.os === P.OS.ANDROID) return ctx.connectPhoneDev(d); // a phone has no server to pair with
    link.startPairing({ address: d.address, port: d.port, macName: d.name, id: d.id }); // id: one met over Bluetooth
  };
  handle('pair', (target) => {
    if (typeof target !== 'string' || !target.trim()) return;
    const found = discovery.get(target) || discovery.near(target);
    if (found) return pairWith(found);
    const m = /^\s*([^\s:]+)(?::(\d{1,5}))?\s*$/.exec(target);
    if (!m) return;
    const port = m[2] ? Number(m[2]) : P.PORT;
    if (port < 1 || port > 65535) return;
    link.startPairing({ address: m[1], port, macName: m[1] });
  });
  // Connect by address: ask who is there (unicast probe works where broadcast is blocked); no
  // answer in PROBE_REPLY_MS → try WSS on that address directly ("No TwinDesk at …" if nothing).
  handle('connectAddress', async (text) => {
    const m = typeof text === 'string' && /^\s*([^\s:]+)(?::(\d{1,5}))?\s*$/.exec(text);
    if (!m) return;
    const d = m[2] ? null : await discovery.ask(m[1]);
    if (d) return pairWith(d);
    const port = m[2] ? Number(m[2]) : P.PORT;
    if (port >= 1 && port <= 65535) link.startPairing({ address: m[1], port, macName: m[1] });
  });
  handle('refreshFound', () => discovery.refresh());
  handle('copyText', (text) => typeof text === 'string' && text.length < 1000 && clipboard.writeText(text));
  handle('confirmCode', () => link.confirmCode());
  handle('cancelPair', () => { ctx.cancelPhoneInvite(); link.cancelPair(); });
  handle('forget', () => {
    const id = hub.selectedId;
    link.forget();
    if (id) kvm.forgetDevice(id);
  });
  // Disconnect (either side of the session); Connect again / Take over the computer we're a guest of.
  handle('disconnect', () => link.disconnect());
  handle('connectAgain', () => link.connect(true));
  // Connect on a paired device in our list that connects to us: a phone is asked as usual, a
  // computer is invited and its hello takes the session over.
  handle('connectGuest', (id) => {
    if (typeof id !== 'string') return;
    const d = discovery.get(id) || discovery.near(id);
    if (!d) return;
    if (d.os === P.OS.ANDROID) return ctx.connectPhoneDev(d);
    discovery.invite(d.address);
  });
  handle('respondPair', (allow) => link.respondPair(allow === true)); // host: Allow / Deny
  handle('forgetGuest', (id) => typeof id === 'string' && link.forgetGuest(id));
  // Devices (docs/mesh.md): the selected one takes the one-to-one features; Forget drops one device.
  handle('setActivePeer', (id) => typeof id === 'string' && hub.select(id.slice(0, 64)));
  handle('forgetPeer', (id) => {
    if (typeof id !== 'string') return;
    hub.forgetPeer(id.slice(0, 64));
    kvm.forgetDevice(id.slice(0, 64));
  });
  handle('wakePeer', (id) => typeof id === 'string' && wake.wake(id));
  handle('setWake', (on) => wake.set(on === true)); // A switch
  handle('checkWake', () => wake.check());
  handle('openMonitor', () => screen.open(false));
  handle('remoteScreen', (arg) => arg && typeof arg === 'object' && screen.control({ share: arg.share, mode: arg.mode })); // screen.ctl

  handle('setKvm', (partial) => {
    if (partial && typeof partial.linked === 'boolean') kvm.setLinked(partial.linked); // home first, tells the other side
    if (partial && typeof partial.shared === 'boolean') kvm.setShared(partial.shared); // the Cursor tab's switch (Over Bluetooth through it)
    if (partial && typeof partial.locked === 'boolean') kvm.setLocked(partial.locked); // cursor lock: not a setting
    const { linked, edges, shared, locked, ...rest } = partial && typeof partial === 'object' ? partial : {}; // edges: setEdge only
    change('kvm', rest, () => kvm.applyConfig());
  });
  // Dev only (windows/test/dev/e2e-app.js, MACSHARE_DEV_PORT set): a helper event, as if the helper
  // had sent it (kvm.js gets it through the same listener). Without that variable there is no handler.
  if (process.env.MACSHARE_DEV_PORT) {
    handle('devHelperEvent', (name, msg) => kvm.helper.emit('event', String(name).slice(0, 40), msg && typeof msg === 'object' ? msg : {}));
  }
  // The shared layout (docs/mesh.md): device `id` goes to grid cell (x, y); a device there moves to
  // its old cell (swap). false when the arguments are not valid or the device is not in the mesh.
  handle('setLinkedFor', (id, on) => typeof id === 'string' && kvm.setLinkedFor(id.slice(0, 64), !!on));
  handle('setLayoutCell', (id, x, y) => {
    if (typeof id !== 'string' || !id || id.length > 64) return false;
    if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
    return layoutSync.place(id, x, y);
  });
  // A device off the map (its cell is removed from the shared layout). false when it has no cell.
  handle('removeFromLayout', (id) => {
    if (typeof id !== 'string' || !id || id.length > 64) return false;
    return layoutSync.remove(id);
  });
  handle('setKeys', (partial) => change('keys', partial, () => kvm.applyConfig())); // the hotkey lives in the helper
  handle('setApp', (partial) => change('app', partial, () => ctx.onApp && ctx.onApp()));
  handle('setUpdates', (partial) => change('updates', { auto: !!(partial && partial.auto), skipped: typeof (partial && partial.skipped) === 'string' ? partial.skipped : (settings.updates && settings.updates.skipped) || '' }, () => ctx.updates.start()));
  handle('skipUpdate', (version) => ctx.updates && ctx.updates.skip && ctx.updates.skip(version));
  handle('unskipUpdate', () => ctx.updates && ctx.updates.unskip && ctx.updates.unskip());
  handle('checkUpdates', () => ctx.updates.check(true));
  handle('openUpdate', () => ctx.updates.open());
  handle('openLink', (key) => (key === 'logs' ? require('../../shared/applog.js').open() : Object.hasOwn(LINKS, key) && shell.openExternal(LINKS[key]))); // About page: only its own links, and the log folder
  handle('setMonitor', (partial) => change('monitor', partial, () => screen.applyAudio()));
  handle('setClipboard', (partial) => change('clipboard', partial, () => clip.applySettings()));
  handle('copyHistory', (index) => clip.copyHistory(Number(index)));
  handle('clearHistory', () => clip.clearHistory());
  handle('setTab', (tab) => change('ui', { tab })); // invalid names fall back in normalize()
  handle('setMulti', (on) => require('../multi').set(on === true)); // Multi-device off: TwinDesk restarts one to one
  handle('setAudio', (partial) => change('audio', partial, () => sound.apply()));
  handle('setTerminal', (partial) => {
    const p = partial && typeof partial === 'object' ? { enabled: partial.enabled, allowMac: partial.allowMac } : {};
    Object.keys(p).forEach((k) => p[k] === undefined && delete p[k]);
    change('terminal', p, () => { terminal.apply(); sshd.apply(); });
  });
  handle('setupSshd', () => sshd.setup());
  handle('openTerminal', () => terminal.open());
  // Apps: a Mac sends its own (apps.js, through its screen stream); a PC or Linux computer through peerapps.js.
  const macPeer = () => link.peerOs === P.OS.MAC;
  handle('listApps', () => (macPeer() ? apps.refresh() : peerApps.refresh()));
  handle('launchApp', (id) => { if (!macPeer()) peerApps.launch(id); else { apps.launch(id); screen.ensureHidden(); } });
  handle('pinApp', (id) => typeof id === 'string' && macPeer() && apps.pin(id, true)); // a launcher in the app menu
  handle('setMacApps', (partial) => change('macApps', partial, () => peerApps.apply()));
  handle('setPcApps', (partial) => change('pcApps', partial, () => { pcApps.apply(); pcApps.input.release(); }));
  handle('setFiles', (partial) => {
    // shareOn/shareFolder only change through share()/unshare()
    const p = partial && typeof partial === 'object' ? { dropToMac: partial.dropToMac, mountMac: partial.mountMac, acceptFromMac: partial.acceptFromMac, edgeDrag: partial.edgeDrag,
      shortcuts: partial.shortcuts, copyKeys: partial.copyKeys, pasteKeys: partial.pasteKeys } : {};
    Object.keys(p).forEach((k) => p[k] === undefined && delete p[k]);
    change('files', p, () => { smb.applyMount(); kvm.applyConfig(); fileClip.apply(); });
  });
  // General › Received files (shared/received.js): chosen here only, never by the page itself.
  handle('chooseReceivedFolder', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const r = await dialog.showOpenDialog(win, { title: 'Folder for received files', buttonLabel: 'Use this folder',
      defaultPath: receivedDir(settings, app.getPath('downloads')), properties: ['openDirectory', 'createDirectory'] });
    if (!r.canceled && r.filePaths[0]) change('files', { receivedFolder: r.filePaths[0] });
  });
  handle('resetReceivedFolder', () => change('files', { receivedFolder: '' }));
  handle('openReceivedFolder', () => shell.openPath(receivedDir(settings, app.getPath('downloads'))));
  handle('setShareOn', (on) => smb.setShareOn(on === true));
  handle('chooseShareFolder', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const r = await dialog.showOpenDialog(win, { title: 'Folder to share with the other computer', properties: ['openDirectory', 'createDirectory'] });
    if (!r.canceled && r.filePaths[0]) await smb.chooseFolder(r.filePaths[0]);
  });
  handle('removeShare', () => smb.unshare());
  handle('openMacDrive', () => (smb.mounted ? smb.open() : smb.openOverWifi && smb.openOverWifi())); // through Bluetooth: Wi-Fi Direct first
  // Send files (paths from the drop zone or Choose…), notifications.
  const sendFiles = (paths) => {
    const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && path.isAbsolute(p)).slice(0, 1000);
    if (list.length) fileDrop.sendBatch(list, 'send');
  };
  handle('sendFiles', sendFiles);
  handle('chooseSendFiles', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const r = await dialog.showOpenDialog(win, { title: 'Send files', buttonLabel: 'Send', properties: ['openFile', 'multiSelections'] });
    if (!r.canceled) sendFiles(r.filePaths);
  });
  handle('setNotifs', (partial) => {
    const p = partial && typeof partial === 'object' ? { send: partial.send, receive: partial.receive, hideText: partial.hideText } : {};
    Object.keys(p).forEach((k) => p[k] === undefined && delete p[k]);
    change('notifs', p, () => notifs.applySettings());
  });
  handle('muteNotifApp', (arg) => arg && typeof arg.app === 'string' && notifs.setMuted(arg.app.slice(0, 300), arg.muted === true));
  handle('cancelDrop', () => fileDrop.cancel());
  handle('setPcScreen', (partial) => {
    const size = settings.pcScreen.extendSize;
    change('pcScreen', partial, () => { pcScreen.applyInput(); if (!settings.pcScreen.input) pcApps.input.release(); if (settings.pcScreen.extendSize !== size) pcScreen.sizeExtend(); else pcScreen.apply(); });
  });
  handle('setPcScreenMode', (mode) => pcScreen.setMode(mode));
  // Share screen to one target: { mode: 'off'|'mirror'|'extend', displayId? } for device `id` (screen-mesh stream table).
  handle('setPcScreenTarget', (id, choice) => typeof id === 'string' && choice && typeof choice === 'object' ? pcScreen.setTarget(id, choice) : undefined);
  // A phone as the peer (phone.js, phone-bridge.js, phoneview.js; there once our server runs)
  const phone = (name, fn) => handle(name, (...args) => (ctx.phone ? fn(...args) : undefined));
  phone('connectPhone', (id) => ctx.phone.connect(String(id)));
  phone('disconnectPhone', () => ctx.phone.disconnect());
  handle('setPhone', (partial) => change('phone', partial, () => partial && 'input' in partial && ctx.phone && ctx.phone.bridge.tellVia()));
  // The phone as a drive (phonedrive.js). The Mount page's switch: off unmounts and stops
  // everything (nothing runs until Mount anyway).
  phone('phoneMount', () => settings.mount.on && ctx.phoneDrive.mount());
  phone('phoneUnmount', () => ctx.phoneDrive.unmount());
  handle('setMount', (partial) => change('mount', partial, () => !settings.mount.on && ctx.phoneDrive && ctx.phoneDrive.stop()));
  phone('phonePair', (arg) => arg && typeof arg === 'object' && ctx.phone.bridge.pair(arg.code, arg.where));
  phone('phoneScreen', (open) => {
    if (open === false) {
      for (const v of ctx.phoneViews.list()) if (v.kind === 'screen') ctx.phoneViews.close(v.id);
    } else ctx.phoneViews.openScreen();
  });
  phone('phoneCamera', (open, opts) => {
    if (open !== false && ctx.setCamera && (!ctx.settings.camera || !ctx.settings.camera.on)) ctx.setCamera(true);
    const pv = (opts && opts.id && ctx.phone && ctx.phone.unit(opts.id) && ctx.phone.unit(opts.id).views) || ctx.phoneViews;
    if (!pv) return;
    if (open === false) {
      for (const v of pv.list()) if (v.kind === 'camera') pv.close(v.id);
    } else pv.openCamera(opts);
  });
  phone('phoneListCameras', (opts) => {
    const b = (opts && opts.id && ctx.phone && ctx.phone.unit(opts.id) && ctx.phone.unit(opts.id).bridge) || (ctx.phone && ctx.phone.bridge);
    return b ? b.listCameras() : [];
  });
  handle('camera', (m) => {
    if (m && m.do === 'on') return ctx.setCamera(m.on === true);
    if (!m || typeof m !== 'object') return;
    if (m.do === 'virtual' && ctx.vcam) ctx.vcam.setOn(m.on === true);
    else if (m.do === 'vcamRemove' && ctx.vcam) ctx.vcam.remove();
    else if (m.do === 'vcamTarget' && ctx.vcam) ctx.vcam.setTarget(m.target);
    else if (m.do === 'rotate' && ctx.vcam) ctx.vcam.turn();
    else if (m.do === 'activeSource' && ctx.vcam) {
      if (m.wc) ctx.vcam.setActiveSource(m.wc);
      else if (m.viewId && ctx.phone) {
        for (const u of ctx.phone.all) {
          const v = u.views && u.views.views.get(Number(m.viewId));
          if (v && v.win && !v.win.isDestroyed()) { ctx.vcam.setActiveSource(v.win.webContents); break; }
        }
      } else if (m.phoneId && ctx.phone) {
        const u = ctx.phone.unit(m.phoneId);
        if (u && u.views) {
          const v = [...u.views.views.values()].find((x) => x.kind === 'camera' && !x.ending);
          if (v && v.win && !v.win.isDestroyed()) ctx.vcam.setActiveSource(v.win.webContents);
        }
      } else if (ctx.phoneViews) {
        const v = [...ctx.phoneViews.views.values()].find((x) => x.kind === 'camera' && !x.ending);
        if (v && v.win && !v.win.isDestroyed()) ctx.vcam.setActiveSource(v.win.webContents);
      }
    } else if (m.do === 'slot' && ctx.vcam) {
      let wc = m.wc;
      if (!wc && m.viewId && ctx.phone) {
        for (const u of ctx.phone.all) {
          const v = u.views && u.views.views.get(Number(m.viewId));
          if (v && v.win && !v.win.isDestroyed()) { wc = v.win.webContents; break; }
        }
      } else if (!wc && m.phoneId && ctx.phone) {
        const u = ctx.phone.unit(m.phoneId);
        if (u && u.views) {
          const v = [...u.views.views.values()].find((x) => x.kind === 'camera' && !x.ending);
          if (v && v.win && !v.win.isDestroyed()) wc = v.win.webContents;
        }
      }
      if (wc) ctx.vcam.setSlot(wc, m.slot);
      if (m.phoneId) ctx.vcam.setSlot(m.phoneId, m.slot);
    }
  });
  // Remote tab: the phone's Remote page here (shared/phone-remote.js).
  handle('setRemote', (m) => {
    if (!m || typeof m !== 'object') return;
    const r = ctx.phoneRemote;
    if ('allow' in m && !r && m.allow === true) {
      settings.remote = { ...(settings.remote || {}), allow: true };
      if (ctx.loadRemote) ctx.loadRemote();
    } else if ('allow' in m && r) {
      r.setAllow(m.allow === true);
    }
    if ('pad' in m && !r && m.pad === true) {
      settings.remote = { ...(settings.remote || {}), pad: true };
      if (ctx.loadRemote) ctx.loadRemote();
    } else if ('pad' in m && r) {
      r.setPad(m.pad === true);
    }
    ctx.save();
    ctx.push();
  });
  phone('phoneOpenApp', (arg) => arg && typeof arg.id === 'string' && ctx.phoneViews.openApp(arg.id.slice(0, 200), String(arg.name || '').slice(0, 100)));
  phone('phoneCloseView', (id) => (ctx.phone && ctx.phone.closeView ? ctx.phone.closeView(Number(id)) : ctx.phoneViews.close(Number(id))));
  phone('phoneRetry', (id) => { const u = typeof id === 'string' && id ? ctx.phone.unit(id.slice(0, 64)) : null; (u || ctx.phone).bridge._kick(); });
  phone('phoneInstallFull', () => ctx.phone.bridge.installFull());
  handle('phoneAssets', () => (ctx.phone ? ctx.phone.assetsView() : { wallpaper: '', apps: [] }));
  handle('skipSetup', () => change('setup', { skipped: ctx.buildState().setup.missing, done: true }));
  handle('checkFirewall', () => ctx.checkFirewall());
  handle('fixFirewall', () => ctx.fixFirewall());
  handle('fixInput', () => ctx.fixInput()); // Wayland: uinput rule + input group (L6)
  handle('installVdd', () => ctx.vdd.install()); // X11 Extend: the connector helper (vdd.js)
  handle('removeVdd', () => ctx.vdd.remove());
  handle('setStartup', (on) => ctx.setStartup(on === true));
  handle('quit', () => app.quit()); // General › Quit (some desktops have no tray)
  // Not on the same network: Bluetooth on/off, and giving up on moving to Wi-Fi (netlink.js).
  // Bluetooth with computers stays as the one-to-one app has it: with Multi-device on Linux, computers
  // connect over the network only (docs/multi-device.md), so the switch changes nothing here.
  handle('setNet', (partial) => {
    const { blePc, ...rest } = partial && typeof partial === 'object' ? partial : {};
    change('net', rest, () => ctx.applyNet());
  });
  handle('setMesh', (partial) => change('mesh', partial, () => ctx.applyMesh && ctx.applyMesh()));
  handle('netCancel', () => ctx.net && ctx.net.cancel());
  handle('wifiSetup', () => ctx.wifi && ctx.wifi.setup()); // Keep Wi-Fi while hosting: the password prompt (wifi.js)
  handle('netJoinHotspot', (arg) => ctx.joinHotspot(arg));
  handle('openBluetoothSettings', () => ctx.openBluetoothSettings());
  // Connect with Wi-Fi Direct (a session on Bluetooth), or back to Bluetooth (the link ends, whatever it was made for).
  // on = 'hotspot': Connect with hotspot (a phone's; the Overview asks for its name and password).
  handle('netWifi', (on) => {
    if (!ctx.net) return;
    if (on) return void ctx.net.need(on === 'hotspot' ? 'hotspot' : 'user');
    ctx.net.drop();
    if (ctx.pcScreen.mode !== 'off') ctx.pcScreen.setMode('off'); // Bluetooth can't carry the screen
  });

  // pairsync.js applies a value the other computer changed, with the same side effects.
  const AFTER = {
    clipboard: () => clip.applySettings(),
    monitor: () => screen.applyAudio(), // pacing (pair.sync 'pace')
    notifs: () => notifs.applySettings(),
    audio: () => sound.apply(),
    kvm: () => kvm.applyConfig(),
    pcApps: () => { pcApps.apply(); pcApps.input.release(); },
    macApps: () => peerApps.apply(),
    remote: () => ctx.loadRemote && ctx.loadRemote(),
  };
  return { set: (section, partial) => change(section, partial, AFTER[section]) };
}

module.exports = setupIpc;
