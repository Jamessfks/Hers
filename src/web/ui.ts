/**
 * Everything that touches the DOM.
 *
 * Kept apart from `main.ts` so that the wiring — sockets, microphones, frame
 * timers — can be read without stepping over `document.getElementById`, and so
 * that the two can fail independently. There is no framework here because there
 * are about thirty elements, and the reactive machinery to manage thirty
 * elements is larger than thirty elements.
 */

import type {
  AvatarView,
  IntimacyView,
  MoodReadout,
  RememberedFact,
  SenseName,
  ServerMessage,
  TelegramView,
} from '../shared/protocol.ts';
import { SENSE_NAMES } from '../shared/protocol.ts';
import { PROFILE_FILES } from '../shared/profile-files.ts';
import { frontmatterValue, setFrontmatterValue } from '../shared/frontmatter.ts';
import { DEFAULT_VOICE, FEMALE_VOICES, VOICES } from '../shared/voices.ts';

/**
 * How long one of her faces stays up.
 *
 * Long enough to be seen and short enough that she is not stuck wearing it. She
 * calls `look` about as often as a person changes expression, so overlapping
 * calls are normal — each one restarts this rather than queueing.
 */
const LOOK_MS = 4200;

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
  /** Take the conversation back from whichever tab has it. */
  onClaim(): void;
  onLoadMemory(): void;
  onEditMemory(id: number, text: string): void;
  onForgetMemory(id: number): void;
  onAddMemory(text: string): void;
  /** A pasted Gemini key. Resolves to null on success, or to why not. */
  onSaveKey(key: string): Promise<string | null>;
  /**
   * A bot token. Resolves to the bot on success, or to why not.
   *
   * The username comes back because the next step is a link built from it, and
   * the page cannot build that itself — it never sees the token, and the username
   * is not in it.
   */
  onSaveBotToken(token: string): Promise<{ error?: string; username?: string; link?: string }>;
  /** Generate one of her expressions from the photograph. */
  onMakeFace(expression: string): void;
  /** Delete everything. Resolves to null on success, or to why not. */
  onReset(confirm: string): Promise<string | null>;
  /** Put closeness where the user wants it, 0-1. */
  onPinIntimacy(score: number): void;
  /** Hand closeness back to time and contact. */
  onAutoIntimacy(): void;
  /** Permission to read these folders, once. Resolves to a report or an error. */
  onScan(folders: string[]): Promise<ScanOutcomeView>;
  /** Ask what she has already been allowed to read. */
  onLoadKnowledge(): Promise<KnowledgeView>;
}

/** What the server says about the scan afterwards. */
export interface ScanOutcomeView {
  ok?: boolean;
  error?: string;
  learned?: number;
  seen?: number;
  read?: number;
  refused?: number;
  denied?: { folder: string; reason: string }[];
}

/** What she has been allowed to read, and where it makes sense to offer. */
export interface KnowledgeView {
  folders?: string[];
  scannedAt?: number;
  suggested?: string[];
}

