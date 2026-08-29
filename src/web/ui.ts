/**
 * Everything that touches the DOM.
 *
 * Kept apart from `main.ts` so that the wiring — sockets, microphones, frame
 * timers — can be read without stepping over `document.getElementById`, and so
 * that the two can fail independently. There is no framework here because there
 * are a handful of elements, and the reactive machinery to manage a handful of
 * elements is larger than a handful of elements.
 */

import type { IntimacyView, MoodReadout, ServerMessage, TelegramView } from '../shared/protocol.ts';

function need<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element as T;
}

export interface UiHandlers {
  onWake(): void;
  /** Take the conversation back from whichever tab has it. */
  onClaim(): void;
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
  /** Delete everything. Resolves to null on success, or to why not. */
  onReset(confirm: string): Promise<string | null>;
}

/** What has to be typed before the delete button will do anything. */
const RESET_PHRASE = 'start over';

/**
 * What the interface says before she has a name.
 *
 * The tab has to say something and so does a sentence about her, so they say
 * the product's name and a pronoun. The header says nothing at all, which is
 * the honest shape of the answer: there is no name there yet.
 */
const UNNAMED_TITLE = 'Hers';

export class Ui {
  readonly #handlers: UiHandlers;
  readonly #app = need('app');
  readonly #dot = need('dot');
  readonly #name = need('name');
  readonly #moodLabel = need('mood');
  readonly #state = need('state');
  readonly #hint = need('hint');
  readonly #toast = need('toast');
  readonly #notice = need('notice');
  readonly #orb = need<HTMLButtonElement>('orb');

  /*
   * How much of her voice reaches the orb, given what the machine asked for.
   *
   * The stylesheet's reduced-motion block only sets `transition-duration` to
   * 0.01ms. That strips the easing off the amplitude and leaves the excursion
   * exactly as large, snapping instead of moving — which is worse than what it
   * replaced, not better, and it never reached this at all because the scale is
   * written from here in JavaScript rather than declared in CSS.
   *
   * MDN's guidance is to substitute a muted alternative rather than delete the
   * signal, and the signal is that she is talking, which is the entire job of
   * the orb. A fifth of the travel still reads as breathing and is too small to
   * be the kind of large-object scaling that triggers vestibular symptoms.
   *
   * The parentheses are not optional in `matchMedia`; without them the query
   * silently never matches.
   */
  readonly #calm = window.matchMedia('(prefers-reduced-motion: reduce)');
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

  #awake = false;
  #toastTimer: number | null = null;
  /** Written by two independent meters; the louder wins. */
  #micLevel = 0;
  #herLevel = 0;
  /** So a reconnect on an unconfigured server does not reopen the dialog. */
  #offeredSetup = false;
  /** Whatever she calls herself, or empty until she has chosen. */
  #herName = '';

  constructor(handlers: UiHandlers) {
    this.#handlers = handlers;

    /*
     * Tapping her is the only way in, and it has to be a real gesture.
     *
     * `player.unlock()` will not run outside one — every browser requires a
     * user gesture before audio may play — and v1 had two affordances racing
     * for it, a Wake button and a hearing toggle. Whichever the user pressed
     * first was the one that unlocked audio, and pressing the other one first
     * gave a companion who talked silently. One target removes the race, and
     * it is the thing on the screen that already looks like her.
     */
    this.#orb.addEventListener('click', () => this.#handlers.onWake());

    need('setup-open').addEventListener('click', () => {
      this.#setup.showModal();
    });

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

    need('takeover-claim').addEventListener('click', () => {
      this.#takeover.hidden = true;
      this.#handlers.onClaim();
    });

    this.#calm.addEventListener('change', () => this.#paintLevel());
  }

  // -------------------------------------------------------------------------
  // Server messages
  // -------------------------------------------------------------------------

  apply(message: ServerMessage): void {
    switch (message.t) {
      case 'ready':
        this.#setName(message.named ? message.name : '');
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

      case 'trouble':
        this.toast(message.message);
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
    this.#orb.dataset.awake = String(this.#awake);
    this.#orb.setAttribute('aria-label', this.#awake ? 'Let her rest' : 'Wake her');
    this.#dot.title = state;
  }

  setMood(mood: MoodReadout): void {
    this.#moodLabel.textContent = mood.label;
    // Valence picks the hue, and it is an OKLCh angle now rather than an HSL
    // one: 154 is a green, 216 the blue she sits at when she is level, 278 a
    // violet. The space matters more than the numbers. OKLCh lightness is
    // perceptually uniform, so 53% means the same brightness at every one of
    // those angles, which is what lets the stylesheet promise white on
    // `--accent` above 4.5:1 across the whole range instead of measuring 1.87:1
    // at the low end. Energy still moves the accent, by 4% of lightness rather
    // than 7% — the old span took the contrast floor with it.
    const hue = Math.round(216 + mood.current.valence * 62);
    const lift = (mood.current.energy + 1) / 2;
    document.documentElement.style.setProperty('--mood-hue', String(hue));
    document.documentElement.style.setProperty('--mood-lift', lift.toFixed(2));
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
   * How close she is, in a sentence rather than a progress bar.
   *
   * No bar, no XP, no "next level in 12 days" as the headline — the whole design
   * of this number is that it is not a score, and an interface that renders it
   * as one invites exactly the farming the engine refuses to reward. The stage
   * is the thing; the percentage is a detail, and the days are there so the
   * slowness is honest rather than mysterious.
   */

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
  }

  /**
   * Whether she has a key, and which one.
   *
   * A page with no key opens something by itself. Everything here is inert
   * without one, and a first-time user staring at a wake button that does
   * nothing has no way to discover why — that used to be a line of toast telling
   * them to go and edit a file.
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

  /**
   * Puts her name in the header.
   *
   * She chooses it during the first wake, so the first `ready` of a fresh install
   * carries no name at all. An empty string is a real answer and not a failure:
   * she has not got a name yet. The page used to ship the placeholder in its
   * markup and print `Anna` in the header and the tab title from the first
   * frame, which meant a companion who had not chosen a name yet was introduced
   * under one anyway. So nothing is drawn where the name goes until she has
   * chosen it.
   */
  #setName(name: string): void {
    const chosen = name.trim();
    if (chosen === this.#herName) return;

    this.#herName = chosen;
    this.#name.textContent = chosen;
    document.title = chosen || UNNAMED_TITLE;
    // Prose in the markup that names her. Marked in the HTML rather than listed
    // here, so a new sentence about her does not have to remember to come back.
    for (const spot of document.querySelectorAll('[data-her-name]')) {
      spot.textContent = chosen || 'She';
    }
  }

  #status(element: HTMLElement, message: string, kind: 'working' | 'good' | 'bad'): void {
    element.textContent = message;
    element.dataset.kind = kind;
  }

  #paintLevel(): void {
    const heard = Math.max(this.#micLevel * 0.5, this.#herLevel);
    const level = (this.#calm.matches ? heard * 0.2 : heard).toFixed(3);
    this.#orb.style.setProperty('--level', level);
  }
}
