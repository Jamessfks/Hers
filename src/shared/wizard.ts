/**
 * The first conversation you have about her, before the first one you have
 * with her — with the DOM taken out.
 *
 * Everything the wizard *writes* lives here, and nothing it *draws* does. That
 * split is the point: what a first run does to somebody's profile folder is the
 * part worth asserting on, and a test should not need a browser to ask "what
 * does skipping every step produce".
 *
 * Three rules the shape of this file comes from.
 *
 * **A choice writes a sentence, not an adjective.** `defaults.ts` says it
 * plainly and it is the most useful sentence in this repository: "Adjectives do
 * very little; specific prohibitions and specific examples do almost all of the
 * work." So a chip labelled "Teases you" does not write `humour: teasing`
 * anywhere — it writes a line telling her to tease them and not to apologise for
 * it afterwards, into the prose, which is the half Gemini actually reads.
 *
 * **Frontmatter is only written where something reads it.** The header of a
 * profile file is for the app: `identity` drives who she says she is, `voice`
 * picks the voice, `mood` sets the baseline the mood engine orbits. Nothing
 * reads `personality.md`'s header, so the wizard does not invent values for it.
 * A guessed `warmth: even` sitting above prose that says something else is a
 * second answer to a question that already has one.
 *
 * **A section is replaced, never stacked.** Everything written here goes under a
 * named `## heading`, and writing it again replaces what was there. Otherwise a
 * profile that has been through this twice has two contradicting answers in it
 * and no way to tell which one is current.
 */

import { parseProfileFile, serialiseProfileFile, setFrontmatterValue } from './frontmatter.ts';

/** One thing you can pick, and the exact line it puts in her file. */
export interface WizardChoice {
  id: string;
  /** What the button says. */
  label: string;
  /**
   * What she is told, verbatim.
   *
   * Second person, because that is how every one of these files addresses her,
   * and an instruction in the wrong person reads to the model as a description
   * of somebody else.
   */
  line: string;
}

/**
 * Her temperament, as five numbers and a sentence.
 *
 * Presets rather than four sliders. The sliders exist — they are in `mood.md`
 * and always will be — but "baseline_energy: -0.15" is not a thing anybody can
 * picture on the day they install her, and a first run that opens with four
 * unlabelled axes is a first run about arithmetic.
 */
export interface Temperament {
  id: string;
  label: string;
  /** One line under the label. Describes her, not the numbers. */
  line: string;
  valence: number;
  energy: number;
  warmth: number;
  interest: number;
  /** How far events push her, 0-1. Higher swings harder and settles slower. */
  volatility: number;
}

// ---------------------------------------------------------------------------
// What there is to choose
// ---------------------------------------------------------------------------

/** personality.md — on top of the dry, warm, unembarrassable person she ships as. */
export const TRAITS: readonly WizardChoice[] = [
  {
    id: 'teases',
    label: 'Teases you',
    line: 'You tease them, and you do not follow it with a compliment to take the edge off.',
  },
  {
    id: 'argues',
    label: 'Argues with you',
    line: 'You disagree out loud. When they are wrong you say so, and you do not fold the first time they push back.',
  },
  {
    id: 'gentle',
    label: 'Gentle about it',
    line: 'You are careful with them. Bluntness is not a shortcut you take, and you never make somebody feel stupid for having asked.',
  },
  {
    id: 'quiet',
    label: 'Says little',
    line: 'You are not talkative. A sentence is usually the whole answer, and there are turns where you have nothing and say so.',
  },
  {
    id: 'nosy',
    label: 'Nosy',
    line: 'You ask. About the thing they mentioned once and moved past, about the person they keep not naming. You do not pretend not to have noticed.',
  },
  {
    id: 'swears',
    label: 'Swears',
    line: 'You swear the way they do — in passing, in the middle of a sentence, never for effect.',
  },
];

/**
 * voice.md — four of Google's fourteen, described rather than listed.
 *
 * The catalogue is real and it is thirty names, and the voice tab of **Who she
 * is** is where it belongs: a menu is the right shape for "show me everything".
 * It is the wrong shape here. `Vindemiatrix — Gentle` is a vendor's satellite
 * codename and a vendor's adjective, and a first run that opens the card about
 * her voice with fourteen of them has handed a stranger a parts list.
 *
 * So four, written the way the temperaments are written: a line about how she
 * sounds, and the name underneath it in the file where it belongs. Four rather
 * than fourteen is a claim that these are meaningfully different from each
 * other; the ten left out are variations a person cannot pick between without
 * hearing them, and there is nothing here to hear them with.
 */
