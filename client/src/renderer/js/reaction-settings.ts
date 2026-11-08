// Вкладка «Реакции» в настройках: звук реакций (применяется сразу), список своих и создание новой.
// Файлы проверяет и хранит главный процесс (src/main/reactions.ts); здесь — предпросмотр и то, что умеет только окно:
// проверка разрешения, поиск звуковой дорожки в видео и маленькая статичная картинка для списка.
import { $ } from './ui.ts';
import { formatBytes } from './chat-ui.ts';
import { AvatarMedia, DEFAULT_AVATAR_CROP } from './avatar.ts';
import { REACTION_IMAGE_MAX_SIDE, REACTION_MAX_OWN, REACTION_VIDEO_MAX_SIDE, makeReactionThumb, reactionFitsResolution } from './reactions.ts';
import { bindHoverPreview, stopHoverPreview } from './reaction-ui.ts';
import type { ReactionSync } from './reaction-sync.ts';
import type { ReactionSound } from './reaction-sound.ts';
import type { Config } from '../../shared/config';
import type { AvatarMime, ReactionPickedFile } from '../../shared/duo-api';

export type ReactionSoundMode = 'none' | 'file' | 'video';

export class ReactionSettings {
  private readonly sync: ReactionSync;
  private readonly sound: () => ReactionSound | null;
  private readonly onAudio: (enabled: boolean, volume: number, persist: boolean) => Promise<void>;
  private media: AvatarMedia | null = null;
  private soundFile: (ReactionPickedFile & { blob: Blob }) | null = null;
  /** Выбранное видео со звуковой дорожкой */
  private videoHasAudio = false;
  private previewVideo: HTMLVideoElement | null = null;
  private busy = false;

