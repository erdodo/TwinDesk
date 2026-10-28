// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// Camera tab (Mac Mesh): each connected phone's camera in a row (start/stop, front/back, rotate,
// window) and the virtual camera ("TwinDesk Camera", shared/vcam.js).
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

      // The picture: what the camera's window sends (a JPEG, about 12 a second). A click opens the window.
      const img = el('img', { alt: '' });
      Object.assign(img.style, { width: '100%', height: '100%', objectFit: 'contain', display: 'block' });
      const said = el('div');
      Object.assign(said.style, { position: 'absolute', inset: '0', display: 'grid', placeItems: 'center', textAlign: 'center', padding: '0 24px', color: '#a1a1a6' });
      const box = el('div', { title: 'Open it in a window', class: 'phone-cam-preview' }, [img, said]);
      Object.assign(box.style, { position: 'relative', aspectRatio: '16 / 9', background: '#000', borderRadius: '8px', overflow: 'hidden', cursor: 'pointer', margin: '12px 14px' });

      box.onclick = () => {
        if (!cur) return;
        const phones = getPhones(cur);
        const active = phones.find((p) => p.camera && p.camera.virtualActive) || phones.find((p) => p.camera && p.camera.on);
        if (active) {
          const facing = (active.camera && active.camera.facing) || phoneFacing.get(active.id) || 'back';
          api.phoneCamera(true, { facing, show: true, id: active.id });
        }
      };

      let url = '';
      if (api.onCamPreview) {
        api.onCamPreview((buf) => {
          if (!cur || !running(cur)) return;
          const next = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
          img.onload = () => { if (url && url !== next) URL.revokeObjectURL(url); url = next; };
          img.src = next;
        });
      }

      // Multi-phone camera rows
      const phoneRows = el('div', { class: 'phone-cam-rows' });
      const picCard = UI.card('', [box, phoneRows]);

      // Virtual camera: the picture also goes to a camera other apps can pick.
      const virtual = UI.switch((v) => cam({ do: 'virtual', on: v }), { label: 'Virtual camera' });
      const vRemove = UI.button('Remove', () => cam({ do: 'vcamRemove' }));
      const vRow = UI.row('Virtual camera', '', [vRemove, virtual]);

      // Which phone feeds the virtual camera
      const sourceSelect = UI.select([], (phoneId) => cam({ do: 'activeSource', phoneId }));
      const sourceRow = UI.row('Camera source', 'Which phone feeds the virtual camera', [sourceSelect]);

      // Which camera it feeds (TwinDesk Camera or OBS Virtual Camera)
      const vTarget = UI.select([], (t) => cam({ do: 'vcamTarget', target: t }));
      const vTargetRow = UI.row('Send to', 'The camera other apps pick', [vTarget]);
      const vCard = UI.card('Virtual camera', [vTargetRow, sourceRow, vRow]);

      const note = UI.note('info', '');
      body.append(picCard, vCard, note);

      let lastPhonesKey = '';
      const phoneControls = new Map(); // id -> { row, startBtn, facingSeg, rotateBtn, winBtn, setHint }

      return (s) => {
        cur = s;
        const c = s.camera || {};
        const v = s.vcam || {};
        const phones = getPhones(s);
        const anyOn = running(s);
        const vName = `“${v.name || 'TwinDesk Camera'}”`;

        // The picture, or why it isn't running
        let text = '';
        if (!c.on) text = 'Off: turn on Camera at the top';
        else if (!phones.length) text = 'No phone connected: connect a phone to use its camera';
        else if (!anyOn) text = 'Press Start to run a camera here';
        said.textContent = text;
        said.hidden = !text;
        img.hidden = !anyOn || !text;
        if (!anyOn && url) {
          URL.revokeObjectURL(url);
          url = '';
          img.removeAttribute('src');
        }

        // Build / update per-phone rows
        const phonesKey = JSON.stringify(phones.map((p) => [p.id, p.name, p.state, p.camera]));
        if (phonesKey !== lastPhonesKey) {
          lastPhonesKey = phonesKey;
          if (!phones.length) {
            phoneControls.clear();
            const emptyRow = UI.row('No phones connected', 'Connect a phone to use its camera', []);
            phoneRows.replaceChildren(emptyRow);
          } else {
            const rows = phones.map((p) => {
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

                const row = UI.row(p.name + '’s camera', '', [startBtn, facingSeg, rotateBtn, winBtn]);
                ctrl = { row, startBtn, facingSeg, rotateBtn, winBtn };
                phoneControls.set(p.id, ctrl);
              }

              ctrl.startBtn.textContent = camOn ? 'Stop' : 'Start';
              ctrl.startBtn.className = 'btn' + (camOn ? '' : ' primary');
              ctrl.startBtn.disabled = !c.on || !ready;
              ctrl.facingSeg.set(facing);
              ctrl.facingSeg.disable(!c.on || !ready);
              ctrl.rotateBtn.disabled = !camOn;
              ctrl.winBtn.disabled = !camOn;
              ctrl.winBtn.textContent = camState.shown ? 'Window ✓' : 'Window';

              if (!ready) ctrl.row.setHint('Needs wireless debugging: set it up on the Phone page');
              else if (camState.error) ctrl.row.setHint(camState.error);
              else if (camOn) {
                const side = facing === 'front' ? 'Front' : 'Back';
                const activeText = camState.virtualActive ? ' · Feeds Virtual Camera' : '';
                ctrl.row.setHint(`${side} camera running${activeText}`);
              } else {
                ctrl.row.setHint('Android 12 or later');
              }
              return ctrl.row;
            });
            phoneRows.replaceChildren(...rows);
          }
        }

        // Virtual camera
        virtual.set(!!v.on);
        virtual.disable(v.supported === false || !!v.busy);
        vRemove.hidden = !v.installed || !!v.on || !!v.busy || v.removable === false;
        vTargetRow.hidden = !(v.targets && v.targets.length > 1);
        if (!vTargetRow.hidden) {
          vTarget.options(v.targets);
          vTarget.set(v.target || v.targets[0].value);
          vTarget.el.disabled = !!v.busy;
        }

        // Which phone feeds the virtual camera
        const runningPhones = phones.filter((p) => p.camera && p.camera.on);
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

        vRow.setHint(!v.checked ? 'Checking…'
          : v.supported === false ? v.message
            : v.busy === 'install' ? (v.message || 'Installing…')
              : v.busy === 'remove' ? 'Removing…'
                : v.ready && v.live ? `Sharing now: in Zoom, Teams, the browser…, choose only ${vName} as the camera`
                  : v.ready ? `Ready: the camera running here goes to ${vName}. Choose only that one in the app you call from`
                    : v.on ? (v.message || 'Not installed')
                      : v.message || `Off: the picture stays in TwinDesk. On: it’s also ${vName}, a camera other apps can pick`);

        note.set(v.ready
          ? `Apps here see it as ${vName}: pick that one, not this computer’s own camera.`
          : 'Turn on Virtual camera to use it as a real camera in other apps (Zoom, Teams, the browser…).');
      };
    },
  });
})();