/** What has to be typed before the delete button will do anything. */
const RESET_PHRASE = 'start over';

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
  readonly #faceList = need('face-list');
  readonly #faceStatus = need('face-status');
  /** The photograph, so a shown expression can be put back. */
  #sourceUrl: string | null = null;
  #lookTimer: ReturnType<typeof setTimeout> | null = null;
  /** The face this page asked for, so its own line can be resolved. */
  #asked: string | null = null;
  readonly #face = need<HTMLDialogElement>('face');
  readonly #dropzone = need<HTMLLabelElement>('dropzone');
  readonly #facePreview = need<HTMLImageElement>('face-preview');
  readonly #dropzoneLabel = need('dropzone-label');
  readonly #giveFace = need<HTMLButtonElement>('give-face');
  readonly #takeover = need('takeover');
  readonly #setup = need<HTMLDialogElement>('setup');
  readonly #keyInput = need<HTMLInputElement>('key-input');
  readonly #keySave = need<HTMLButtonElement>('key-save');
  readonly #keyStatus = need('key-status');
  readonly #botInput = need<HTMLInputElement>('bot-input');
  readonly #botSave = need<HTMLButtonElement>('bot-save');
  readonly #botStatus = need('bot-status');
  readonly #botNext = need('bot-next');
  readonly #botLink = need<HTMLAnchorElement>('bot-link');
  readonly #resetConfirm = need<HTMLInputElement>('reset-confirm');
  readonly #resetGo = need<HTMLButtonElement>('reset-go');
  readonly #resetStatus = need('reset-status');
  readonly #scanFolders = need('scan-folders');
  readonly #scanGo = need<HTMLButtonElement>('scan-go');
  readonly #scanStatus = need('scan-status');
  readonly #intimacyReadout = need('intimacy-readout');
  readonly #intimacyRange = need<HTMLInputElement>('intimacy-range');
  readonly #intimacyAuto = need<HTMLButtonElement>('intimacy-auto');
  readonly #memory = need<HTMLDialogElement>('memory');
  readonly #memoryList = need('memory-list');
  readonly #memorySummary = need('memory-summary');
  readonly #memoryNew = need<HTMLInputElement>('memory-new');

  readonly #senseButtons = new Map<SenseName, HTMLButtonElement>();
  /** The in-progress line per speaker, replaced until the turn closes. */
  readonly #pending = new Map<'user' | 'her', HTMLElement>();
  #profileFiles: Record<string, string> = {};
  readonly #voicePick = need<HTMLElement>('voice-pick');
  readonly #voiceSelect = need<HTMLSelectElement>('voice-select');
  #openFile = 'personality';
  #awake = false;
  /** True between clicking Save and the folder coming back. */
  #saving = false;
  #toastTimer: number | null = null;
  /** Written by two independent meters; the louder wins. */
  #micLevel = 0;
  #herLevel = 0;
  /** So a reconnect on an unconfigured server does not reopen the dialog. */
  #offeredSetup = false;
  /** Whatever she calls herself. The markup ships with a placeholder. */
  #herName = 'Anna';

  constructor(handlers: UiHandlers) {
    this.#handlers = handlers;

    /*
     * The menu edits the same text the editor is showing rather than saving on
     * its own. One writer: whatever is on screen is what Save sends, so picking
     * a voice and then typing in the file cannot produce two answers.
     */
    this.#voiceSelect.addEventListener('change', () => {
      const current = this.#openFile === 'voice' ? this.#editor.value : (this.#profileFiles.voice ?? '');
      const updated = setFrontmatterValue(current, 'voice', this.#voiceSelect.value);
      this.#profileFiles.voice = updated;
      if (this.#openFile === 'voice') this.#editor.value = updated;
    });

    for (const sense of SENSE_NAMES) {
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
    this.#giveFace.addEventListener('click', () => this.#face.showModal());
    need('memory-open').addEventListener('click', () => {
      this.#handlers.onLoadMemory();
      this.#memory.showModal();
    });

    const addMemory = () => {
      const text = this.#memoryNew.value.trim();
      if (!text) return;
      this.#memoryNew.value = '';
      this.#handlers.onAddMemory(text);
    };
    need('memory-add').addEventListener('click', addMemory);
    this.#memoryNew.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') addMemory();
    });

    need('setup-open').addEventListener('click', () => {
      void this.#loadKnowledge();
      this.#setup.showModal();
    });

    this.#scanGo.addEventListener('click', () => void this.#scan());

    this.#keySave.addEventListener('click', () => void this.#saveKey());
    this.#botSave.addEventListener('click', () => void this.#saveBotToken());
    this.#botInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void this.#saveBotToken();
    });
    this.#keyInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void this.#saveKey();
    });

    // The button stays dead until the words are typed. The server checks the
    // same thing — this is so the interface cannot invite the mistake, not so
    // the interface can prevent it.
    const armReset = () => {
      this.#resetGo.disabled = this.#resetConfirm.value.trim().toLowerCase() !== RESET_PHRASE;
    };
    this.#resetConfirm.addEventListener('input', armReset);
    this.#resetGo.addEventListener('click', () => void this.#reset());

    /*
     * Committed on release rather than on input.
     *
     * Dragging a slider fires continuously, and each step would be a message,
     * a disk write and a repaint. What the user means is where they let go.
     */
    this.#intimacyRange.addEventListener('change', () => {
      this.#handlers.onPinIntimacy(Number(this.#intimacyRange.value) / 100);
    });
    this.#intimacyAuto.addEventListener('click', () => this.#handlers.onAutoIntimacy());

    need('takeover-claim').addEventListener('click', () => {
      this.#takeover.hidden = true;
      this.#handlers.onClaim();
    });

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
        this.#setName(message.name);
        for (const [sense, on] of Object.entries(message.senses)) {
          this.setSense(sense as SenseName, on);
        }
        this.#setConfigured(message.configured, message.keyHint);
        return;

      case 'state':
        this.setState(message.state);
        return;

      case 'mood':
        this.setMood(message.mood);
        return;

      case 'name':
        this.#setName(message.name);
        return;

      case 'telegram':
        this.setTelegram(message.telegram);
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

      case 'look':
        this.showLook(message.expression);
        return;

      case 'memory':
        this.setMemory(message.facts, message.summary);
        return;

      case 'intimacy':
        this.setIntimacy(message.intimacy);
        return;

      case 'history':
        this.setHistory(message.turns);
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
  line(who: 'user' | 'her', text: string, final: boolean): void {
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

  /**
   * A picture she sent.
   *
   * The caption goes underneath, small and muted, rather than into the line
   * where her words go — it is a caption, not something she said out loud.
   *
   * Whatever arrives here is safe to show: the gallery only sends a caption a
   * person actually wrote, and sends nothing for a picture she generated. The
   * filtering used to happen here instead, which was both a second mechanism
   * for one rule and quietly wrong — it dropped lower-case captions, and
   * "laughing in the kitchen" is a perfectly good thing for a human to type.
   */
  media(url: string, kind: 'image' | 'clip', caption?: string): void {
    this.#empty.hidden = true;
    const element = this.#newLine('her');
    const said = element.querySelector('.said');
    said?.remove();

    if (kind === 'clip') {
      const video = document.createElement('video');
      video.src = url;
      video.controls = true;
      video.playsInline = true;
      element.append(video);
    } else {
      const image = document.createElement('img');
      image.src = url;
      image.alt = caption ?? `A picture from ${this.#herName}`;
      image.loading = 'lazy';
      element.append(image);
    }

    const label = (caption ?? '').trim();
    if (label) {
      const figcaption = document.createElement('p');
      figcaption.className = 'said-caption';
      figcaption.textContent = label;
      element.append(figcaption);
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

  /**
   * Puts one of her faces on screen, then puts the photograph back.
   *
   * A timed swap rather than a state she stays in, because the alternative is a
   * portrait frozen mid-laugh for the rest of the conversation. The photograph is
   * the resting state and everything returns to it, which is also what makes the
   * cut read as one person: the frame never moves.
   */
  showLook(expression: string): void {
    if (!this.#sourceUrl) return;
    if (this.#lookTimer) clearTimeout(this.#lookTimer);

    this.#still.src = `/avatar/face/${encodeURIComponent(expression)}`;
    this.#lookTimer = setTimeout(() => {
      if (this.#sourceUrl) this.#still.src = this.#sourceUrl;
      this.#lookTimer = null;
    }, LOOK_MS);
  }

  #renderFaceList(avatar: AvatarView): void {
    /*
     * Resolve this page's own line before redrawing.
     *
     * The success toast goes to every page, which is right — the face belongs to
     * her. But the "Making…" line belongs to the tab that clicked, and without
     * this it sits there indefinitely looking like the request never finished.
     */
    if (this.#asked && !avatar.making.includes(this.#asked)) {
      const done = avatar.ready.includes(this.#asked);
      this.#status(
        this.#faceStatus,
        done ? `She can look ${this.#asked} now.` : `${this.#asked} did not come back. Try again.`,
        done ? 'good' : 'bad',
      );
      this.#asked = null;
    }

    this.#faceList.replaceChildren();
    if (!avatar.hasSource) return;

    for (const name of avatar.all) {
      const ready = avatar.ready.includes(name);
      const making = avatar.making.includes(name);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'face-chip';
      button.textContent = making ? `${name}…` : name;
      button.dataset.ready = String(ready);
      button.disabled = making;
      button.title = ready
        ? `${name} exists — click to make it again`
        : `Generate ${name} from her photograph`;
      button.addEventListener('click', () => {
        this.#asked = name;
        this.#status(this.#faceStatus, `Making ${name}… this takes about ten seconds.`, 'working');
        this.#handlers.onMakeFace(name);
      });
      this.#faceList.append(button);
    }
  }

  /** Her photograph, or the orb when there is not one yet. */
  setAvatar(avatar: AvatarView): void {
    const hasSource = avatar.hasSource && Boolean(avatar.sourceUrl);

    this.#portrait.hidden = !hasSource;
    this.#orb.hidden = hasSource;
    this.#giveFace.hidden = hasSource;

    this.#renderFaceList(avatar);

    if (hasSource && avatar.sourceUrl) {
      this.#sourceUrl = avatar.sourceUrl;
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
  }

  /**
   * The conversation so far, wherever it happened.
   *
   * Replaces whatever is on screen rather than appending: this arrives on
   * connect, and a reconnect that appended would show the last hour twice.
   */
  setHistory(turns: readonly { speaker: 'user' | 'her'; text: string }[]): void {
    this.#transcript.replaceChildren(this.#empty);
    this.#pending.clear();
    this.#empty.hidden = turns.length > 0;
    for (const turn of turns) this.line(turn.speaker, turn.text, true);
  }

  /**
   * Everything she remembers, editable in place.
   *
   * A textarea per fact rather than a modal per edit: the whole point is that
   * the list reads as a list you can cross things out of, and an edit that
   * costs three clicks is an edit nobody makes.
   */
  setMemory(facts: RememberedFact[], summary: string): void {
    this.#memoryList.replaceChildren();

    if (facts.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'She has not kept anything yet.';
      this.#memoryList.append(empty);
    }

    for (const fact of facts) {
      const row = document.createElement('div');
      row.className = 'fact';

      const kind = document.createElement('span');
      kind.className = 'fact-kind';
      kind.textContent = fact.kind;

      const text = document.createElement('textarea');
      text.className = 'fact-text';
      text.rows = 1;
      text.value = fact.text;
      const grow = () => {
        text.style.height = 'auto';
        text.style.height = `${text.scrollHeight}px`;
      };
      text.addEventListener('input', grow);
      // Committed on blur rather than per keystroke: every save re-embeds the
      // sentence, and re-embedding on every letter is a request per letter.
      text.addEventListener('blur', () => {
        if (text.value.trim() && text.value !== fact.text) {
          this.#handlers.onEditMemory(fact.id, text.value);
        }
      });

      const forget = document.createElement('button');
      forget.className = 'danger';
      forget.type = 'button';
      forget.textContent = 'Forget';
      forget.addEventListener('click', () => this.#handlers.onForgetMemory(fact.id));

      row.append(kind, text, forget);
      this.#memoryList.append(row);
      grow();
    }

    this.#memorySummary.hidden = !summary;
    this.#memorySummary.textContent = summary;
  }

  /**
   * How close she is, in a sentence rather than a progress bar.
   *
   * No bar, no XP, no "next level in 12 days" as the headline — the whole design
   * of this number is that it is not a score, and an interface that renders it
   * as one invites exactly the farming the engine refuses to reward. The stage
   * is the thing; the percentage is a detail, and the days are there so the
   * slowness is honest rather than mysterious.
   */
  setIntimacy(intimacy: IntimacyView): void {
    const parts = [
      `<span class="who-you-are">${intimacy.stage}</span> · ${intimacy.percent}%`,
    ];

    if (intimacy.pinned) {
      parts.push('<span class="set-by-you">set by you</span>');
    } else if (intimacy.known > 0) {
      const days = Math.round(intimacy.days);
      parts.push(`${intimacy.known} days since you met, ${days} of them together`);
      if (intimacy.nextStage) {
        parts.push(`${intimacy.toNextStage} more before ${intimacy.nextStage}`);
      }
    } else {
      parts.push('you have not spoken yet');
    }

    this.#intimacyReadout.innerHTML = parts.join(' · ');
    // Not while they are dragging it, or the value fights the thumb.
    if (document.activeElement !== this.#intimacyRange) {
      this.#intimacyRange.value = String(intimacy.percent);
    }
    this.#intimacyAuto.hidden = !intimacy.pinned;
  }

  /** Another tab has her, and this one has stopped trying. */
  setSuperseded(superseded: boolean): void {
    this.#takeover.hidden = !superseded;
  }

  setMicLevel(level: number): void {
    this.#micLevel = level;
    this.#paintLevel();
  }

  setHerLevel(level: number): void {
    this.#herLevel = level;
    this.#paintLevel();
  }

  focusInput(): void {
    this.#input.focus();
  }

  // -------------------------------------------------------------------------

  /**
   * Sends the key and reports what happened, in place.
   *
   * The box is cleared on success and left alone on failure — a rejected key is
   * usually a key with one character wrong, and clearing the field would make
   * them paste it again to find out which.
   */
  async #saveKey(): Promise<void> {
    const key = this.#keyInput.value.trim();
    if (!key) return;

    this.#keySave.disabled = true;
    this.#status(this.#keyStatus, 'Checking it with Google…', 'working');
    const error = await this.#handlers.onSaveKey(key);
    this.#keySave.disabled = false;

    if (error) {
      this.#status(this.#keyStatus, error, 'bad');
      return;
    }
    this.#keyInput.value = '';
    this.#status(this.#keyStatus, 'Saved. Wake her.', 'good');
  }

  /**
   * Saves a bot token and then says the part only a human can finish.
   *
   * The token being right is not the end of setup, which is the unusual thing
   * about this panel: a bot may not open a conversation, and nothing in the Bot
   * API tells it which chat belongs to whoever set it up. So a successful save
   * ends by showing the link rather than saying "done", and the page waits — the
   * server pushes a `telegram` message when the chat finally speaks.
   */
  async #saveBotToken(): Promise<void> {
    const token = this.#botInput.value.trim();
    if (!token) return;

    this.#botSave.disabled = true;
    this.#status(this.#botStatus, 'Checking it with Telegram…', 'working');
    const outcome = await this.#handlers.onSaveBotToken(token);
    this.#botSave.disabled = false;

    if (outcome.error) {
      // Left in the box on purpose: a rejected token is usually one bad
      // character, and clearing it means pasting it again to find out which.
      this.#status(this.#botStatus, outcome.error, 'bad');
      return;
    }

    this.#botInput.value = '';
    this.setTelegram({
      configured: true,
      ...(outcome.username ? { username: outcome.username } : {}),
      ...(outcome.link ? { link: outcome.link } : {}),
    });
  }

  /**
   * Shows where Telegram setup has actually got to.
   *
   * Three states, and the middle one is the point of this: a token that works but
   * a chat that has not spoken yet is *not* finished, and saying "connected"
   * there would be a lie the user discovers by messaging into silence.
   */
  setTelegram(view: TelegramView): void {
    if (!view.configured) {
      this.#botNext.hidden = true;
      return;
    }

    const who = view.username ? `@${view.username}` : 'the bot';
    if (view.chatId !== undefined) {
      this.#botNext.hidden = true;
      this.#status(this.#botStatus, `${who} is talking to you. Nobody else can.`, 'good');
      return;
    }

    if (view.link) {
      this.#botLink.href = view.link;
      this.#botLink.textContent = who;
      this.#botNext.hidden = false;
    }
    // The instruction lives in `#botNext`, which is right below this line. Saying
    // it twice reads like the page is not sure whether it happened.
    this.#status(this.#botStatus, `${who} is connected, and waiting for you.`, 'working');
  }

  async #reset(): Promise<void> {
    const confirm = this.#resetConfirm.value.trim();
    this.#resetGo.disabled = true;
    this.#status(this.#resetStatus, 'Deleting…', 'working');

    const error = await this.#handlers.onReset(confirm);
    if (error) {
      this.#status(this.#resetStatus, error, 'bad');
      this.#resetGo.disabled = false;
      return;
    }

    this.#resetConfirm.value = '';
    this.#status(this.#resetStatus, 'Gone. She does not know you.', 'good');
    // The server re-sends everything; this only clears what it has no reason
    // to send — an empty transcript is an absence, not a message.
    this.#transcript.replaceChildren(this.#empty);
    this.#pending.clear();
    this.#empty.hidden = false;
  }

  /**
   * Whether she has a key, and which one.
   *
   * The first run opens the setup dialog by itself. Everything on the page is
   * inert without a key, and a first-time user staring at a wake button that
   * does nothing has no way to discover why — that used to be a line of toast
   * telling them to go and edit a file.
   */
  #setConfigured(configured: boolean, keyHint: string): void {
    this.#notice.hidden = configured;
    if (!configured) {
      this.#notice.textContent = 'She needs a Gemini API key before she can hear you.';
    }

    this.#keyInput.placeholder = keyHint ? `${keyHint} — paste a new one to replace it` : 'AIza…';

    if (!configured && !this.#offeredSetup) {
      this.#offeredSetup = true;
      if (!this.#setup.open) this.#setup.showModal();
    }
  }

  /**
   * Offers the folders, ticked by nobody.
   *
   * Deliberately unticked. A pre-ticked box is not consent, and this reads
   * somebody's private documents — the user has to do something for it to
   * happen, and if they read nothing and click nothing then nothing is read.
   */
  async #loadKnowledge(): Promise<void> {
    const view = await this.#handlers.onLoadKnowledge();
    const already = new Set(view.folders ?? []);
    const offered = view.suggested ?? [];

    this.#scanFolders.replaceChildren();
    for (const folder of offered) {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = folder;
      const name = document.createElement('span');
      name.textContent = folder.split('/').pop() ?? folder;
      const full = document.createElement('code');
      full.textContent = folder;
      label.append(box, name, full);
      this.#scanFolders.append(label);
    }

    if (already.size > 0 && view.scannedAt) {
      const when = new Date(view.scannedAt).toLocaleDateString();
      this.#status(
        this.#scanStatus,
        `Last read ${when}: ${[...already].map((f) => f.split('/').pop()).join(', ')}.`,
        'good',
      );
    }
  }

  async #scan(): Promise<void> {
    const chosen = [...this.#scanFolders.querySelectorAll<HTMLInputElement>('input:checked')].map(
      (box) => box.value,
    );
    if (chosen.length === 0) {
      this.#status(this.#scanStatus, 'Tick a folder first.', 'bad');
      return;
    }

    this.#scanGo.disabled = true;
    this.#status(this.#scanStatus, 'Reading…', 'working');
    const outcome = await this.#handlers.onScan(chosen);
    this.#scanGo.disabled = false;

    if (outcome.error && !outcome.ok) {
      this.#status(this.#scanStatus, outcome.error, 'bad');
      return;
    }

    const parts = [
      `${outcome.seen ?? 0} files seen, ${outcome.read ?? 0} read`,
      `${outcome.refused ?? 0} skipped for looking private`,
      `${outcome.learned ?? 0} things kept`,
    ];
    // A refusal is the ordinary case on macOS until access is granted, and the
    // reason from the server carries the remedy.
    for (const denial of outcome.denied ?? []) {
      parts.push(`${denial.folder.split('/').pop() ?? denial.folder}: ${denial.reason}`);
    }
    if (outcome.error) parts.push(outcome.error);
    parts.push('She will have it the next time she wakes.');

    this.#status(this.#scanStatus, parts.join(' · '), outcome.denied?.length ? 'bad' : 'good');
  }

  /**
   * Puts her name everywhere it appears, including on turns already on screen.
   *
   * She chooses it during the first wake, so the first `ready` of a fresh install
   * carries a different name from the one in the markup — and by then there may
   * already be lines in the transcript labelled with the placeholder.
   */
  #setName(name: string): void {
    const chosen = name.trim();
    if (!chosen || chosen === this.#herName) {
      this.#name.textContent = this.#herName;
      return;
    }

    this.#herName = chosen;
    this.#name.textContent = chosen;
    document.title = chosen;
    this.#still.alt = chosen;
    for (const label of this.#transcript.querySelectorAll('.line[data-who="her"] .who')) {
      label.textContent = chosen;
    }
    // Prose in the markup that names her. Marked in the HTML rather than listed
    // here, so a new sentence about her does not have to remember to come back.
    for (const spot of document.querySelectorAll('[data-her-name]')) {
      spot.textContent = chosen;
    }
  }

  #status(element: HTMLElement, message: string, kind: 'working' | 'good' | 'bad'): void {
    element.textContent = message;
    element.dataset.kind = kind;
  }

  #paintLevel(): void {
    const level = Math.max(this.#micLevel * 0.5, this.#herLevel).toFixed(3);
    this.#orb.style.setProperty('--level', level);
    this.#portrait.style.setProperty('--level', level);
  }

  #newLine(who: 'user' | 'her'): HTMLElement {
    const element = document.createElement('div');
    element.className = 'line';
    element.dataset.who = who;
    // Consecutive bubbles from the same speaker drop the name and tuck up
    // against the one above, so a three-part answer reads as one turn.
    const previous = this.#transcript.lastElementChild as HTMLElement | null;
    element.dataset.same = String(previous?.dataset?.who === who);
    element.innerHTML = '<span class="who"></span><p class="said"></p>';
    const label = element.querySelector('.who');
    if (label) label.textContent = who === 'her' ? this.#herName : 'You';
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

    const names: string[] = PROFILE_FILES.filter((name) => name in files);
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

    // Shown only on the file it writes to, and read back from that file every
    // time: someone who types a voice name by hand should see the menu agree.
    const isVoice = this.#openFile === 'voice';
    this.#voicePick.hidden = !isVoice;
    if (isVoice) this.#renderVoices(frontmatterValue(files.voice ?? '', 'voice')?.trim() ?? '');
  }

  /**
   * The menu, and whatever the file actually says.
   *
   * Offers the female voices, because she is a woman. But `voice.md` is a file
   * somebody may have edited by hand, and a menu that silently displayed
   * `Aoede` over a file reading `voice: Puck` would be lying about the thing it
   * is sitting on top of. So a voice the file names that is not on the offered
   * list is added to the menu as its own option, and stays until it is changed.
   */
  #renderVoices(chosen: string): void {
    const match = (name: string): boolean => name.toLowerCase() === chosen.toLowerCase();
    const offered = [...FEMALE_VOICES];
    if (chosen && !offered.some((voice) => match(voice.name))) {
      const known = VOICES.find((voice) => match(voice.name));
      offered.push(known ?? { name: chosen, character: 'from your file', gender: 'female' });
    }

    this.#voiceSelect.replaceChildren();
    for (const { name, character } of offered) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = `${name} — ${character}`;
      this.#voiceSelect.append(option);
    }
    this.#voiceSelect.value = offered.some((voice) => match(voice.name))
      ? (offered.find((voice) => match(voice.name))?.name ?? DEFAULT_VOICE)
      : DEFAULT_VOICE;
  }
}