  constructor({ sync, sound, onAudio }: { sync: ReactionSync; sound: () => ReactionSound | null; onAudio: (enabled: boolean, volume: number, persist: boolean) => Promise<void> }) {
    this.sync = sync;
    this.sound = sound;
    this.onAudio = onAudio;
    sync.on('change', ({ key }) => key === null && this.renderList());
    const enabled = $<HTMLInputElement>('#sReactionSounds');
    const volume = $<HTMLInputElement>('#sReactionVolume');
    // Ошибка — в этой вкладке: тост лежит под модальным диалогом и его затемнением
    const apply = (persist: boolean) => void this.onAudio(enabled.checked, Number(volume.value), persist).catch((err: Error) => this.showError(`Настройка не сохранена: ${err.message}`));
    enabled.addEventListener('change', () => apply(true));
    volume.addEventListener('input', () => apply(false));
    volume.addEventListener('change', () => apply(true));
    $('#rxList').addEventListener('click', (e) => {
      const button = (e.target as Element).closest<HTMLButtonElement>('button[data-act]');
      if (!button) return;
      const id = button.dataset.id ?? '';
      if (button.dataset.act === 'listen') this.sync.previewSound(id);
      else if (button.dataset.act === 'remove') void this.remove(id);
    });
    // Поле внутри формы настроек: Enter не должен сохранять и закрывать диалог
    $('#rxName').addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') e.preventDefault();
    });
    $('#rxName').addEventListener('input', () => this.updateForm());
    $('#btnRxPickMedia').addEventListener('click', () => void this.pickMedia());
    $('#btnRxPickSound').addEventListener('click', () => void this.pickSound());
    $('#rxSoundMode').addEventListener('change', () => this.updateForm());
    $('#btnRxListen').addEventListener('click', () => void this.listenDraft());
    $('#btnRxCreate').addEventListener('click', () => void this.create());
    $('#btnRxReset').addEventListener('click', () => this.reset());
  }

  open(audio: Config['audio']): void {
    $<HTMLInputElement>('#sReactionSounds').checked = audio.reactionSounds;
    $<HTMLInputElement>('#sReactionVolume').value = String(audio.reactionVolume);
    this.renderList();
    this.reset();
  }

  /** Настройки закрыты: выбранные файлы забываются, декодер видео отпускается */
  close(): void {
    stopHoverPreview();
    this.reset();
  }

  /** Текущие значения — чтобы «Сохранить» в настройках их не перетёрло */
  readAudio(): Pick<Config['audio'], 'reactionSounds' | 'reactionVolume'> {
    return { reactionSounds: $<HTMLInputElement>('#sReactionSounds').checked, reactionVolume: Number($<HTMLInputElement>('#sReactionVolume').value) };
  }

  private showError(text: string): void {
    const el = $('#rxError');
    el.textContent = text;
    el.hidden = !text;
    if (text) el.scrollIntoView({ block: 'nearest' }); // блок под формой, а действие могло быть в начале длинного списка
  }

  private renderList(): void {
    stopHoverPreview();
    const own = this.sync.ownList;
    $('#rxCount').textContent = `${own.length} из ${REACTION_MAX_OWN}`;
    $('#rxEmpty').hidden = own.length > 0;
    const rows = own.map((info) => {
      const row = document.createElement('div');
      row.className = 'rx-row';
      const preview = document.createElement('span');
      preview.className = 'rx-row-preview';
      if (info.thumb) {
        const img = document.createElement('img');
        img.alt = '';
        img.draggable = false;
        img.src = info.thumb;
        preview.append(img);
      }
      bindHoverPreview(preview, info.id, this.sync);
      const text = document.createElement('div');
      text.className = 'rx-row-text';
      const name = document.createElement('div');
      name.className = 'rx-row-name';
      name.textContent = info.name;
      name.title = info.name;
      const meta = document.createElement('div');
      meta.className = 'hint';
      const soundLabel = info.sound ? (info.sound.kind === 'video' ? 'звук из видео' : 'со звуком') : 'без звука';
      meta.textContent = `${info.mime.replace(/^[^/]+\//, '').toUpperCase()} · ${formatBytes(info.size)} · ${soundLabel}`;
      text.append(name, meta);
      const button = (act: string, label: string, disabled = false) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.disabled = disabled;
        Object.assign(b.dataset, { act, id: info.id });
        return b;
      };
      const listen = button('listen', 'Прослушать', !info.sound);
      const remove = button('remove', 'Удалить');
      remove.classList.add('ghost');
      row.append(preview, text, listen, remove);
      return row;
    });
    $('#rxList').replaceChildren(...rows);
  }

  private async remove(id: string): Promise<void> {
    this.showError('');
    const result = await window.duo.reactions.remove(id).catch((err: Error) => ({ ok: false as const, error: err.message }));
    if (result.ok) this.sync.removeOwn(id);
    else this.showError(`Не удалось удалить: ${result.error}`);
  }

  // ---------------- создание ----------------

  private async pickMedia(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.showError('');
    try {
      const result = await window.duo.reactions.pickMedia();
      if (!result.ok) return this.showError(result.error);
      if (!result.file) return;
      const file = result.file;
      const mime = file.mime as AvatarMime;
      const blob = new Blob([file.data as BlobPart], { type: mime });
      if (!(await reactionFitsResolution(blob, mime))) {
        await this.clearDraft();
        return this.showError(`Файл не читается или разрешение слишком большое: картинки и GIF — до ${REACTION_IMAGE_MAX_SIDE} px по стороне, видео — до ${REACTION_VIDEO_MAX_SIDE} px.`);
      }
      this.dropPreview();
      this.soundFile = null;
      $<HTMLSelectElement>('#rxSoundMode').value = 'none';
      this.media = new AvatarMedia(blob, mime, file.hash, DEFAULT_AVATAR_CROP);
      this.media.retain();
      this.mountPreview(this.media);
      const name = $<HTMLInputElement>('#rxName');
      if (!name.value.trim()) name.value = [...file.name].slice(0, 32).join('');
      $('#rxMediaInfo').textContent = `${file.mime.replace(/^[^/]+\//, '').toUpperCase()} · ${formatBytes(file.size)}`;
      // Есть ли у видео звук, знает только декодер; у звукового потока из видео ровно тот же путь при воспроизведении
      this.videoHasAudio = this.media.isVideo && Boolean(await this.sound()?.hasAudio(file.hash, blob));
      this.updateForm();
    } catch (err) {
      this.showError(`Не удалось выбрать файл: ${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  private async pickSound(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.showError('');
    try {
      const result = await window.duo.reactions.pickSound();
      if (!result.ok) return this.showError(result.error);
      if (!result.file) return;
      this.soundFile = { ...result.file, blob: new Blob([result.file.data as BlobPart], { type: result.file.mime }) };
      if (!(await this.sound()?.hasAudio(result.file.hash, this.soundFile.blob))) this.showError('Звук не удалось раскодировать: реакция будет беззвучной. Выберите другой файл.');
      this.updateForm();
    } catch (err) {
      this.showError(`Не удалось выбрать звук: ${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  /** Беззвучное зацикленное превью; файл без картинки (только звук) не подходит */
  private mountPreview(media: AvatarMedia): void {
    const box = $('#rxPreview');
    if (media.isVideo) {
      const video = document.createElement('video');
      video.muted = true;
      video.defaultMuted = true;
      video.loop = true;
      video.autoplay = true;
      video.playsInline = true;
      video.disablePictureInPicture = true;
      video.addEventListener('loadeddata', () => {
        if (this.previewVideo === video && !video.videoWidth) {
          this.showError('В этом файле нет видео.');
          void this.clearDraft();
        }
      });
      video.src = media.url;
      video.play().catch(() => {});
      this.previewVideo = video;
      box.replaceChildren(video);
    } else {
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      img.src = media.url;
      box.replaceChildren(img);
    }
  }

  private dropPreview(): void {
    const video = this.previewVideo;
    if (video) {
      this.previewVideo = null;
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    this.media?.release();
    this.media = null;
    $('#rxPreview').replaceChildren();
    $('#rxMediaInfo').textContent = '';
  }

  private clearDraft(): Promise<void> {
    this.dropPreview();
    this.soundFile = null;
    this.videoHasAudio = false;
    this.updateForm();
    return window.duo.reactions.cancelPick().catch(() => {});
  }

  private reset(): void {
    if (this.media || this.soundFile) void window.duo.reactions.cancelPick().catch(() => {});
    this.dropPreview();
    this.soundFile = null;
    this.videoHasAudio = false;
    this.showError('');
    $<HTMLInputElement>('#rxName').value = '';
    $<HTMLSelectElement>('#rxSoundMode').value = 'none';
    this.updateForm();
  }

  private soundMode(): ReactionSoundMode {
    return $<HTMLSelectElement>('#rxSoundMode').value as ReactionSoundMode;
  }

  private updateForm(): void {
    const videoOption = $<HTMLOptionElement>('#rxSoundVideo');
    videoOption.disabled = !this.videoHasAudio;
    videoOption.textContent = this.media?.isVideo && !this.videoHasAudio ? 'Взять из видео (в файле нет звука)' : 'Взять из видео';
    if (this.soundMode() === 'video' && !this.videoHasAudio) $<HTMLSelectElement>('#rxSoundMode').value = 'none';
    const mode = this.soundMode();
    $('#rxSoundFileRow').hidden = mode !== 'file';
    $('#rxSoundInfo').textContent = this.soundFile ? `${this.soundFile.name || 'звук'} · ${formatBytes(this.soundFile.size)}` : 'файл не выбран';
    $<HTMLButtonElement>('#btnRxListen').disabled = !(mode === 'video' || (mode === 'file' && this.soundFile));
    $<HTMLButtonElement>('#btnRxCreate').disabled = !this.media || !$<HTMLInputElement>('#rxName').value.trim() || (mode === 'file' && !this.soundFile);
  }

  private async listenDraft(): Promise<void> {
    const mode = this.soundMode();
    if (mode === 'video' && this.media) await this.sound()?.play(this.media.hash, this.media.blob, { preview: true });
    else if (mode === 'file' && this.soundFile) await this.sound()?.play(this.soundFile.hash, this.soundFile.blob, { preview: true });
  }

  private async create(): Promise<void> {
    const media = this.media;
    if (!media || this.busy) return;
    this.busy = true;
    $<HTMLButtonElement>('#btnRxCreate').disabled = true;
    this.showError('');
    try {
      const result = await window.duo.reactions.create({ name: $<HTMLInputElement>('#rxName').value, soundMode: this.soundMode(), thumb: await makeReactionThumb(media) });
      if (!result.ok) return this.showError(result.error);
      this.sync.addOwn(result.reaction);
      this.dropPreview();
      this.soundFile = null;
      this.videoHasAudio = false;
      $<HTMLInputElement>('#rxName').value = '';
      $<HTMLSelectElement>('#rxSoundMode').value = 'none';
    } catch (err) {
      this.showError(`Не удалось сохранить реакцию: ${(err as Error).message}`);
    } finally {
      this.busy = false;
      this.updateForm();
    }
  }
}
