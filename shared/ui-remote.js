// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// Remote tab (Mac, PC and Linux; with a phone): the phone's Remote page — a touchpad and keyboard,
// or a gamepad whose buttons press keys — moves this computer's pointer, clicks, scrolls and types
// (shared/phone-remote.js). Its switch at the top lets it, on until turned off; it's taken only
// while this computer's own mouse is at home (not on the phone or another computer: Cursor).
// Real gamepad: the gamepad page as a real controller here (an Xbox 360 controller on Windows, a
// uinput gamepad on Linux), its driver installed the first time it's turned on; the Mac says why
// it can't and points to the phone's As a Bluetooth gamepad.
'use strict';

(() => {
  const isMesh = typeof window !== 'undefined' && (!!window.SidebarModel || !!(typeof document !== 'undefined' && document.querySelector && document.querySelector('.mesh-pill')) || !!(typeof location !== 'undefined' && location.pathname && location.pathname.includes('/mesh/')));
  const isMac = (typeof process !== 'undefined' && process.platform === 'darwin') || (typeof navigator !== 'undefined' && navigator.platform && navigator.platform.includes('Mac'));

  UI.tab({
    id: 'remote',
    group: isMesh ? 'More' : 'Input',
    order: isMesh ? 77 : 28,
    title: 'Remote',
    icon: 'remote',
    color: 'linear-gradient(#bf5af2, #8944ab)',
    desc: 'Use the phone as this computer’s touchpad, keyboard or gamepad.',
    hidden: isMesh ? undefined : (s) => !UI.isPhone(s), // in one-to-one only while a phone is connected; in Mesh always visible in More
    badge: (s) => (s.remote && (s.remote.using || (s.remote.phones && s.remote.phones.some((p) => p.using))) ? 'on' : ''),
    master: {
      get: (s) => !!(s.remote && s.remote.allow),
      set: (v) => UI.api.setRemote({ allow: v }),
      disabled: (s) => !s.remote,
    },
    build(body) {
      if (!isMesh) {
        // One-to-one mode
        const status = UI.row('Now', '');
        const how = UI.row('On {name}', 'Open TwinDesk › Remote there, then Touchpad and keyboard or Gamepad. Its speed, tap to click and the gamepad’s keys are set there');
        const card = UI.card('{name} as a remote', [status, how]);
        const note = UI.note('warn', '');
        const padSwitch = UI.switch((v) => UI.api.setRemote({ pad: v }), { label: 'Real gamepad' });
        const padRow = UI.row('Real gamepad', '', [padSwitch]);
        const padNote = UI.note('info', '');
        const padCard = UI.card('Gamepad', [padRow, padNote]);
        body.append(note, card, padCard);
        return (s) => {
          const r = s.remote || {};
          const p = r.pad || {};
          padSwitch.set(p.on);
          padSwitch.disable(!p.supported || !!p.busy);
          padRow.setHint(!p.supported ? 'Not on this computer'
            : p.busy ? p.busy
              : !p.on ? 'Off: the gamepad page’s sticks and buttons press keys (WASD, the mouse), as set on {name}'
                : p.live ? `On: {name}’s gamepad page is a game controller here${p.name ? ` (${p.name})` : ''}`
                  : 'On: ready when {name} is connected');
          padNote.set(p.message || '');
          status.setHint(!r.allow ? 'Off: {name}’s Remote page can’t move or type here'
            : r.why ? r.why
              : r.using ? 'In use: {name} is moving the pointer or typing here'
                : r.opened ? '{name}’s Remote page is open and ready'
                  : 'Ready: open the Remote page on {name}');
          // On, but not taken now (the mouse is on another device).
          note.set(r.allow && r.why ? r.why : '');
        };
      }

      // Mesh mode: multi-phone aware
      const note = UI.note('warn', '');
      const phonesArea = UI.el('div', { class: 'remote-phones' });
      let padSwitch = null;
      let padRow = null;
      let padNote = UI.note('info', '');
      let padCard = null;

      // The Mac has no gamepad driver: say so and show no "Real gamepad" switch there.
      if (isMac) {
        padCard = UI.card('Gamepad', [padNote]);
      } else {
        padSwitch = UI.switch((v) => UI.api.setRemote({ pad: v }), { label: 'Real gamepad' });
        padRow = UI.row('Real gamepad', '', [padSwitch]);
        padCard = UI.card('Gamepad', [padRow, padNote]);
      }

      body.append(note, phonesArea, padCard);

      let lastKey = '';
      const phoneControls = new Map();

      return (s) => {
        const r = s.remote || {};
        const p = r.pad || {};

        // Gamepad card
        if (padSwitch && padRow) {
          padSwitch.set(p.on);
          padSwitch.disable(!p.supported || !!p.busy);
          padRow.setHint(!p.supported ? 'Not on this computer'
            : p.busy ? p.busy
              : !p.on ? 'Off: the gamepad page’s sticks and buttons press keys (WASD, the mouse)'
                : p.live ? `On: game controller ready${p.name ? ` (${p.name})` : ''}`
                  : 'On: ready when a phone is connected');
        }
        padNote.set(p.message || (isMac ? 'Real gamepad isn’t on the Mac. To use a phone as a gamepad, turn on Remote › As a Bluetooth gamepad on the phone, then pair it with this Mac in System Settings › Bluetooth' : ''));

        // Note when mouse is away
        note.set(r.allow && r.why ? r.why : '');

        // Phones list
        let phones = (r.phones && r.phones.length) ? r.phones
          : (s.phone && s.phone.phones && s.phone.phones.length) ? s.phone.phones.map((x, i) => ({
              id: x.id,
              name: x.name,
              label: `Android ${i + 1}`,
              opened: r.opened,
              using: r.using,
              slot: null,
            }))
          : [];

        const key = JSON.stringify(phones.map((x) => [x.id, x.name, x.label, x.opened, x.using, x.slot, r.allow, r.why]));
        if (key !== lastKey) {
          lastKey = key;
          if (!phones.length) {
            phoneControls.clear();
            const emptyCard = UI.card('Remote', [UI.row('No phones connected', 'Connect a phone to use it as a remote', [])]);
            phonesArea.replaceChildren(emptyCard);
          } else {
            const cards = phones.map((ph, idx) => {
              const androidLabel = ph.label || `Android ${idx + 1}`;
              let ctrl = phoneControls.get(ph.id);
              if (!ctrl) {
                const status = UI.row('Now', '');
                const how = UI.row(`On ${ph.name}`, 'Open TwinDesk › Remote there, then Touchpad and keyboard or Gamepad. Its speed, tap to click and the gamepad’s keys are set there');
                const rows = [status, how];
                let slotRow = null;
                if (!isMac && p.supported) {
                  slotRow = UI.row('Gamepad slot', '');
                  rows.push(slotRow);
                }
                const card = UI.card(`${androidLabel} as a remote`, rows);
                ctrl = { card, status, how, slotRow };
                phoneControls.set(ph.id, ctrl);
              }

              ctrl.how.label = `On ${ph.name}`;
              ctrl.status.setHint(!r.allow ? `Off: Remote is off on this computer`
                : r.why ? r.why
                  : ph.using ? `In use: ${ph.name} is moving the pointer or typing here`
                    : ph.opened ? `${ph.name}’s Remote page is open and ready`
                      : `Ready: open the Remote page on ${ph.name}`);

              if (ctrl.slotRow) {
                ctrl.slotRow.setHint(!p.on ? 'Off: the gamepad page’s sticks and buttons press keys'
                  : ph.slot ? `Player ${ph.slot} (${p.name || 'Game controller'})`
                    : 'Ready: open Gamepad on ' + ph.name);
              }

              return ctrl.card;
            });
            phonesArea.replaceChildren(...cards);
          }
        }
      };
    },
  });
})();
