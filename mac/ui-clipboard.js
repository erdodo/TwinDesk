// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Clipboard tab: directions, when to sync, privacy and limits, Recent list.
'use strict';

UI.tab({
  id: 'clipboard',
  group: 'Share',
  order: 40,
  title: 'Clipboard',
  desc: 'Copy on one computer, paste on the other.',
  color: 'linear-gradient(#64d2ff, #30b0c7)',
  master: { get: (s) => s.clipboard && s.clipboard.enabled, set: (v) => UI.api.setClipboard({ enabled: v }) },
  badge: (s) => (s.clipboard && s.clipboard.enabled ? 'on' : ''),
  build(body) {
    const { el, api } = UI;
    const set = (partial) => api.setClipboard(partial);

    const peerNote = UI.note('warn', '');
    const skipNote = UI.note('info', '');
    const pausedNote = UI.note('warn', '');
    const send = UI.switch((v) => set({ send: v }), { label: 'Send' });
    const receive = UI.switch((v) => set({ receive: v }), { label: 'Receive' });
    const mode = UI.segmented([
      { value: 'switch', label: 'When you switch' },
      { value: 'instant', label: 'Instantly' },
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
    const historySize = UI.select([
      { value: 0, label: 'Off' }, { value: 10, label: '10 items' }, { value: 20, label: '20 items' },
      { value: 50, label: '50 items' }, { value: 100, label: '100 items' },
    ], (v) => set({ historySize: Number(v) }));

    const peerRow = (label, hint, controls) => {
      const r = UI.row(label, hint, controls);
      r.label.dataset.peer = label;
      return r;
    };
    const list = el('div', { class: 'history' });

    // The whole item in an overlay card: full text, full image, every file. Copy and Close.
    const showPreview = async (h) => {
      const p = await api.previewHistory(h.id);
      if (!p) return;
      const close = () => { pop.remove(); document.removeEventListener('keydown', onKey); };
      const onKey = (e) => { if (e.key === 'Escape') close(); };
      let content;
      if (p.kind === 'text') {
        content = el('pre', { class: 'clip-prev-text selectable', text: p.text });
      } else if (p.kind === 'image') {
        content = p.image
          ? el('div', { class: 'clip-prev-image' }, [el('img', { attrs: { src: p.image, alt: `Image ${p.w}×${p.h}` } })])
          : el('div', { class: 'hint', text: 'This image is too big to show.' });
      } else {
        content = el('div', { class: 'clip-prev-files' }, [
          ...p.files.map((f) => el('div', { class: 'clip-prev-file' }, [
            UI.icon(f.dir ? 'folder' : 'doc'),
            el('span', { class: 'selectable', text: f.name }),
            el('span', { class: 'hint', text: f.dir ? 'Folder' : UI.bytes(f.size) }),
          ])),
          p.more ? el('div', { class: 'hint', text: `+ ${p.more} more` }) : null,
        ]);
      }
      const copy = UI.button('Copy', () => { api.copyHistory(h.id); close(); }, 'primary');
      copy.disabled = !p.kept;
      const pop = el('div', { class: 'clip-prev-back' }, [el('div', { class: 'clip-prev' }, [
        el('div', { class: 'clip-prev-head', text: `${UI.fill(p.dir === 'out' ? 'To {name}' : 'From {name}')} · ${UI.ago(p.at)} · ${UI.bytes(p.size)}` }),
        content,
        el('div', { class: 'clip-prev-foot' }, [
          el('span', { class: 'hint', text: p.kept ? '' : 'Not kept: it cannot be copied again.' }),
          copy,
          UI.button('Close', close),
        ]),
      ])]);
      pop.addEventListener('mousedown', (e) => { if (e.target === pop) close(); });
      document.addEventListener('keydown', onKey);
      document.body.append(pop);
    };
    const clearBtn = UI.button('Clear', () => api.clearHistory(), 'small');

    body.append(
      peerNote,
      UI.pair(
        UI.dir('m2w', [peerRow('Copy on {me}, paste on {name}', '', [send])]),
        UI.dir('w2m', [peerRow('Copy on {name}, paste on {me}', '', [receive])]),
      ),
      UI.card('Options', [
        modeRow,
        UI.row('Skip passwords', 'From password managers', [concealed]),
        UI.row('Largest item', '', [maxKB]),
        UI.row('Images', 'Pictures you copy', [images]),
        UI.row('Files', 'Files you copy in Finder. Bigger ones wait for the paste shortcut (Files tab)', [files]),
        UI.row('Largest files', 'Sent as soon as you copy', [filesMax]),
        UI.row('Recent items', 'Text stays in memory. Images and files are kept in the app’s cache folder until you clear them or quit', [historySize]),
      ]),
      skipNote,
      pausedNote,
      UI.card('Recent', [list], { actions: [clearBtn] }),
    );

    let lastKey = '';
    return (s) => {
      const c = s.clipboard;
      if (!c) return;
      send.set(c.send);
      receive.set(c.receive);
      mode.set(c.mode);
      modeRow.setHint(c.mode === 'instant' ? 'As soon as you copy' : 'When you move to the other computer');
      concealed.set(c.skipConcealed);
      maxKB.set(c.maxKB);
      images.set(c.images);
      files.set(c.files);
      filesMax.set(c.filesMaxMB);
      historySize.set(c.historySize);
      peerNote.set(s.client && !c.peerAccepts ? `Turned off on ${s.client.name}.` : '');
      skipNote.set(c.enabled && c.lastSkip ? `Last copy not sent: ${c.lastSkip}.` : '');
      pausedNote.set(c.enabled && c.paused ? 'Clipboard sync paused for 30 s: copies were coming in too fast (a loop?).' : '');
      clearBtn.disabled = !c.history.length;

      // Rebuild the list only when it changed (or every 15 s for the relative times).
      const key = JSON.stringify(c.history.map((h) => [h.id, h.at, h.dir, h.thumb ? 1 : 0])) + Math.floor(Date.now() / 15000);
      if (key === lastKey) return;
      lastKey = key;
      list.replaceChildren(...(c.history.length
        ? c.history.map((h) => {
          const copy = UI.button('Copy', () => api.copyHistory(h.id), 'small');
          copy.disabled = !h.kept;
          if (!h.kept) copy.title = 'Too big to keep: it cannot be copied again';
          const sub = [UI.fill(h.dir === 'out' ? 'To {name}' : 'From {name}'), UI.ago(h.at), UI.bytes(h.size), h.sub].filter(Boolean).join(' · ');
          return el('div', { class: 'hist-item' }, [
            el('span', { class: `hist-dir ${h.dir}`, title: UI.fill(h.dir === 'out' ? 'Sent to {name}' : 'From {name}') }, [UI.icon(h.dir === 'out' ? 'up' : 'down')]),
            h.thumb ? el('img', { class: 'hist-thumb', attrs: { src: h.thumb, alt: '' } }) : el('span', { class: 'hist-kind' }, [UI.icon(h.kind === 'image' ? 'photo' : h.kind === 'files' ? 'doc' : 'clipboard')]),
            el('div', { class: 'hist-text' }, [
              el('div', { class: 'hist-preview selectable', text: h.title }),
              el('div', { class: 'hint', text: sub }),
            ]),
            UI.button('Preview', () => showPreview(h), 'small'),
            copy,
          ]);
        })
        : [UI.row(c.historySize ? 'Nothing yet' : 'Recent items are off', '')]));
    };
  },
});
