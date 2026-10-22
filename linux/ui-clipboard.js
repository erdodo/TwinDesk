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
    const filesMax = UI.select([
      { value: 10, label: '10 MB' }, { value: 50, label: '50 MB' }, { value: 200, label: '200 MB' },
      { value: 500, label: '500 MB' }, { value: 1000, label: '1 GB' },
    ], (v) => set({ filesMaxMB: Number(v) }));
    const filesNote = UI.note('info', '');
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
      UI.card('Also share', [
        UI.row('Images', 'Screenshots and copied pictures', [images]),
        UI.row('Files', 'Copied in the file manager', [files]),
        UI.row('Files up to', 'Bigger ones wait for the paste shortcut', [filesMax]),
      ]),
      filesNote,
      UI.card('Privacy', [
        UI.row('Skip passwords', 'From password managers', [concealed]),
        UI.row('Largest item', '', [maxKB]),
        UI.row('Recent items', 'Text stays in memory; images and files are kept in the app’s cache folder until you clear them or quit', [historySize]),
      ]),
      skipNote,
      UI.card('Recent', [list], { actions: [clearBtn] }),
    );

    // Preview: the whole item in an overlay card (full text, full image, every file) with Copy and Close.
    const closePreview = () => document.querySelector('.hist-modal')?.remove();
    async function openPreview(h) {
      closePreview();
      const p = await api.previewHistory(h.id);
      if (!p) return;
      let content;
      if (p.kind === 'text') content = el('pre', { class: 'hist-full selectable', text: p.text });
      else if (p.kind === 'image') {
        content = p.image
          ? el('img', { class: 'hist-img', src: p.image, alt: 'Image ' + p.w + '×' + p.h })
          : el('div', { class: 'hint', text: 'Image ' + p.w + '×' + p.h + ' (too big to show)' });
      } else {
        content = el('div', { class: 'hist-files' }, [
          ...p.files.map((f) => el('div', { class: 'hist-file' }, [
            UI.icon(f.dir ? 'folder' : 'doc'),
            el('span', { class: 'hist-file-name selectable', text: f.name }),
            el('span', { class: 'hint', text: f.dir ? '' : UI.bytes(f.size) }),
          ])),
          p.more ? el('div', { class: 'hint', text: '+' + p.more + ' more' }) : null,
        ]);
      }
      const copy = UI.button('Copy', async () => { await api.copyHistory(h.id); closePreview(); }, 'primary');
      copy.disabled = !p.kept;
      if (!p.kept) copy.title = 'Too big to keep, so it cannot be copied again';
      const modal = el('div', { class: 'hist-modal' }, [
        el('div', { class: 'hist-card', attrs: { role: 'dialog', 'aria-modal': 'true' } }, [
          el('div', { class: 'hist-card-head', text: h.title }),
          el('div', { class: 'hist-card-body' }, [content]),
          el('div', { class: 'hist-card-foot' }, [copy, UI.button('Close', closePreview)]),
        ]),
      ]);
      modal.onclick = (e) => { if (e.target === modal) closePreview(); };
      document.addEventListener('keydown', function esc(e) {
        if (e.key !== 'Escape') return;
        document.removeEventListener('keydown', esc);
        closePreview();
      });
      document.body.append(modal);
    }

    let lastKey = '';
    return (s) => {
      const c = s.clipboard;
      pair.update(s);
      mode.set(c.mode);
      modeRow.setHint(c.mode === 'instant' ? 'As soon as you copy' : 'When you move to the other computer');
      concealed.set(c.skipConcealed);
      maxKB.set(c.maxKB);
      images.set(c.images);
      files.set(c.files);
      filesMax.set(c.filesMaxMB);
      filesNote.set(c.filesNote || '');
      historySize.set(c.historySize);
      const refused = s.link.state === 'connected' && !c.peerAccepts;
      peerRow.hidden = !refused;
      peerRow.label.textContent = 'Turned off on ' + UI.peer(s).name;
      peerRow.setHint('');
      skipNote.set(c.enabled && c.lastSkip ? 'Last item not sent: ' + c.lastSkip + '.' : '');
      clearBtn.disabled = !c.history.length;

      const key = JSON.stringify(c.history.map((h) => [h.id, h.kept])) + c.historySize + Math.floor(Date.now() / 15000);
      if (key === lastKey) return;
      lastKey = key;
      list.replaceChildren(...(c.history.length
        ? c.history.map((h) => el('div', { class: 'hist-item' }, [
          el('span', { class: 'hist-dir ' + h.dir, title: h.dir === 'out' ? 'Sent to {name}' : 'From {name}' }, [UI.icon(h.dir === 'out' ? 'up' : 'down')]),
          h.kind === 'image' && h.thumb ? el('img', { class: 'hist-thumb', src: h.thumb, alt: '' })
            : el('span', { class: 'hist-kind' }, [UI.icon(h.kind === 'image' ? 'photo' : h.kind === 'files' ? 'doc' : 'clipboard')]),
          el('div', { class: 'hist-text' }, [
            el('div', { class: 'hist-preview selectable', text: h.title }),
            el('div', { class: 'hint', text: (h.dir === 'out' ? 'To {name}' : 'From {name}') + ' · ' + UI.ago(h.at) + ' · ' + UI.bytes(h.size) + (h.sub ? ' · ' + h.sub : '') }),
          ]),
          UI.button('Preview', () => openPreview(h), 'small'),
          Object.assign(UI.button('Copy', () => api.copyHistory(h.id), 'small'), h.kept ? {} : { disabled: true, title: 'Too big to keep, so it cannot be copied again' }),
        ]))
        : [UI.row(c.historySize ? 'Nothing yet' : 'Recent items are off', '')]));
    };
  },
});
