// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Clipboard tab: accept (Mac → PC) and send (PC → Mac) as two direction cards, then
// timing, privacy and the Recent list for both.
'use strict';

UI.tab({
  id: 'clipboard',
  order: 40,
  title: 'Clipboard',
  color: 'linear-gradient(#64d2ff, #30b0c7)',
  desc: 'Copy on one computer, paste on the other.',
  master: { get: (s) => s.clipboard.enabled, set: (v) => UI.api.setClipboard({ enabled: v }) },
  badge: (s) => (!s.clipboard.enabled ? '' : s.link.state === 'connected' && !s.clipboard.peerAccepts ? 'warn' : 'on'),
  build(body) {
    const { el, api } = UI;
    const set = (partial) => api.setClipboard(partial);

    const peerRow = UI.row('', '');
    const skipNote = UI.note('info', '');
    const pausedNote = UI.note('warn', '');
    const mode = UI.segmented([
      { value: 'instant', label: 'Instantly' }, // the default
      { value: 'switch', label: 'When you switch' },
    ], (v) => set({ mode: v }));
    const modeRow = UI.row('Sync', '', [mode]);
    const concealed = UI.switch((v) => set({ skipConcealed: v }), { label: 'Skip passwords' });
    const maxKB = UI.select([
      { value: 16, label: '16 KB' }, { value: 64, label: '64 KB' }, { value: 256, label: '256 KB' },
    ], (v) => set({ maxKB: Number(v) }));
    const images = UI.switch((v) => set({ images: v }), { label: 'Images' });
    const files = UI.switch((v) => set({ files: v }), { label: 'Files' });
    const filesMaxMB = UI.select([
      { value: 10, label: '10 MB' }, { value: 25, label: '25 MB' }, { value: 50, label: '50 MB' },
      { value: 100, label: '100 MB' }, { value: 250, label: '250 MB' },
    ], (v) => set({ filesMaxMB: Number(v) }));
    const historySize = UI.select([
      { value: 0, label: 'Off' }, { value: 10, label: '10 items' }, { value: 20, label: '20 items' },
      { value: 50, label: '50 items' }, { value: 100, label: '100 items' },
    ], (v) => set({ historySize: Number(v) }));
    const pair = UI.dirCards(
      { on: { get: (s) => s.clipboard.receive, set: (v) => set({ receive: v }) }, label: 'Copy on {name}, paste on {me}', rows: [] },
      { on: { get: (s) => s.clipboard.send, set: (v) => set({ send: v }) }, label: 'Copy on {me}, paste on {name}', rows: [peerRow] },
    );

    const list = el('div', { class: 'history' });
    const clearBtn = UI.button('Clear', () => api.clearHistory(), 'small');

    body.append(
      pair.el,
      UI.card('', [modeRow]),
      UI.card('What is shared', [
        UI.row('Images', 'Screenshots and copied pictures', [images]),
        UI.row('Files', 'Copied in File Explorer', [files]),
        UI.row('Largest files', 'Bigger ones wait for the paste shortcut (Files tab)', [filesMaxMB]),
      ]),
      UI.card('Privacy', [
        UI.row('Skip passwords', 'From password managers', [concealed]),
        UI.row('Largest item', '', [maxKB]),
        UI.row('Recent items', 'Text stays in memory; images and files are kept in the app’s cache folder until you clear them or quit', [historySize]),
      ]),
      skipNote,
      pausedNote,
      UI.card('Recent', [list], { actions: [clearBtn] }),
    );

    // The whole item in an overlay card: full text, the image scaled to fit, every file and folder.
    const preview = async (h) => {
      const p = await api.previewHistory(h.id);
      if (!p) return;
      const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
      const onKey = (e) => { if (e.key === 'Escape') close(); };
      let content;
      if (p.kind === 'text') content = el('pre', { class: 'prev-text selectable', text: p.text });
      else if (p.kind === 'image') {
        content = p.image
          ? el('img', { class: 'prev-image', src: p.image, alt: 'Image ' + p.w + '×' + p.h })
          : el('div', { class: 'hint', text: 'Too big to show' });
      } else {
        content = el('div', { class: 'prev-files' }, [
          ...p.files.map((f) => el('div', { class: 'prev-file' }, [
            UI.icon(f.dir ? 'folder' : 'doc'),
            el('span', { class: 'prev-name selectable', text: f.name }),
            el('span', { class: 'hint', text: f.dir ? 'Folder' : UI.bytes(f.size) }),
          ])),
          p.more ? el('div', { class: 'hint', text: '+' + p.more + ' more' }) : null,
        ]);
      }
      const copyBtn = UI.button('Copy', async () => { await api.copyHistory(h.id); close(); }, 'small');
      copyBtn.disabled = !h.kept;
      const overlay = el('div', { class: 'prev-overlay', onclick: (e) => { if (e.target === overlay) close(); } }, [
        el('div', { class: 'prev-card', role: 'dialog' }, [
          el('div', { class: 'prev-head' }, [
            el('b', { text: h.title }),
            el('span', { class: 'hint', text: UI.fill((p.dir === 'out' ? 'To {name}' : 'From {name}') + ' · ' + UI.ago(p.at) + ' · ' + UI.bytes(p.size)) }),
          ]),
          el('div', { class: 'prev-body' }, [content]),
          el('div', { class: 'prev-foot' }, [copyBtn, UI.button('Close', close, 'small')]),
        ]),
      ]);
      document.addEventListener('keydown', onKey);
      document.body.append(overlay);
    };

    let lastKey = '';
    return (s) => {
      const c = s.clipboard;
      pair.update(s);
      mode.set(c.mode);
      modeRow.setHint(c.mode === 'instant' ? 'As soon as you copy' : 'When you move to the other computer');
      concealed.set(c.skipConcealed);
      images.set(c.images);
      files.set(c.files);
      filesMaxMB.set(c.filesMaxMB);
      maxKB.set(c.maxKB);
      historySize.set(c.historySize);
      const refused = s.link.state === 'connected' && !c.peerAccepts;
      peerRow.hidden = !refused;
      peerRow.label.textContent = 'Turned off on ' + UI.peer(s).name;
      peerRow.setHint('');
      skipNote.set(c.enabled && c.lastSkip ? 'Last item not sent: ' + c.lastSkip + '.' : '');
      pausedNote.set(c.enabled && c.paused && c.pausedUntil > Date.now() ? 'Clipboard sync paused for 30 s: copies were coming in too fast (a loop?)' : '');
      clearBtn.disabled = !c.history.length;

      const key = JSON.stringify(c.history.map((h) => [h.id, h.dir, h.kept])) + c.historySize + Math.floor(Date.now() / 15000);
      if (key === lastKey) return;
      lastKey = key;
      list.replaceChildren(...(c.history.length
        ? c.history.map((h) => el('div', { class: 'hist-item' }, [
          el('span', { class: 'hist-dir ' + h.dir, title: h.dir === 'out' ? 'Sent to {name}' : 'From {name}' }, [UI.icon(h.dir === 'out' ? 'up' : 'down')]),
          h.thumb ? el('img', { class: 'hist-thumb', src: h.thumb, alt: '' })
            : el('span', { class: 'hist-kind' }, [h.kind === 'text' ? null : UI.icon(h.kind === 'image' ? 'photo' : 'doc')]),
          el('div', { class: 'hist-text' }, [
            el('div', { class: 'hist-preview selectable', text: h.title }),
            el('div', { class: 'hint', text: (h.dir === 'out' ? 'To {name}' : 'From {name}') + ' · ' + UI.ago(h.at) + ' · ' + UI.bytes(h.size) + (h.sub ? ' · ' + h.sub : '') }),
          ]),
          UI.button('Preview', () => preview(h), 'small'),
          (() => {
            const b = UI.button('Copy', () => api.copyHistory(h.id), 'small');
            b.disabled = !h.kept;
            if (!h.kept) b.title = 'Too big to keep, so it cannot be copied again';
            return b;
          })(),
        ]))
        : [UI.row(c.historySize ? 'Nothing yet' : 'Recent items are off', '')]));
    };
  },
});