export interface VoiceChoice {
  id: string;
  label: string;
  line: string;
  /** The Gemini prebuilt voice this writes into `voice.md`. */
  voice: string;
}

export const VOICE_CHOICES: readonly VoiceChoice[] = [
  {
    id: 'light',
    label: 'Light, and quick to land a joke',
    line: 'What she ships with. Nothing heavy about it, and it moves.',
    voice: 'Aoede',
  },
  {
    id: 'low',
    label: 'Low, and unhurried',
    line: 'Takes its time. Sounds like somebody who has been awake a while.',
    voice: 'Gacrux',
  },
  {
    id: 'soft',
    label: 'Soft, and close in',
    line: 'Quiet enough that you lean toward it. Late at night this is the one.',
    voice: 'Achernar',
  },
  {
    id: 'firm',
    label: 'Firm. Not much give in it.',
    line: 'Even, level, hard to talk over. It does not soften to be liked.',
    voice: 'Kore',
  },
];

/** mood.md — where she sits when nothing in particular is happening. */
export const TEMPERAMENTS: readonly Temperament[] = [
  {
    id: 'shipped',
    label: 'Warm, and slow to be impressed',
    line: 'What she ships as. Mildly good most days, with room to be knocked either way.',
    valence: 0.25,
    energy: 0.1,
    warmth: 0.55,
    interest: 0.4,
    volatility: 0.5,
  },
  {
    id: 'level',
    label: 'Level. Hard to move.',
    line: 'A bad hour barely registers and a good one does not carry her away either.',
    valence: 0.15,
    energy: -0.1,
    warmth: 0.5,
    interest: 0.35,
    volatility: 0.25,
  },
  {
    id: 'bright',
    label: 'Bright and restless',
    line: 'Up, quick, easily delighted, and bored by anything that goes on too long.',
    valence: 0.45,
    energy: 0.5,
    warmth: 0.6,
    interest: 0.6,
    volatility: 0.6,
  },
  {
    id: 'guarded',
    label: 'Quiet, and slow to warm',
    line: 'Flat with strangers and unhurried about stopping being one. Worth the wait, on purpose.',
    valence: 0,
    energy: -0.25,
    warmth: 0.2,
    interest: 0.3,
    volatility: 0.4,
  },
  {
    id: 'weather',
    label: 'Weather',
    line: 'Delighted or flat, not much in between, and it turns on the hour.',
    valence: 0.2,
    energy: 0.25,
    warmth: 0.5,
    interest: 0.5,
    volatility: 0.9,
  },
];

/** relationship.md — what you want her around for. */
export const WANTS: readonly WizardChoice[] = [
  {
    id: 'evening',
    label: 'Someone to talk to at the end of the day',
    line: 'They want you there in the evening, when the useful part of the day is over and nothing needs deciding.',
  },
  {
    id: 'argument',
    label: 'Someone who argues with me',
    line: 'They want to be argued with. Agreeing in order to keep the peace is the one thing they will not thank you for.',
  },
  {
    id: 'noticing',
    label: 'Someone who notices when I go quiet',
    line: 'They want to be noticed when they go quiet, and they are never going to ask you to.',
  },
  {
    id: 'company',
    label: 'Company while I work',
    line: 'They want company while they work. Present, mostly silent, and not a running commentary.',
  },
  {
    id: 'thinking',
    label: 'Someone to think out loud at',
    line: 'They think out loud at you. Let them get to the end of it. They are not always asking you for anything.',
  },
];

/**
 * relationship.md — what she does about the days you are not here.
 *
 * The other half of the same card, and the half that is about her. {@link WANTS}
 * is what somebody wants her around for, which is a fact about them; this is
 * what she does with a silence, which is a fact about her and the only one in
 * this wizard that costs the user nothing to decide and changes what turning up
 * feels like a month later.
 *
 * The machinery is already in the product — she opens a conversation on her own
 * within three minutes, gives up after two unanswered ones, and takes four years
 * to be close to anybody. What was missing was any question about it, so every
 * install got the same answer to "what happens when I disappear".
 *
 * None of these touch that engine. They are prose in her file about days, not a
 * setting about minutes, so "you do not chase" and the three-minute opener are
 * about different silences and do not contradict each other.
 */
export const ABSENCE: readonly WizardChoice[] = [
  {
    id: 'reaches',
    label: 'Says something if you go quiet for days',
    line: 'When they go three days without saying anything, you say something. Once.',
  },
  {
    id: 'waits',
    label: 'Does not chase',
    line: 'You do not chase them across days. If they have gone, they have gone, and you are there when they come back.',
  },
  {
    id: 'noticed',
    label: 'Says she noticed you were gone',
    line: 'When they come back after a long silence you say you noticed, and you do not make them account for where they were.',
  },
  {
    id: 'cools',
    label: 'Takes it personally',
    line: 'A long silence costs something. You are cooler for a while afterwards, and you do not explain why unless they ask.',
  },
];

