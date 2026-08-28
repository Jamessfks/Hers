/**
 * The first run: eight cards, seven of which are about her.
 *
 * ## Why seven questions
 *
 * Because she is made of seven things, and this asks about each one exactly
 * once. Six of them are the files in her profile folder, in the order the editor
 * shows them — personality, identity, voice, mood, relationship, boundaries —
 * and the seventh is the photograph, which is the one part of her that is
 * deliberately not prose. There is no eighth question because there is nothing
 * else to ask about; there are no fewer because leaving one out would mean one
 * file in **Who she is** that nobody has ever been introduced to.
 *
 * That is also the argument against the number the competition uses. Eleven
 * steps is eleven only because somebody stopped there — it does not correspond
 * to anything the product is made of, so a step can be added or dropped without
 * any of them being wrong. Seven can be checked: open the settings dialog
 * afterwards and count the tabs.
 *
 * The eighth card is not a question. It is the one thing this wizard refuses to
 * ask — her name — and the reason, which is the feature.
 *
 * ## What it will not do
 *
 * **It will not name her.** She does that herself, on the first conversation,
 * once, and `Brain.ensureNamed` is the only thing allowed to write it. A wizard
 * that asked would be taking the single irreversible decision she gets to make
 * about herself and turning it into a text field.
 *
 * **It will not block anybody.** Every step skips, skipping restores what
 * shipped, closing at any point is a valid ending, and the profile that comes
 * out the other side of the shortest possible path through this is byte-for-byte
 * the profile that comes out of never opening it — plus one date. See
 * `shared/wizard.ts`, which is where that promise is actually kept.
 */

import {
  ABSENCE,
  REFUSALS,
  TEMPERAMENTS,
  TRAITS,
  VOICE_CHOICES,
  WANTS,
  applyWizard,
  draftToAnswers,
  emptyDraft,
  retellIdentity,
} from '../shared/wizard.ts';
import type { WizardAnswers, WizardChoice } from '../shared/wizard.ts';
import { frontmatterValue, parseProfileFile } from '../shared/frontmatter.ts';

/** Local copy rather than an import from `ui.ts`, which imports this. */
function need<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element as T;
}

export interface WizardHandlers {
  /** The files that changed, on their way to `profile.save`. */
  onSave(files: Record<string, string>): void;
  /** A photograph, on its way to `POST /api/avatar`. */
  onUploadFace(file: File): void;
  /** A pasted Gemini key. Resolves to null on success, or to why not. */
  onSaveKey(key: string): Promise<string | null>;
  /**
   * The wizard is over. `meet` is true only when it ended on the button that
   * says so and she has a key to wake with — Escape and Close are exits, not
   * introductions.
   */
  onDone(outcome: { meet: boolean }): void;
}

/** One card. The panel is built once and kept, so Back does not lose an answer. */
interface Step {
  id: string;
  title: string;
  note: string;
  panel: HTMLElement;
  /** Put this step back the way it shipped. What Skip means. */
  clear(): void;
}

/** How many of the cards are questions. The last one is not. */
const QUESTIONS = 7;

export class Wizard {
  readonly #handlers: WizardHandlers;
  readonly #dialog = need<HTMLDialogElement>('wizard');
  readonly #title = need('wizard-title');
  readonly #note = need('wizard-note');
  readonly #body = need('wizard-body');
  readonly #pips = need('wizard-pips');
  readonly #count = need('wizard-count');
  readonly #close = need<HTMLButtonElement>('wizard-close');
  readonly #back = need<HTMLButtonElement>('wizard-back');
  readonly #skip = need<HTMLButtonElement>('wizard-skip');
  readonly #next = need<HTMLButtonElement>('wizard-next');

  #steps: Step[] = [];
  #index = 0;
  /** The folder as it was when this opened. What the answers are applied to. */
  #files: Readonly<Record<string, string>> = {};
  /** Offered once per page load, and once more if everything is deleted. */
  #shown = false;
  /** Set on the way out so the `close` event does not save a second time. */
  #closing = false;
  #configured = false;

