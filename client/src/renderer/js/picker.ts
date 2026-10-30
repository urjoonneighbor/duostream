// Окно выбора экрана или окна для трансляции.
import { $ } from './ui.ts';
import type { DesktopSource } from '../../shared/duo-api';

export interface SourcePick {
  source: DesktopSource;
  audio: boolean;
}

export function openSourcePicker({ captureAudio, info }: { captureAudio: boolean; info: string }): Promise<SourcePick | null> {
  const dialog = $<HTMLDialogElement>('#pickerDialog');
  const grid = $('#pickerGrid');
  const audioBox = $<HTMLInputElement>('#pickerAudio');
  const tabs = [...$('#pickerTabs').querySelectorAll('button')];
  const listeners = new AbortController();
  const on = (el: EventTarget, type: string, fn: (e: Event) => void) => el.addEventListener(type, fn, { signal: listeners.signal });

  let tab: DesktopSource['type'] = 'screen';
  let sources: DesktopSource[] = [];
  audioBox.checked = captureAudio;
  $('#pickerInfo').textContent = info;

  return new Promise((resolve) => {
    const finish = (source: DesktopSource | null) => {
      listeners.abort();
      if (dialog.open) dialog.close();
      resolve(source ? { source, audio: audioBox.checked } : null);
    };

    const card = (s: DesktopSource) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'source';
      button.title = s.name;
      const img = document.createElement('img');
      img.className = 'thumb';
      img.alt = '';
      if (s.thumbnail) img.src = s.thumbnail;
      const name = document.createElement('div');
      name.className = 'name';
      if (s.icon) {
        const icon = document.createElement('img');
        icon.src = s.icon;
        icon.alt = '';
        name.append(icon);
      }
      const label = document.createElement('span');
      label.textContent = s.name;
      name.append(label);
      button.append(img, name);
      button.addEventListener('click', () => finish(s));
      return button;
    };

    const render = () => {
      tabs.forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
      const list = sources.filter((s) => s.type === tab);
      if (!list.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = tab === 'screen' ? 'Экраны не найдены' : 'Нет окон, доступных для захвата';
        grid.replaceChildren(empty);
      } else {
        grid.replaceChildren(...list.map(card));
      }
    };

    const load = async () => {
      const loading = document.createElement('div');
      loading.className = 'empty';
      loading.textContent = 'Загрузка источников…';
      grid.replaceChildren(loading);
      try {
        sources = await window.duo.listSources();
      } catch (err) {
        sources = [];
        loading.textContent = `Не удалось получить список: ${(err as Error).message}`;
        return;
      }
      render();
    };

    tabs.forEach((b) =>
      on(b, 'click', () => {
        tab = b.dataset.tab === 'window' ? 'window' : 'screen';
        render();
      }),
    );
    on($('#pickerRefresh'), 'click', load);
    on($('#pickerCancel'), 'click', () => finish(null));
    on(dialog, 'cancel', (e) => {
      e.preventDefault();
      finish(null);
    });

    dialog.showModal();
    void load();
  });
}