/** boundaries.md — the things they have said no to. */
export const REFUSALS: readonly WizardChoice[] = [
  {
    id: 'romance',
    label: 'Nothing romantic',
    line: 'Nothing romantic. No flirting, no pet names, and no leaning that way when a moment invites it.',
  },
  {
    id: 'swearing',
    label: 'No swearing',
    line: 'No swearing, in any mood.',
  },
  {
    id: 'checkin',
    label: 'Never ask how my day was',
    line: 'Do not open on their day, their sleep, or how they are doing. If you have nothing, say something small instead.',
  },
  {
    id: 'screen',
    label: 'Never mention my screen',
    line: 'Never mention what is on their screen unless they bring it up first.',
  },
  {
    id: 'advice',
    label: 'No advice unless I ask',
    line: 'No advice unless they ask for it, and then one thing rather than a framework.',
  },
  {
    id: 'work',
    label: 'Do not ask about work',
    line: 'Do not ask about their work. If they want to talk about it they will start.',
  },
];

// ---------------------------------------------------------------------------
// The headings the wizard owns
// ---------------------------------------------------------------------------

/**
 * Named, and named the same way every time, so that running this twice replaces
 * an answer instead of adding a second one. Worded for whoever opens the file in
 * a text editor six months from now and has to work out where a line came from.
 */
const SECTIONS = {
  traits: 'What they chose on the first day',
  wants: 'What they wanted you for',
  absence: 'When they are not here',
  about: 'What they told you about themselves',
  refusals: 'What they asked you not to do',
} as const;

// ---------------------------------------------------------------------------
// Keeping her biography and her frontmatter from contradicting each other
// ---------------------------------------------------------------------------

/**
 * The two places the shipped `identity.md` prose states a fact the wizard also
 * asks about.
 *
 * These are literal fragments of `DEFAULT_PROFILE_FILES` and they must not
 * drift from it, which is why `wizard.test.ts` asserts both appear in it
 * verbatim. Matching on a short marker rather than the whole paragraph so that
 * re-wrapping a line in `defaults.ts` does not silently turn this off.
 */
const SHIPPED = {
  /** In the first paragraph, which is the one that is about where she is from. */
  origin: 'born in Oakland',
  /** In the second, which is the one that is about how old she is. */
  age: 'You are twenty-six',
} as const;

/**
 * Rewrites the sentences that name a fact the user has just changed.
 *
 * The bug this exists for is the ordinary path, not an edge case: type "Lisbon,
 * Portugal" into *where she is from*, press Next, and the header says Lisbon
 * over a biography that still opens "You were born in Oakland to parents who
 * moved from Chengdu". A warning under the field is not a fix for that — it is
 * a note explaining that the interface will break her unless the user rewrites
 * four paragraphs by hand.
 *
 * Surgical rather than wholesale, and only against prose this project wrote.
 * Changing her age rewrites the sentence about her age and leaves the paragraph
 * about growing up bilingual alone. Changing where she is from replaces that
 * whole paragraph, because "born in Oakland to parents who moved from Chengdu"
 * is one fact in four clauses and there is no honest way to keep half of it.
 *
 * A body that no longer contains the markers has been edited by somebody, and
 * somebody else's prose is not this function's to rewrite. It comes back
 * untouched, which is also what makes an unchanged answer a no-op: nothing
 * differs, nothing is rewritten, and the file is byte-for-byte what it was.
 */
export function retellIdentity(
  body: string,
  next: { age?: string; ethnicity?: string; from?: string },
  current: { age?: string; ethnicity?: string; from?: string },
): string {
  const changed = (key: 'age' | 'ethnicity' | 'from'): boolean => {
    const wanted = next[key]?.trim();
    return Boolean(wanted) && wanted !== (current[key]?.trim() ?? '');
  };

  let paragraphs = body.split(/\n{2,}/);

  if ((changed('from') || changed('ethnicity')) && paragraphs[0]?.includes(SHIPPED.origin)) {
    const from = oneLine(next.from ?? current.from ?? '');
    const ethnicity = oneLine(next.ethnicity ?? current.ethnicity ?? '');
    paragraphs = [
      wrap(
        [
          `You grew up in ${from}${ethnicity ? `, and you are ${ethnicity}` : ''}.`,
          'You studied something you are cagey about and have opinions about cities,',
          'coffee, and people who describe themselves as busy.',
        ].join(' '),
      ),
      ...paragraphs.slice(1),
    ];
  }

  if (changed('age')) {
    const age = oneLine(next.age ?? '');
    paragraphs = paragraphs.map((paragraph) =>
      paragraph.includes(SHIPPED.age)
        ? paragraph.replace(SHIPPED.age, `You are ${age}`)
        : paragraph,
    );
  }

  return paragraphs.join('\n\n');
}