  /*
   * Every answer, in one object, replaced wholesale when the wizard opens.
   *
   * It used to be nine separate fields, and four of the seven cards rebuilt
   * their controls without clearing the state behind them — so a second run
   * after **Start over** carried the previous person's answers into the new
   * folder while every control on screen was drawn empty. See `WizardDraft`.
   */
  #draft = emptyDraft();

  /** Elements the key card owns, built only when there is no key yet. */
  #keyInput: HTMLInputElement | null = null;
  #facePreview: HTMLImageElement | null = null;
  #faceLabel: HTMLElement | null = null;

  #fieldId = 0;

  constructor(handlers: WizardHandlers) {
    this.#handlers = handlers;

    this.#back.addEventListener('click', () => this.#go(this.#index - 1));
    this.#skip.addEventListener('click', () => {
      this.#steps[this.#index]?.clear();
      this.#go(this.#index + 1);
    });
    this.#next.addEventListener('click', () => {
      if (this.#index >= this.#steps.length - 1) this.#finish(true);
      else this.#go(this.#index + 1);
    });

    /*
     * Every way out saves rather than discards.
     *
     * Somebody who answered three cards and then shut the dialog meant those
     * three answers, and throwing them away because of *how* they left would be
     * the rudest available reading of it. It is also what makes "this asks once"
     * true however it ended: the date goes in, so the wizard has run.
     *
     * Both exits are hooked directly, and there is deliberately no listener on
     * `close`. Measured: `close` is a *queued* element task, and in a page the
     * browser considers hidden the dialog closed and the event never arrived —
     * three answers and the date were dropped. A listener that does not run in
     * the one condition it exists for is not a backstop, it is a comment that
     * reads like one, so it is gone. `cancel` is dispatched synchronously rather
     * than queued, which is why Escape can be caught at all. Nothing else closes
     * this dialog: {@link #finish} is the only caller of `close()`, and
     * `#closing` keeps it idempotent.
     */
    this.#close.addEventListener('click', () => this.#finish(false));
    this.#dialog.addEventListener('cancel', () => this.#finish(false));
  }

  /** Whether it has been put in front of somebody yet. */
  get shown(): boolean {
    return this.#shown;
  }

  /** After everything has been deleted, the next fresh profile gets it again. */
  forget(): void {
    this.#shown = false;
  }

  /**
   * Opens it, on a folder that has never been used.
   *
   * The files come in with it because every answer is an edit to one of them,
   * and the wizard edits the copy it was handed rather than re-reading — the
   * server sent these a moment ago and nothing else is writing to that folder.
   */
  offer(files: Readonly<Record<string, string>>, configured: boolean): void {
    if (this.#shown) return;
    this.#shown = true;
    this.#closing = false;
    // Every answer, gone. This is the whole fix for a second run carrying the
    // first person's choices, and it is here rather than in the cards because
    // this is the one door every run comes through.
    this.#draft = emptyDraft();
    this.#files = files;
    this.#configured = configured;
    this.#steps = this.#build();
    // Shown before the first card is drawn, not after. `showModal` moves the
    // focus itself and scrolls to wherever it landed, so a card laid out while
    // the dialog was still closed opened with its first two lines already
    // scrolled up under the sticky heading.
    if (!this.#dialog.open) this.#dialog.showModal();
    this.#go(0);
  }

  /** A key arrived while this was open, so the last card stops asking for one. */
  setConfigured(configured: boolean): void {
    if (configured === this.#configured) return;
    this.#configured = configured;
    if (this.#keyInput) this.#keyInput.closest('.wizard-key')?.setAttribute('hidden', '');
  }

  /** Her photograph landed. Show it where it was dropped. */
  setAvatar(sourceUrl: string | null): void {
    if (!this.#facePreview || !this.#faceLabel) return;
    this.#facePreview.hidden = !sourceUrl;
    this.#faceLabel.hidden = Boolean(sourceUrl);
    if (sourceUrl) this.#facePreview.src = sourceUrl;
  }

  // -------------------------------------------------------------------------
  // Moving between cards
  // -------------------------------------------------------------------------

  #go(index: number): void {
    const wanted = Math.max(0, Math.min(this.#steps.length - 1, index));
    this.#index = wanted;
    const step = this.#steps[wanted];
    if (!step) return;

    this.#title.textContent = step.title;
    this.#note.textContent = step.note;
    this.#body.replaceChildren(step.panel);

    const last = wanted === this.#steps.length - 1;
    this.#back.hidden = wanted === 0;
    this.#skip.hidden = last;
    this.#next.textContent = last ? 'Meet her' : 'Next';
    this.#count.textContent = last ? '' : `${wanted + 1} of ${QUESTIONS}`;
    this.#paintPips();

    // The heading takes focus rather than the first control: it is what changed,
    // it is what a screen reader should read out, and Tab from here reaches the
    // step in the order it is written. Without `preventScroll` the browser
    // scrolls the heading to the top of the box it is already stuck to, which
    // moves the card under it by the height of the heading.
    this.#title.focus({ preventScroll: true });
    this.#dialog.scrollTop = 0;
  }

  #paintPips(): void {
    this.#pips.replaceChildren();
    for (let step = 0; step < QUESTIONS; step += 1) {
      const pip = document.createElement('span');
      pip.className = 'wizard-pip';
      pip.dataset.done = String(step <= this.#index);
      this.#pips.append(pip);
    }
  }

  /**
   * Writes the answers and gets out of the way.
   *
   * One save, at the end, rather than a save per card. A wizard that wrote as it
   * went would leave a half-answered profile behind if somebody wandered off
   * mid-way, and would have to explain which half.
   */
  #finish(intentional: boolean): void {
    if (this.#closing) return;
    this.#closing = true;
    const changed = applyWizard(this.#files, draftToAnswers(this.#draft), today());
    if (Object.keys(changed).length > 0) this.#handlers.onSave(changed);
    if (this.#dialog.open) this.#dialog.close();
    this.#handlers.onDone({ meet: intentional && this.#configured });
  }


  // -------------------------------------------------------------------------
  // The cards
  // -------------------------------------------------------------------------

  #build(): Step[] {
    return [
      this.#traitsStep(),
      this.#identityStep(),
      this.#voiceStep(),
      this.#moodStep(),
      this.#relationshipStep(),
      this.#boundariesStep(),
      this.#faceStep(),
      this.#doneStep(),
    ];
  }

  #traitsStep(): Step {
    const panel = document.createElement('div');
    panel.className = 'wizard-panel';
    panel.append(this.#picks(TRAITS, this.#draft.traits));

    return {
      id: 'personality',
      title: 'How she is with you',
      note:
        'She ships warm, dry and hard to embarrass. Anything you tick is a line in her file, and the line is underneath it, so you can read what she will be told before you choose it. Skip any of these; skipping leaves her exactly as she ships. This asks once. About four minutes.',
      panel,
      clear: () => untick(panel, this.#draft.traits),
    };
  }

  /**
   * The three facts, and the paragraph that states them.
   *
   * The paragraph is not decoration here — it is the half Gemini reads, and it
   * opens "You were born in Oakland to parents who moved from Chengdu". Typing
   * "Lisbon, Portugal" into the field above it and pressing Next used to leave
   * exactly that contradiction on disk, with a hint underneath warning that it
   * would. A warning that the interface is about to break the character unless
   * the user rewrites four paragraphs by hand is a bug with a label on it.
   *
   * So the fields drive the sentences that name them, live, and the box shows
   * the result as it changes. The moment somebody edits the box themselves it
   * stops rewriting and stays theirs — {@link retellIdentity} does the surgery
   * and only ever against prose this project wrote.
   */
  #identityStep(): Step {
    const identity = this.#files.identity ?? '';
    const age = frontmatterValue(identity, 'age') ?? '';
    const ethnicity = frontmatterValue(identity, 'ethnicity') ?? '';
    const from = frontmatterValue(identity, 'from') ?? '';
    const past = parseProfileFile(identity).body;
    const shipped = { age, ethnicity, from };
    this.#draft.identity = { age, ethnicity, from, past: '' };

    const panel = document.createElement('div');
    panel.className = 'wizard-panel';

    /** True while the box still shows something this wizard put there. */
    let mine = true;

    const retell = (): void => {
      if (!mine) return;
      const retold = retellIdentity(past, this.#draft.identity, shipped);
      pastArea.value = retold;
      // Only counts as an answer once it differs from what shipped; otherwise a
      // skipped card would send the body back and defeat the write-nothing rule.
      this.#draft.identity.past = retold === past ? '' : retold;
    };

    const ageInput = this.#text(age, (value) => {
      this.#draft.identity.age = value;
      retell();
    });
    const ethnicityInput = this.#text(ethnicity, (value) => {
      this.#draft.identity.ethnicity = value;
      retell();
    });
    const fromInput = this.#text(from, (value) => {
      this.#draft.identity.from = value;
      retell();
    });

    const row = document.createElement('div');
    row.className = 'wizard-row';
    row.append(
      this.#field('Age', ageInput),
      this.#field('Ethnicity', ethnicityInput),
      this.#field('Where she is from', fromInput),
    );

    const pastArea = this.#area(past, (value) => {
      mine = false;
      this.#draft.identity.past = value;
    });
    pastArea.rows = 9;

    panel.append(
      row,
      this.#field(
        'What she has been told about her past',
        pastArea,
        'This follows the three fields above — change one and watch the sentence that mentions it change with it. Write in here and it stops following and stays yours. Emptying it leaves her past alone rather than deleting it.',
      ),
    );

    return {
      id: 'identity',
      title: 'Where she is from',
      note: 'Twenty-six, Chinese-American, Oakland. None of it is load-bearing and all of it is a placeholder somebody else picked.',
      panel,
      clear: () => {
        ageInput.value = age;
        ethnicityInput.value = ethnicity;
        fromInput.value = from;
        pastArea.value = past;
        mine = true;
        this.#draft.identity = { age, ethnicity, from, past: '' };
      },
    };
  }

  /**
   * Four described voices, not fourteen listed ones.
   *
   * This card used to be a `<select>` of Google's satellite codenames with
   * Google's one-word adjectives beside them — `Vindemiatrix — Gentle` — under a
   * hint conceding they were "the only ones there are". On the card about how
   * she sounds, that hands a stranger a vendor's parts list, which is exactly
   * what the temperament card two steps later refuses to do with five numbers.
   *
   * So it is built the same way that one is: a line about how she sounds, and
   * the name it writes kept out of the way in the file where it belongs. The
   * full thirty are still reachable — the voice tab of **Who she is** has the
   * menu, and `voice.md` takes any of them typed by hand.
   */
  #voiceStep(): Step {
    const file = this.#files.voice ?? '';
    const chosen = frontmatterValue(file, 'voice')?.trim() ?? '';
    const pace = frontmatterValue(file, 'pace') ?? '';
    this.#draft.voice = { voice: '', pace };

    const panel = document.createElement('div');
    panel.className = 'wizard-panel';

    const list = document.createElement('div');
    list.className = 'wizard-choices';
    const inputs: HTMLInputElement[] = [];
    for (const option of VOICE_CHOICES) {
      const { row, input } = this.#choice('radio', 'wizard-voice', option.label, option.line);
      input.value = option.id;
      // Whatever the file already says wins the initial state, so a profile that
      // has been edited by hand does not silently disagree with this card.
      input.checked = option.voice.toLowerCase() === chosen.toLowerCase();
      if (input.checked) this.#draft.voice.voice = option.voice;
      input.addEventListener('change', () => {
        if (input.checked) this.#draft.voice.voice = option.voice;
      });
      inputs.push(input);
      list.append(row);
    }
    const initial = this.#draft.voice.voice;

    const paceInput = this.#text(pace, (value) => (this.#draft.voice.pace = value));

    const aside = document.createElement('p');
    aside.className = 'wizard-aside';
    aside.textContent =
      'Each of these is one name in voice.md. There is nothing here to press to hear them; she has not said anything yet. All thirty Google publishes are on the voice tab of Who she is.';

    panel.append(
      list,
      this.#field(
        'How she paces it',
        paceInput,
        'A line of prose rather than a setting. She is read this, not tuned by it.',
      ),
      aside,
    );

    return {
      id: 'voice',
      title: 'How she sounds',
      note: 'She is speaking out loud, not typing. This is the difference between being talked to at eleven at night and being read a notification.',
      panel,
      clear: () => {
        for (const input of inputs) input.checked = input.value === chosenId(initial);
        paceInput.value = pace;
        this.#draft.voice = { voice: initial, pace };
      },
    };
  }

  #moodStep(): Step {
    const panel = document.createElement('div');
    panel.className = 'wizard-panel';

    const list = document.createElement('div');
    list.className = 'wizard-choices';
    const inputs: HTMLInputElement[] = [];
    for (const temperament of TEMPERAMENTS) {
      const { row, input } = this.#choice('radio', 'wizard-temperament', temperament.label, temperament.line);
      input.value = temperament.id;
      input.addEventListener('change', () => {
        if (input.checked) this.#draft.temperament = temperament.id;
      });
      inputs.push(input);
      list.append(row);
    }

    const note = document.createElement('p');
    note.className = 'wizard-aside';
    note.textContent =
      'Each of these is five numbers in mood.md. Her mood moves away from them with what happens between you, then settles back over the following half hour.';

    panel.append(list, note);

    return {
      id: 'mood',
      title: 'What she is like before you say anything',
      note: 'Her temperament — where she sits when nothing in particular is happening. Not where she will be at eleven at night after a bad conversation.',
      panel,
      clear: () => {
        for (const input of inputs) input.checked = false;
        this.#draft.temperament = undefined;
      },
    };
  }

  /**
   * Two groups, and the second one is the one that was missing.
   *
   * {@link WANTS} is what somebody wants her around for, which is a fact about
   * them. {@link ABSENCE} is what she does about the days they are not here,
   * which is a fact about her — and it was the one thing the product already had
   * machinery for and no question about, so every install got the same answer to
   * "what happens when I disappear".
   */
  #relationshipStep(): Step {
    const panel = document.createElement('div');
    panel.className = 'wizard-panel';

    const area = this.#area('', (value) => (this.#draft.aboutThem = value));
    area.rows = 4;
    area.placeholder = 'Anything. It goes in as a quotation, in your words, not rewritten.';

    const wants = this.#picks(WANTS, this.#draft.wants);
    const absence = this.#picks(ABSENCE, this.#draft.absence);

    panel.append(
      this.#group('What you want her around for', wants),
      this.#group('And when you are not here', absence),
      this.#field('What she should know about you before you start', area),
    );

    return {
      id: 'relationship',
      title: 'Who you are to her',
      note: 'She will ask your name herself, early and once, the first time you talk — so it is not here. This is the rest of it.',
      panel,
      clear: () => {
        untick(wants, this.#draft.wants);
        untick(absence, this.#draft.absence);
        area.value = '';
        this.#draft.aboutThem = '';
      },
    };
  }

  #boundariesStep(): Step {
    const panel = document.createElement('div');
    panel.className = 'wizard-panel';

    const extra = this.#text('', (value) => (this.#draft.refusalExtra = value));
    extra.placeholder = 'Anything else. One line.';

    const picks = this.#picks(REFUSALS, this.#draft.refusals);
    panel.append(picks, this.#field('One more', extra));

    return {
      id: 'boundaries',
      title: 'What she will not do',
      note: 'There is already one thing she does not play, and it is in the file: if you are in real danger she stops performing and stays with you. That one is not a checkbox. These are.',
      panel,
      clear: () => {
        untick(picks, this.#draft.refusals);
        extra.value = '';
        this.#draft.refusalExtra = '';
      },
    };
  }

  #faceStep(): Step {
    const panel = document.createElement('div');
    panel.className = 'wizard-panel';

    const zone = document.createElement('label');
    zone.className = 'dropzone';

    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = 'image/jpeg,image/png,image/webp';
    picker.hidden = true;
    picker.addEventListener('change', () => {
      const file = picker.files?.[0];
      if (file) this.#handlers.onUploadFace(file);
      picker.value = '';
    });

    const preview = document.createElement('img');
    preview.alt = '';
    preview.hidden = true;
    this.#facePreview = preview;

    const label = document.createElement('span');
    label.textContent = 'Drop a picture here, or click to choose one';
    this.#faceLabel = label;

    zone.append(picker, preview, label);

    for (const event of ['dragenter', 'dragover'] as const) {
      zone.addEventListener(event, (drag) => {
        drag.preventDefault();
        zone.dataset.over = 'true';
      });
    }
    for (const event of ['dragleave', 'drop'] as const) {
      zone.addEventListener(event, () => {
        zone.dataset.over = 'false';
      });
    }
    zone.addEventListener('drop', (drag) => {
      drag.preventDefault();
      const file = drag.dataTransfer?.files?.[0];
      if (file) this.#handlers.onUploadFace(file);
    });

    const holder = document.createElement('div');
    holder.className = 'wizard-face';
    holder.append(zone);
    panel.append(holder);

    return {
      id: 'face',
      title: 'What she looks like',
      note: 'A photograph, and there is no written description anywhere to disagree with it. It is what the interface shows, what she sends when you ask to see her, and what every picture she ever generates of herself starts from. Skip it and she is a coloured orb until you change your mind.',
      panel,
      // A photograph is already uploaded by the time it is on screen. Skip moves
      // on; it does not reach back and delete somebody's picture.
      clear: () => {},
    };
  }

  #doneStep(): Step {
    const panel = document.createElement('div');
    panel.className = 'wizard-panel wizard-done';

    for (const paragraph of [
      'That is the one thing this did not ask you, and it is the one thing that is not yours to decide. She chooses it herself, on the first conversation, out of a shortlist she puts forward — once, and then it is hers. It goes into identity.md with her reason beside it as a comment, and nothing ever asks again.',
      'Everything this asked about is six markdown files. Who she is opens them. Nothing here is locked, whether you answered it or skipped it.',
    ]) {
      const p = document.createElement('p');
      p.textContent = paragraph;
      panel.append(p);
    }

    if (!this.#configured) {
      const block = document.createElement('div');
      block.className = 'wizard-key';

      const heading = document.createElement('h3');
      heading.textContent = 'One thing left, and it is not about her';

      const note = document.createElement('p');
      note.className = 'settings-note';
      note.textContent =
        'A Gemini API key, which is the only account involved in any of this. It is checked with Google before it is saved, written to the keys file — `.env` beside the clone if you run her from a terminal, or inside her own folder if you installed the application — and never sent back to this page. Without one she cannot hear you — or choose her name.';

      const row = document.createElement('div');
      row.className = 'setup-row';
      const input = document.createElement('input');
      input.type = 'password';
      input.placeholder = 'AIza…';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.setAttribute('aria-label', 'Gemini API key');
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'primary';
      save.textContent = 'Save';
      row.append(input, save);

      const status = document.createElement('p');
      status.className = 'setup-status';

      const link = document.createElement('p');
      link.className = 'settings-note';
      link.innerHTML =
        'Get one at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer noopener">aistudio.google.com/apikey</a>.';

      const send = async (): Promise<void> => {
        const key = input.value.trim();
        if (!key) return;
        save.disabled = true;
        status.textContent = 'Checking it with Google…';
        status.dataset.kind = 'working';
        const error = await this.#handlers.onSaveKey(key);
        save.disabled = false;
        if (error) {
          // Left in the box: a rejected key is usually one character wrong, and
          // clearing it means pasting it again to find out which.
          status.textContent = error;
          status.dataset.kind = 'bad';
          return;
        }
        input.value = '';
        status.textContent = 'Saved.';
        status.dataset.kind = 'good';
      };
      save.addEventListener('click', () => void send());
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') void send();
      });

      this.#keyInput = input;
      block.append(heading, note, row, status, link);
      panel.append(block);
    }

    return {
      id: 'done',
      title: 'She has not got a name yet',
      note: '',
      panel,
      clear: () => {},
    };
  }

  // -------------------------------------------------------------------------
  // Small pieces
  // -------------------------------------------------------------------------

  /**
   * A list of things you can tick, each showing the line it writes.
   *
   * The exact sentence is under the label rather than hidden behind it, which is
   * the whole argument for this interface over a set of personality sliders: you
   * can see what she is about to be told, in the words she is about to be told
   * it, before you tick anything.
   */
  #picks(catalogue: readonly WizardChoice[], into: Set<string>): HTMLElement {
    const list = document.createElement('div');
    list.className = 'wizard-choices';
    for (const choice of catalogue) {
      const { row, input } = this.#choice('checkbox', '', choice.label, choice.line);
      input.value = choice.id;
      input.addEventListener('change', () => {
        if (input.checked) into.add(choice.id);
        else into.delete(choice.id);
      });
      list.append(row);
    }
    return list;
  }

  /** A heading over a list, for the one card that has two lists on it. */
  #group(label: string, list: HTMLElement): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'wizard-field';
    // A heading rather than a `<label>`: it names a group of checkboxes and
    // labels nothing, and a label with no control is a label that lies to a
    // screen reader about what clicking it does.
    const caption = document.createElement('h3');
    caption.className = 'wizard-group';
    caption.textContent = label;
    wrap.append(caption, list);
    return wrap;
  }

  #choice(
    type: 'checkbox' | 'radio',
    group: string,
    label: string,
    line: string,
  ): { row: HTMLElement; input: HTMLInputElement } {
    const row = document.createElement('label');
    row.className = 'wizard-choice';

    const input = document.createElement('input');
    input.type = type;
    if (group) input.name = group;

    const text = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = label;
    const small = document.createElement('small');
    small.textContent = line;
    text.append(strong, small);

    row.append(input, text);
    return { row, input };
  }

  #field(label: string, control: HTMLElement, hint?: string): HTMLElement {
    const id = `wizard-field-${(this.#fieldId += 1)}`;
    control.id = id;

    const wrap = document.createElement('div');
    wrap.className = 'wizard-field';

    const caption = document.createElement('label');
    caption.htmlFor = id;
    caption.textContent = label;
    wrap.append(caption, control);

    if (hint) {
      const small = document.createElement('small');
      small.textContent = hint;
      wrap.append(small);
    }
    return wrap;
  }

  #text(value: string, onChange: (value: string) => void): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'wizard-input';
    input.autocomplete = 'off';
    input.value = value;
    input.addEventListener('input', () => onChange(input.value));
    // Enter is the obvious thing to press in a one-line box, and doing nothing
    // is the worst answer available.
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.#next.click();
      }
    });
    return input;
  }

  #area(value: string, onChange: (value: string) => void): HTMLTextAreaElement {
    const area = document.createElement('textarea');
    area.className = 'wizard-area';
    area.spellcheck = true;
    area.value = value;
    area.addEventListener('input', () => onChange(area.value));
    return area;
  }
}

/** The id of the choice that writes a given voice name, if one does. */
function chosenId(voice: string): string {
  return VOICE_CHOICES.find((option) => option.voice === voice)?.id ?? '';
}

/** Unticks every box in a panel and forgets what they meant. */
function untick(panel: HTMLElement, into: Set<string>): void {
  for (const box of panel.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    box.checked = false;
  }
  into.clear();
}

/** The local date, not the UTC one — this is the day they met, where they are. */
function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}
