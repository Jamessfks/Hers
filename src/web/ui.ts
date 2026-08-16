/**
 * Everything that touches the DOM.
 *
 * Kept apart from `main.ts` so that the wiring — sockets, microphones, frame
 * timers — can be read without stepping over `document.getElementById`, and so
 * that the two can fail independently. There is no framework here because there
 * are about thirty elements, and the reactive machinery to manage thirty
 * elements is larger than thirty elements.
 */

import type { AvatarView, MoodReadout, SenseName, ServerMessage } from '../shared/protocol.ts';
import { PROFILE_ORDER } from './profile-order.ts';

function need<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element as T;
}

export interface UiHandlers {
  onToggleSense(sense: SenseName, on: boolean): void;
  onWake(): void;
  onSay(text: string): void;
  onLoadProfile(): void;
  onSaveProfile(files: Record<string, string>): void;
  onUploadFace(file: File): void;
  onRenderGesture(gesture: string): void;
}

export class Ui {
  readonly #handlers: UiHandlers;
  readonly #app = need('app');
  readonly #dot = need('dot');
  readonly #name = need('name');
  readonly #moodLabel = need('mood');
  readonly #state = need('state');
  readonly #wake = need<HTMLButtonElement>('wake');
  readonly #hint = need('hint');
  readonly #transcript = need('transcript');
  readonly #empty = need('empty');
  readonly #previews = need('previews');
  readonly #toast = need('toast');
  readonly #notice = need('notice');
  readonly #settings = need<HTMLDialogElement>('settings');
  readonly #tabs = need('tabs');
  readonly #editor = need<HTMLTextAreaElement>('editor');
  readonly #saved = need('saved');
  readonly #input = need<HTMLInputElement>('input');
  readonly #orb = need('orb');
  readonly #portrait = need('portrait');
  readonly #still = need<HTMLImageElement>('portrait-still');
  readonly #clip = need<HTMLVideoElement>('portrait-clip');
  readonly #face = need<HTMLDialogElement>('face');
  readonly #dropzone = need<HTMLLabelElement>('dropzone');
  readonly #facePreview = need<HTMLImageElement>('face-preview');
  readonly #dropzoneLabel = need('dropzone-label');
  readonly #gestureList = need('gesture-list');
  readonly #spend = need('spend');

  readonly #senseButtons = new Map<SenseName, HTMLButtonElement>();
  /** The in-progress line per speaker, replaced until the turn closes. */
  readonly #pending = new Map<'user' | 'anna', HTMLElement>();
  #profileFiles: Record<string, string> = {};
  #openFile = 'personality';
  #awake = false;
  /** True between clicking Save and the folder coming back. */
  #saving = false;
  #toastTimer: number | null = null;
  /** Written by two independent meters; the louder wins. */
  #micLevel = 0;
  #annaLevel = 0;
  #avatar: AvatarView | null = null;
  /** Queued so two gestures in quick succession play in order, not on top. */
  #moving = false;

