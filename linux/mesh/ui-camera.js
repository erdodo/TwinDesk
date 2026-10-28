// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// Camera tab (Linux Mesh): each connected phone's camera in a row (start/stop, front/back, rotate,
// window, send to virtual camera slot) and the virtual camera ("TwinDesk Camera", shared/vcam.js).
'use strict';

(() => {
  let cur = null;
  const phoneFacing = new Map();

  const getPhones = (s) => (s && s.phone && s.phone.phones) || [];
  const running = (s) => getPhones(s).some((p) => p.camera && p.camera.on);

  UI.tab({
    id: 'camera',
    group: 'More',
    order: 75,
    title: 'Camera',
    icon: 'camera',
    color: 'linear-gradient(#bf5af2, #8944ab)',
    desc: 'The other device’s camera here, and as a camera other apps can pick.',
    badge: (s) => (running(s) ? 'on' : ''),
    master: {
      get: (s) => !!(s.camera && s.camera.on),
      set: (v) => UI.api.camera({ do: 'on', on: v }),
    },
    build(body) {
      const { api, el } = UI;
      const cam = (m) => api.camera(m);

      // Previews: per-phone preview tile for each running phone, or empty state
      const previewArea = el('div', { class: 'phone-cam-previews' });
      Object.assign(previewArea.style, { margin: '12px 14px' });

      const emptySaid = el('div');
      Object.assign(emptySaid.style, { position: 'absolute', inset: '0', display: 'grid', placeItems: 'center', textAlign: 'center', padding: '0 24px', color: '#a1a1a6' });
      const emptyBox = el('div', { class: 'phone-cam-preview empty' }, [emptySaid]);
      Object.assign(emptyBox.style, { position: 'relative', aspectRatio: '16 / 9', background: '#000', borderRadius: '8px', overflow: 'hidden' });

      const grid = el('div', { class: 'phone-cam-grid' });
      Object.assign(grid.style, {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
        gap: '12px',
      });
      grid.hidden = true;

      previewArea.append(emptyBox, grid);

      // Map phoneId -> { phoneId, wcId, box, img, caption, url }
      const tiles = new Map();

      function disposeTile(tile) {
        if (tile.url) {
          URL.revokeObjectURL(tile.url);
          tile.url = '';
        }
        tile.img.removeAttribute('src');
      }

      if (api.onCamPreview) {
        api.onCamPreview((buf, wcId) => {
          if (!cur || !running(cur)) return;
          let tile = null;
          if (wcId != null) {
            tile = [...tiles.values()].find((t) => t.wcId === wcId);
          }
          if (!tile && tiles.size === 1) {
            tile = tiles.values().next().value;
          }
          if (!tile) return;

          const next = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
          const prev = tile.url;
          tile.img.onload = () => {
            if (prev && prev !== next) URL.revokeObjectURL(prev);
          };
          tile.img.onerror = () => {
            URL.revokeObjectURL(next);
          };
          tile.url = next;
          tile.img.src = next;
        });
      }

      // Multi-phone camera rows
      const phoneRows = el('div', { class: 'phone-cam-rows' });
      const picCard = UI.card('', [previewArea, phoneRows]);

      // Which phone feeds the virtual camera (single-slot mode, Mac behavior)
      const sourceSelect = UI.select([], (phoneId) => cam({ do: 'activeSource', phoneId }));
      const sourceRow = UI.row('Camera source', 'Which phone feeds the virtual camera', [sourceSelect]);

      // Virtual camera card
      const virtual = UI.switch((v) => cam({ do: 'virtual', on: v }), { label: 'Virtual camera' });
      const vRemove = UI.button('Remove', () => cam({ do: 'vcamRemove' }));
      const vRow = UI.row('Virtual camera', '', [vRemove, virtual]);
      const vCard = UI.card('Virtual camera', [sourceRow, vRow]);

      const note = UI.note('info', '');
      body.append(picCard, vCard, note);

      let lastPhonesKey = '';
      const phoneControls = new Map(); // id -> { row, startBtn, facingSeg, rotateBtn, winBtn, sendSelect, sendWrap }

      return (s) => {
        cur = s;
        const c = s.camera || {};
        const v = s.vcam || {};
        const phones = getPhones(s);
        const runningPhones = phones.filter((p) => p.camera && p.camera.on);
        const anyOn = runningPhones.length > 0;
        const vName = `“${v.name || 'TwinDesk Camera'}”`;
        const hasSlots = Array.isArray(v.slots) && v.slots.length >= 2;

        // Previews: per-running-phone tiles or the empty message box
        if (!anyOn) {
          for (const tile of tiles.values()) disposeTile(tile);
          tiles.clear();
          grid.replaceChildren();
          grid.hidden = true;
          emptyBox.hidden = false;

          let text = '';
          if (!c.on) text = 'Off: turn on Camera at the top';
          else if (!phones.length) text = 'No phone connected: connect a phone to use its camera';
          else text = 'Press Start to run a camera here';
          emptySaid.textContent = text;
        } else {
          emptyBox.hidden = true;
          grid.hidden = false;

          // Clean up tiles for phones no longer running camera
          const runningIds = new Set(runningPhones.map((p) => p.id));
          for (const [id, tile] of tiles.entries()) {
            if (!runningIds.has(id)) {
              disposeTile(tile);
              tiles.delete(id);
            }
          }

          // Build or update tile per running phone
          const tileElements = [];
          for (const p of runningPhones) {
            const phoneIdx = phones.findIndex((x) => x.id === p.id);
            const orderNum = (phoneIdx >= 0 ? phoneIdx : 0) + 1;
            const androidLabel = `Android ${orderNum}`;

            let tile = tiles.get(p.id);
            if (!tile) {
              const img = el('img', { alt: '' });
              Object.assign(img.style, { width: '100%', height: '100%', objectFit: 'contain', display: 'block' });

              const caption = el('div', { class: 'phone-cam-caption' });
              Object.assign(caption.style, {
                position: 'absolute',
                bottom: '0',
                left: '0',
                right: '0',
                padding: '6px 10px',
                background: 'linear-gradient(transparent, rgba(0, 0, 0, 0.75))',
                color: '#fff',
                fontSize: '12px',
                fontWeight: '500',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                pointerEvents: 'none',
              });

              const box = el('div', { class: 'phone-cam-preview' }, [img, caption]);
              Object.assign(box.style, {
                position: 'relative',
                aspectRatio: '16 / 9',
                background: '#000',
                borderRadius: '8px',
                overflow: 'hidden',
                cursor: 'pointer',
              });

              box.onclick = () => {
                if (!cur) return;
                const currPhone = getPhones(cur).find((x) => x.id === p.id);
                const facing = (currPhone && currPhone.camera && currPhone.camera.facing) || phoneFacing.get(p.id) || 'back';
                api.phoneCamera(true, { facing, show: true, id: p.id });
              };

              tile = { phoneId: p.id, wcId: p.camera && p.camera.wcId, box, img, caption, url: '' };
              tiles.set(p.id, tile);
            }

            tile.wcId = p.camera && p.camera.wcId;
            tile.box.title = `Open ${androidLabel} (${p.name})’s camera in a window`;
            tile.caption.title = p.name;
            const isVirtual = !!(p.camera && p.camera.virtualActive);
            tile.caption.textContent = androidLabel + (p.name ? ` (${p.name})` : '') + (isVirtual ? ' · Feeds Virtual Camera' : '');
            tileElements.push(tile.box);
          }
          grid.replaceChildren(...tileElements);
        }

        // Build / update per-phone rows
        const slotKey = hasSlots ? JSON.stringify(v.slots) : '';
        const phonesKey = JSON.stringify([slotKey, ...phones.map((p) => [p.id, p.name, p.state, p.camera, v.slotMap && v.slotMap[p.id]])]);
        if (phonesKey !== lastPhonesKey) {
          lastPhonesKey = phonesKey;
          if (!phones.length) {
            phoneControls.clear();
            const emptyRow = UI.row('No phones connected', 'Connect a phone to use its camera', []);
            phoneRows.replaceChildren(emptyRow);
          } else {
            const slotOptions = hasSlots
              ? [{ value: 'off', label: 'Off' }, ...v.slots.map((name, i) => ({ value: String(i), label: name }))]
              : [{ value: 'off', label: 'Off' }];

            const rows = phones.map((p, idx) => {
              const androidLabel = `Android ${idx + 1}`;
              const camState = p.camera || {};
              const camOn = !!camState.on;
              const ready = p.state === 'ready';
              let facing = camState.facing || phoneFacing.get(p.id) || 'back';
              phoneFacing.set(p.id, facing);

              let ctrl = phoneControls.get(p.id);
              if (!ctrl) {
                const startBtn = UI.button(camOn ? 'Stop' : 'Start', () => {
                  const currPhone = getPhones(cur).find((x) => x.id === p.id);
                  const isRunning = currPhone && currPhone.camera && currPhone.camera.on;
                  const f = (currPhone && currPhone.camera && currPhone.camera.facing) || phoneFacing.get(p.id) || 'back';
                  api.phoneCamera(!isRunning, !isRunning ? { facing: f, id: p.id } : { id: p.id });
                });
                const facingSeg = UI.segmented([{ value: 'back', label: 'Back' }, { value: 'front', label: 'Front' }], (val) => {
                  phoneFacing.set(p.id, val);
                  facingSeg.set(val);
                  const currPhone = getPhones(cur).find((x) => x.id === p.id);
                  if (currPhone && currPhone.camera && currPhone.camera.on) {
                    api.phoneCamera(true, { facing: val, id: p.id });
                  }
                });
                facingSeg.set(facing);
                const rotateBtn = UI.button('Rotate', () => cam({ do: 'rotate' }));
                rotateBtn.title = 'A quarter turn clockwise: in its window and in the virtual camera';
                const winBtn = UI.button(camState.shown ? 'Window ✓' : 'Window', () => {
                  const currPhone = getPhones(cur).find((x) => x.id === p.id);
                  const f = (currPhone && currPhone.camera && currPhone.camera.facing) || phoneFacing.get(p.id) || 'back';
                  api.phoneCamera(true, { facing: f, show: true, id: p.id });
                });
                winBtn.title = 'Open it in a window';

                const sendSelect = UI.select(slotOptions, (val) => {
                  cam({ do: 'slot', phoneId: p.id, slot: val === 'off' ? null : Number(val) });
                });
                sendSelect.el.title = 'Send this camera to a virtual camera other apps can pick';

                const sendWrap = el('span', { class: 'send-to-wrap', style: 'display:inline-flex;align-items:center;gap:4px;' }, [
                  el('span', { text: 'Send to:', style: 'font-size:12px;color:var(--muted);' }),
                  sendSelect.el,
                ]);

                const row = UI.row(`${androidLabel}’s camera`, p.name, [startBtn, facingSeg, rotateBtn, winBtn, sendWrap]);
                ctrl = { row, startBtn, facingSeg, rotateBtn, winBtn, sendSelect, sendWrap };
                phoneControls.set(p.id, ctrl);
              }

              ctrl.sendWrap.hidden = !hasSlots;
              if (hasSlots) ctrl.sendSelect.options(slotOptions);

              ctrl.startBtn.textContent = camOn ? 'Stop' : 'Start';
              ctrl.startBtn.className = 'btn' + (camOn ? '' : ' primary');
              ctrl.startBtn.disabled = !c.on || !ready;
              ctrl.facingSeg.set(facing);
              ctrl.facingSeg.disable(!c.on || !ready);
              ctrl.rotateBtn.disabled = !camOn;
              ctrl.winBtn.disabled = !camOn;
              ctrl.winBtn.textContent = camState.shown ? 'Window ✓' : 'Window';

              // Slot assignment: from vcam.slotMap or camState.slot
              if (hasSlots) {
                let currentSlot = 'off';
                if (v.slotMap && v.slotMap[p.id] != null) currentSlot = String(v.slotMap[p.id]);
                else if (camState.slot != null) currentSlot = String(camState.slot);
                else if (camState.virtualActive) currentSlot = '0';
                ctrl.sendSelect.set(currentSlot);
                ctrl.sendSelect.el.disabled = !v.on || !ready || !!v.busy;
              }

              if (!ready) ctrl.row.setHint(`${p.name} · Needs wireless debugging: set it up on the Phone page`);
              else if (camState.error) ctrl.row.setHint(`${p.name} · ${camState.error}`);
              else if (camOn) {
                const side = facing === 'front' ? 'Front' : 'Back';
                const activeText = camState.virtualActive ? ' · Feeds Virtual Camera' : '';
                ctrl.row.setHint(`${p.name} · ${side} camera running${activeText}`);
              } else {
                ctrl.row.setHint(`${p.name} · Android 12 or later`);
              }
              return ctrl.row;
            });
            phoneRows.replaceChildren(...rows);
          }
        }

        // Single "Camera source" row: shown when fewer than 2 slots (Mac behavior)
        if (!hasSlots) {
          if (runningPhones.length > 1) {
            sourceRow.hidden = false;
            sourceSelect.options(runningPhones.map((p) => ({ value: p.id, label: p.name + (p.camera.virtualActive ? ' (Active)' : '') })));
            const active = runningPhones.find((p) => p.camera.virtualActive) || runningPhones[0];
            sourceSelect.set(active.id);
            sourceSelect.el.disabled = !v.on || !!v.busy;
            sourceRow.setHint('Choose which phone feeds the virtual camera');
          } else if (runningPhones.length === 1) {
            sourceRow.hidden = false;
            sourceSelect.options([{ value: runningPhones[0].id, label: runningPhones[0].name + ' (Active)' }]);
            sourceSelect.set(runningPhones[0].id);
            sourceSelect.el.disabled = true;
            sourceRow.setHint(`${runningPhones[0].name} is feeding the virtual camera`);
          } else {
            sourceRow.hidden = phones.length <= 1;
            if (!sourceRow.hidden) {
              sourceSelect.options(phones.map((p) => ({ value: p.id, label: p.name })));
              sourceSelect.el.disabled = true;
              sourceRow.setHint('Start a phone’s camera to feed ' + vName);
            }
          }
        } else {
          sourceRow.hidden = true;
        }

        // Virtual camera card status
        virtual.set(!!v.on);
        virtual.disable(v.supported === false || !!v.busy);
        vRemove.hidden = !v.installed || !!v.on || !!v.busy || v.removable === false;

        vRow.setHint(!v.checked ? 'Checking…'
          : v.supported === false ? v.message
            : v.busy === 'install' ? (v.message || 'Installing…')
              : v.busy === 'remove' ? 'Removing…'
                : v.ready && v.live ? `Sharing now: in Zoom, Teams, the browser…, choose only ${vName} as the camera`
                  : v.ready ? (hasSlots ? `Ready: up to ${v.slots.length} virtual cameras (${vName}, 2, 3, 4). Choose which phone sends to each camera above.`
                                        : `Ready: the camera running here goes to ${vName}. Choose only that one in the app you call from`)
                    : v.on ? (v.message || 'Not installed')
                      : v.message || `Off: the picture stays in TwinDesk. On: it’s also ${vName}, a camera other apps can pick`);

        note.set(v.ready
          ? (hasSlots ? `Apps here see up to ${v.slots.length} virtual cameras: ${v.slots.map((s) => `“${s}”`).join(', ')}. Pick the assigned camera in your video calling app.`
                      : `Apps here see it as ${vName}: pick that one, not this computer’s own camera.`)
          : 'Turn on Virtual camera to use phone cameras in other apps (Zoom, Teams, the browser…).');
      };
    },
  });
})();
