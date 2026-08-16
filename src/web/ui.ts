/**
 * Everything that touches the DOM.
 *
 * Kept apart from `main.ts` so that the wiring — sockets, microphones, frame
 * timers — can be read without stepping over `document.getElementById`, and so
 * that the two can fail independently. There is no framework here because there
 * are about thirty elements, and the reactive machinery to manage thirty
 * elements is larger than thirty elements.
 */

import type { MoodReadout, SenseName, ServerMessage } from '../shared/protocol.ts';
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
}

export class Ui {
  readonly #handlers: UiHandlers;
  readonly #app = need('app');
  readonly #dot = need('dot');
  readonly #name = need('name');
  readonly #moodLabel = need('mood');
  readonly #state = need('state');
  readonly #orb = need('orb');
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

  #paintLevel(): void {
    this.#orb.style.setProperty('--level', Math.max(this.#micLevel * 0.5, this.#annaLevel).toFixed(3));
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