  constructor(handlers: UiHandlers) {
    this.#handlers = handlers;

    for (const sense of ['hearing', 'sight', 'screen'] as const) {
      const button = need<HTMLButtonElement>(`sense-${sense}`);
      this.#senseButtons.set(sense, button);
      button.addEventListener('click', () => {
        this.#handlers.onToggleSense(sense, button.getAttribute('aria-pressed') !== 'true');
      });
    }

    this.#wake.addEventListener('click', () => this.#handlers.onWake());

    need<HTMLFormElement>('composer').addEventListener('submit', (event) => {
      event.preventDefault();
      const text = this.#input.value.trim();
      if (!text) return;
      this.#input.value = '';
      this.#handlers.onSay(text);
    });

    need('settings-open').addEventListener('click', () => {
      this.#handlers.onLoadProfile();
      this.#settings.showModal();
    });

    need('save').addEventListener('click', () => {
      this.#profileFiles[this.#openFile] = this.#editor.value;
      this.#saving = true;
      this.#handlers.onSaveProfile(this.#profileFiles);
      this.#saved.textContent = 'Saving…';
    });

    need('face-open').addEventListener('click', () => this.#face.showModal());

    const picker = need<HTMLInputElement>('face-file');
    picker.addEventListener('change', () => {
      const file = picker.files?.[0];
      if (file) this.#handlers.onUploadFace(file);
      // Cleared so choosing the same file twice still fires a change event.
      picker.value = '';
    });

    for (const event of ['dragenter', 'dragover'] as const) {
      this.#dropzone.addEventListener(event, (drag) => {
        drag.preventDefault();
        this.#dropzone.dataset.over = 'true';
      });
    }
    for (const event of ['dragleave', 'drop'] as const) {
      this.#dropzone.addEventListener(event, () => {
        this.#dropzone.dataset.over = 'false';
      });
    }
    this.#dropzone.addEventListener('drop', (drag) => {
      drag.preventDefault();
      const file = drag.dataTransfer?.files?.[0];
      if (file) this.#handlers.onUploadFace(file);
    });

    // A clip that has ended, stalled or failed all mean the same thing here:
    // stop showing it and let the still back through.
    for (const event of ['ended', 'error', 'stalled'] as const) {
      this.#clip.addEventListener(event, () => this.#settle());
    }
    this.#clip.addEventListener('playing', () => {
      this.#portrait.dataset.moving = 'true';
    });

    this.#editor.addEventListener('input', () => {
      this.#profileFiles[this.#openFile] = this.#editor.value;
      this.#saved.textContent = '';
    });
  }

  // -------------------------------------------------------------------------
  // Server messages
  // -------------------------------------------------------------------------

  apply(message: ServerMessage): void {
    switch (message.t) {
      case 'ready':
        this.#name.textContent = 'Anna';
        for (const [sense, on] of Object.entries(message.senses)) {
          this.setSense(sense as SenseName, on);
        }
        if (!message.configured) {
          this.toast(
            'No Gemini API key. Put GEMINI_API_KEY in a .env file next to package.json and restart.',
            0,
          );
        }
        return;

      case 'state':
        this.setState(message.state);
        return;

      case 'mood':
        this.setMood(message.mood);
        return;

      case 'transcript':
        this.line(message.who, message.text, message.final);
        return;

      case 'sense':
        this.setSense(message.sense, message.on);
        return;

      case 'show':
        this.media(message.url, message.kind, message.caption);
        return;

      case 'trouble':
        this.toast(message.message);
        return;

      case 'profile':
        this.#setProfile(message.files);
        return;

      case 'avatar':
        this.setAvatar(message.avatar);
        return;

      case 'move':
        this.move(message.gesture);
        return;

      case 'interrupted':
        return;

      default:
        return;
    }
  }

  // -------------------------------------------------------------------------

  setState(state: string): void {
    this.#app.dataset.state = state;
    this.#state.textContent = state;
    this.#awake = state !== 'asleep' && state !== 'error';
    this.#wake.textContent = this.#awake ? 'Let her rest' : 'Wake her';
    this.#wake.dataset.awake = String(this.#awake);
    this.#dot.title = state;
  }

  setMood(mood: MoodReadout): void {
    this.#moodLabel.textContent = mood.label;
    // Valence picks the hue: cool blue when she is low, violet in the middle,
    // warm rose when she is bright. Energy decides how much of it there is.
    const hue = Math.round(216 + mood.current.valence * 62);
    const lift = (mood.current.energy + 1) / 2;
    document.documentElement.style.setProperty('--mood-hue', String(hue));
    document.documentElement.style.setProperty('--mood-lift', lift.toFixed(2));
  }

  setSense(sense: SenseName, on: boolean): void {
    const button = this.#senseButtons.get(sense);
    button?.setAttribute('aria-pressed', String(on));
    const any = [...this.#senseButtons.values()].some(
      (each) => each.getAttribute('aria-pressed') === 'true',
    );
    this.#previews.hidden = !(
      this.#senseButtons.get('sight')?.getAttribute('aria-pressed') === 'true' ||
      this.#senseButtons.get('screen')?.getAttribute('aria-pressed') === 'true'
    );
    this.#hint.textContent = any
      ? 'She is here. She will speak first if it goes quiet.'
      : 'Turn on a sense and she can hear you.';
  }

  attachPreview(which: 'camera' | 'screen', video: HTMLVideoElement, show: boolean): void {
    const figure = need(`preview-${which}`);
    figure.hidden = !show;
    if (show && video.parentElement !== figure) figure.prepend(video);
  }

  /**
   * Adds or updates a line.
   *
   * A non-final line replaces the previous non-final line from the same speaker
   * rather than appending, because live transcription revises itself constantly
   * and appending each revision produces a stuttering wall of near-duplicates.
   */
  line(who: 'user' | 'anna', text: string, final: boolean): void {
    this.#empty.hidden = true;
    const existing = this.#pending.get(who);
    const element = existing ?? this.#newLine(who);

    const said = element.querySelector('.said');
    if (said) said.textContent = text;
    element.dataset.pending = String(!final);

    if (final) this.#pending.delete(who);
    else this.#pending.set(who, element);

    this.#scroll();
  }

  media(url: string, kind: 'image' | 'clip', caption?: string): void {
    this.#empty.hidden = true;
    const element = this.#newLine('anna');
    const said = element.querySelector('.said');
    if (said) said.textContent = caption ?? '';

    if (kind === 'clip') {
      const video = document.createElement('video');
      video.src = url;
      video.controls = true;
      video.playsInline = true;
      element.append(video);
    } else {
      const image = document.createElement('img');
      image.src = url;
      image.alt = caption ?? 'A picture from Anna';
      image.loading = 'lazy';
      element.append(image);
    }
    this.#scroll();
  }

  /**
   * A passing message. `duration` of 0 makes it a standing notice instead,
   * which lives in the layout rather than floating over the controls.
   */
  toast(message: string, duration = 5200): void {
    if (duration === 0) {
      this.#notice.textContent = message;
      this.#notice.hidden = false;
      return;
    }
    this.#toast.textContent = message;
    this.#toast.dataset.show = 'true';
    if (this.#toastTimer !== null) clearTimeout(this.#toastTimer);
    this.#toastTimer = window.setTimeout(() => {
      this.#toast.dataset.show = 'false';
    }, duration);
  }

  /** The photograph and which movements exist. */
  setAvatar(avatar: AvatarView): void {
    this.#avatar = avatar;
    const hasSource = avatar.hasSource && Boolean(avatar.sourceUrl);

    this.#portrait.hidden = !hasSource;
    this.#orb.hidden = hasSource;

    if (hasSource && avatar.sourceUrl) {
      if (this.#still.getAttribute('src') !== avatar.sourceUrl) {
        this.#still.src = avatar.sourceUrl;
        this.#facePreview.src = avatar.sourceUrl;
      }
      this.#facePreview.hidden = false;
      this.#dropzoneLabel.hidden = true;
      if (avatar.width > 0 && avatar.height > 0) {
        this.#portrait.style.setProperty(
          '--portrait-ratio',
          String(avatar.width / avatar.height),
        );
      }
    } else {
      this.#facePreview.hidden = true;
      this.#dropzoneLabel.hidden = false;
    }

    this.#spend.textContent = avatar.configured
      ? `$${avatar.spentUsd.toFixed(2)} of $${avatar.budgetUsd.toFixed(2)}`
      : 'no Hedra key';
    this.#renderGestureList(avatar);
  }

  /** Cuts to a gesture clip, then back to the still when it finishes. */
  move(gesture: string): void {
    if (!this.#avatar?.ready.includes(gesture) || this.#moving) return;
    this.#moving = true;
    this.#clip.src = `/avatar/clips/${encodeURIComponent(gesture)}`;
    void this.#clip.play().catch(() => this.#settle());
  }

  setMicLevel(level: number): void {
    this.#micLevel = level;
    this.#paintLevel();
  }

  setAnnaLevel(level: number): void {
    this.#annaLevel = level;
    this.#paintLevel();
  }

  focusInput(): void {
    this.#input.focus();
  }

  // -------------------------------------------------------------------------

  #settle(): void {
    this.#portrait.dataset.moving = 'false';
    this.#moving = false;
  }

  #renderGestureList(avatar: AvatarView): void {
    this.#gestureList.replaceChildren();
    for (const gesture of avatar.all) {
      const ready = avatar.ready.includes(gesture);
      const rendering = avatar.rendering.includes(gesture);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'gesture';
      button.dataset.ready = String(ready);
      button.dataset.rendering = String(rendering);
      button.disabled = ready || rendering || !avatar.configured;
      button.innerHTML = `<span>${gesture.replace('_', ' ')}</span><span class="mark"></span>`;
      const mark = button.querySelector('.mark');
      if (mark) mark.textContent = ready ? '●' : rendering ? 'rendering' : 'render';

      if (ready) {
        // A rendered gesture is worth being able to look at.
        button.disabled = false;
        button.addEventListener('click', () => this.move(gesture));
        button.title = 'Play it';
      } else if (!button.disabled) {
        button.addEventListener('click', () => this.#handlers.onRenderGesture(gesture));
        button.title = 'Render this one — takes a few minutes and costs money';
      }
      this.#gestureList.append(button);
    }
  }

  #paintLevel(): void {
    const level = Math.max(this.#micLevel * 0.5, this.#annaLevel).toFixed(3);
    this.#orb.style.setProperty('--level', level);
    this.#portrait.style.setProperty('--level', level);
  }

  #newLine(who: 'user' | 'anna'): HTMLElement {
    const element = document.createElement('div');
    element.className = 'line';
    element.dataset.who = who;
    element.innerHTML = '<span class="who"></span><p class="said"></p>';
    const label = element.querySelector('.who');
    if (label) label.textContent = who === 'anna' ? 'Anna' : 'You';
    this.#transcript.append(element);
    return element;
  }

  #scroll(): void {
    // Only follow when they are already at the bottom: yanking the view down
    // while someone is reading back a message is worse than a missed line.
    const distance =
      this.#transcript.scrollHeight - this.#transcript.scrollTop - this.#transcript.clientHeight;
    if (distance < 120) this.#transcript.scrollTop = this.#transcript.scrollHeight;
  }

  #setProfile(files: Record<string, string>): void {
    this.#profileFiles = files;
    this.#renderProfile();
  }

  #renderProfile(): void {
    const files = this.#profileFiles;
    // Only claim to have saved when a save is what brought this back. Opening
    // the editor and being told "Saved." is a small lie that makes the label
    // useless for the one thing it is for.
    this.#saved.textContent = this.#saving ? 'Saved.' : '';
    this.#saving = false;
    this.#tabs.replaceChildren();

    const names: string[] = PROFILE_ORDER.filter((name) => name in files);
    if (!names.includes(this.#openFile)) this.#openFile = names[0] ?? '';

    for (const name of names) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.textContent = name;
      tab.setAttribute('aria-selected', String(name === this.#openFile));
      tab.addEventListener('click', () => {
        this.#profileFiles[this.#openFile] = this.#editor.value;
        this.#openFile = name;
        this.#renderProfile();
      });
      this.#tabs.append(tab);
    }

    this.#editor.value = files[this.#openFile] ?? '';
  }
}