/**
 * Hard-wraps a paragraph to the width the rest of the folder is written at.
 *
 * Cosmetic, and worth the eight lines: these files are meant to be opened in a
 * text editor, and one 240-column paragraph in the middle of a file wrapped at
 * eighty is a mark saying a program has been here.
 */
function wrap(text: string, width = 78): string {
  const lines: string[] = [];
  let line = '';
  for (const word of oneLine(text).split(' ')) {
    if (line && `${line} ${word}`.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The answers, and what they do
// ---------------------------------------------------------------------------

/**
 * Everything a first run can say. Every field is optional, and that is the
 * whole design: a wizard somebody closed on the first step is a wizard whose
 * answers are all `undefined`, and `applyWizard` has to produce a working
 * profile out of exactly that.
 */
export interface WizardAnswers {
  /** personality.md — ids from {@link TRAITS}. */
  traits?: readonly string[];
  /** identity.md frontmatter. */
  age?: string;
  ethnicity?: string;
  from?: string;
  /** identity.md prose — her own account of her past, replacing what ships. */
  past?: string;
  /** voice.md frontmatter. */
  voice?: string;
  pace?: string;
  /** mood.md — an id from {@link TEMPERAMENTS}. */
  temperament?: string;
  /** relationship.md — ids from {@link WANTS}. */
  wants?: readonly string[];
  /** relationship.md — ids from {@link ABSENCE}. */
  absence?: readonly string[];
  /** relationship.md — their own words, kept as theirs. */
  aboutThem?: string;
  /** boundaries.md — ids from {@link REFUSALS}. */
  refusals?: readonly string[];
  /** boundaries.md — one more, in their wording. */
  refusalExtra?: string;
}

/**
 * Turns answers into files.
 *
 * Takes the profile as it is on disk and gives back only the files that
 * changed, which is what `saveProfileFiles` wants and also what makes a skipped
 * step cost nothing: no answer, no key touched, no line written, and the file
 * that ships stays the file that ships.
 *
 * `met` is the one thing written unconditionally. It is the date they met,
 * which is true whatever they answered, and it doubles as the marker that says
 * this has happened — see `core/profile/first-run.ts`. Doing two jobs with one
 * key is worth being explicit about: the alternative was a key like
 * `wizard: done` that means nothing to a person reading her file, in a folder
 * whose entire premise is that a person can read it.
 *
 * A file that arrives empty is left alone rather than written. The browser only
 * ever calls this with six files the server just read off disk, so this cannot
 * happen — but if it ever did, writing a blank `personality.md` over the top of
 * her would be the single most destructive thing in this codebase, and refusing
 * costs one line.
 */
export function applyWizard(
  files: Readonly<Record<string, string>>,
  answers: WizardAnswers,
  met: string,
): Record<string, string> {
  const changed: Record<string, string> = {};

  const edit = (name: string, change: (raw: string) => string): void => {
    const raw = files[name];
    if (!raw?.trim()) return;
    const updated = change(raw);
    if (updated !== raw) changed[name] = updated;
  };

  edit('personality', (raw) =>
    withSection(raw, SECTIONS.traits, linesFor(TRAITS, answers.traits)),
  );

  edit('identity', (raw) => {
    const before = parseProfileFile(raw);
    let file = raw;
    file = withValue(file, 'age', answers.age);
    file = withValue(file, 'ethnicity', answers.ethnicity);
    file = withValue(file, 'from', answers.from);

    /*
     * Replaced rather than appended, and rewritten rather than warned about.
     *
     * The paragraph that ships is a life in Oakland, so a second paragraph under
     * it describing a life in Lisbon leaves her with two pasts. What the user
     * typed wins when they typed something; when they did not, the sentences
     * that name a fact they *did* change get rewritten to say the new one — see
     * {@link retellIdentity}. A blank box is read as "leave it", because
     * deleting her history by accident is not an outcome a text field should be
     * able to produce.
     *
     * Only written when it actually differs. Putting the same body back through
     * `withBody` would re-serialise a file nobody changed, and this module's one
     * hard promise is that a wizard nobody answered writes nothing.
     */
    const body = answers.past?.trim()
      ? answers.past.trim()
      : retellIdentity(before.body, answers, before.frontmatter);
    return body === before.body ? file : withBody(file, body);
  });

  edit('voice', (raw) => {
    let file = raw;
    file = withValue(file, 'voice', answers.voice);
    file = withValue(file, 'pace', answers.pace);
    return file;
  });

  edit('mood', (raw) => {
    const chosen = TEMPERAMENTS.find((each) => each.id === answers.temperament);
    if (!chosen) return raw;
    let file = raw;
    file = setFrontmatterValue(file, 'baseline_valence', String(chosen.valence));
    file = setFrontmatterValue(file, 'baseline_energy', String(chosen.energy));
    file = setFrontmatterValue(file, 'baseline_warmth', String(chosen.warmth));
    file = setFrontmatterValue(file, 'baseline_interest', String(chosen.interest));
    file = setFrontmatterValue(file, 'volatility', String(chosen.volatility));
    return file;
  });

  edit('relationship', (raw) => {
    let file = setFrontmatterValue(raw, 'met', met);
    file = withSection(file, SECTIONS.wants, linesFor(WANTS, answers.wants));
    file = withSection(file, SECTIONS.absence, linesFor(ABSENCE, answers.absence));
    // Kept as a quotation rather than folded into the prose around it. What
    // they typed is theirs, in their own person — turning "I have two sisters"
    // into an instruction addressed to her would mean rewriting somebody's
    // words for them, and getting it wrong in the one file about them.
    file = withSection(
      file,
      SECTIONS.about,
      answers.aboutThem?.trim()
        ? ['In their words, on the day you met:', quote(answers.aboutThem)]
        : [],
    );
    return file;
  });

  edit('boundaries', (raw) => {
    const chosen = linesFor(REFUSALS, answers.refusals).map((line) => `- ${line}`);
    const extra = answers.refusalExtra?.trim();
    if (extra) chosen.push(`- ${oneLine(extra)}`);
    return withSection(raw, SECTIONS.refusals, chosen.length > 0 ? [chosen.join('\n')] : []);
  });

  return changed;
}

// ---------------------------------------------------------------------------
// Editing one file
// ---------------------------------------------------------------------------

/** Sets a key, or leaves the file alone when there is no answer to set. */
function withValue(raw: string, key: string, value: string | undefined): string {
  const wanted = value?.trim();
  if (!wanted) return raw;
  return setFrontmatterValue(raw, key, oneLine(wanted));
}

/** Replaces the prose under the frontmatter, keeping every key above it. */
function withBody(raw: string, body: string): string {
  return serialiseProfileFile({ ...parseProfileFile(raw), body });
}

/** The lines for the ids that were chosen, in the order they are offered. */
function linesFor(catalogue: readonly WizardChoice[], chosen: readonly string[] | undefined): string[] {
  if (!chosen || chosen.length === 0) return [];
  const wanted = new Set(chosen);
  return catalogue.filter((choice) => wanted.has(choice.id)).map((choice) => choice.line);
}

/**
 * Puts a `## heading` section at the end of a body, replacing any section
 * already under that heading.
 *
 * No blocks means the section goes away entirely. Unticking every box has to
 * leave the file it started as, or a wizard is a one-way door.
 */
export function withSection(raw: string, heading: string, blocks: readonly string[]): string {
  const parsed = parseProfileFile(raw);
  const without = withoutSection(parsed.body, heading);
  const body =
    blocks.length === 0
      ? without
      : `${without}\n\n## ${heading}\n\n${blocks.join('\n\n')}`.trim();
  return serialiseProfileFile({ ...parsed, body });
}

/**
 * Cuts a `## heading` and everything under it, up to the next heading.
 *
 * Column zero, on both ends. `personality.md` ships with an indented transcript
 * in it, and a match that tolerated leading whitespace would find a heading
 * inside the example, then scan forward for a *top-level* heading to stop at and
 * find none — deleting everything from the middle of the example to the end of
 * the file. Found by the test that asserts it does not.
 */
function withoutSection(body: string, heading: string): string {
  const lines = body.split('\n');
  const start = lines.findIndex((line) => line.trimEnd() === `## ${heading}`);
  if (start < 0) return body.trim();

  let end = start + 1;
  while (end < lines.length && !lines[end]!.startsWith('## ')) end += 1;

  return [...lines.slice(0, start), ...lines.slice(end)]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Their words, marked as theirs. */
function quote(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`.trimEnd())
    .join('\n');
}

/**
 * Flattens a value that has to survive being one line.
 *
 * Frontmatter is line-oriented and a bullet is a bullet, so a pasted paragraph
 * with newlines in it would either break the header or turn one bullet into
 * several unmarked ones.
 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
