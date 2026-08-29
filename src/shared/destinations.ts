/**
 * Every host this program can reach, in one list.
 *
 * A privacy document that says "nothing else leaves" is an assertion by
 * whoever last edited it. This list is the same claim written where the program
 * can read it: `npm run doctor` prints it, `destinations.test.ts` walks the
 * source for URL literals and fails on any host that is not here, and a second
 * test fails if `docs/PRIVACY.md` does not name every one. So the three things
 * that normally drift apart — the code, what the program says about itself, and
 * the document — cannot.
 *
 * Two lists rather than one, because a hostname in a source file is not
 * evidence of a request. {@link DESTINATIONS} is what the program dials.
 * {@link MENTIONED_ONLY} is hostnames that appear in comments, in
 * documentation links, and in anchors a person may click — which reach nothing
 * unless a person clicks them. Splitting them is what makes the first list
 * mean something.
 *
 * ## What this list cannot catch
 *
 * Two things, stated because the honest version of a guarantee includes its
 * edges:
 *
 *   **A dependency could dial somewhere of its own accord.** `@google/genai`
 *   contains code paths to `aiplatform.googleapis.com`, `vertexai.googleapis.com`
 *   and `raw.githubusercontent.com`; none is reachable from here, because
 *   nothing in this repository constructs the client with `vertexai: true` and
 *   nothing uses its local tokenizer, which is what those paths are for. That
 *   is an argument from reading the SDK, not a guarantee enforced by a test,
 *   and it is the weakest claim on this page. A network monitor settles it in
 *   thirty seconds and does not have to take anyone's word.
 *
 *   **She has a shell.** Since v2.0 `run()` executes arbitrary commands, and a
 *   hostname she composes at runtime is not a URL literal in any file here.
 *   This list is therefore no longer "every host this program can contact"; it
 *   is every host it dials *on its own, unasked*, which is a narrower claim and
 *   the only one that was ever enforceable. `docs/PRIVACY.md` has a section
 *   saying so under its own heading rather than in a parenthesis.
 */

/** Which switch has to be on before a destination can be reached at all. */
export type Requires = 'gemini' | 'telegram';

export interface Destination {
  /**
   * The hostname, exactly as it appears in a network monitor.
   *
   * Angle brackets mean the value comes from configuration and this file
   * genuinely does not know it.
   */
  host: string;
  /** What is sent there. */
  what: string;
  /** What has to happen for the request to be made. */
  when: string;
  /** Null for the ones that need nothing switched on. */
  requires: Requires | null;
}

export const DESTINATIONS: readonly Destination[] = [
  {
    host: 'generativelanguage.googleapis.com',
    what: 'The conversation itself — microphone audio, camera and screen frames, anything you type, her system prompt, and her tool calls — over one WebSocket.',
    when: 'While a conversation is open, and again on each reconnect. This is the only connection that ever carries realtime media.',
    requires: 'gemini',
  },
  {
    host: 'generativelanguage.googleapis.com',
    what: 'Recent turns as text, for distilling into facts; a Telegram voice or video note, for transcribing; excerpts from folders you approved; a shortlist of names, on a first-ever conversation.',
    when: 'Every twelfth turn, when a media message arrives, when you press Read them once, and once when she has never been named.',
    requires: 'gemini',
  },
  {
    host: 'generativelanguage.googleapis.com',
    what: 'One short sentence per fact, to turn it into a vector for recall.',
    when: 'When a fact is written down and when she looks one up.',
    requires: 'gemini',
  },
  {
    host: 'generativelanguage.googleapis.com',
    what: 'A key, and nothing else — a metadata request that lists one model name.',
    when: 'When you submit a key in Setup. The only request made with a key that has not been confirmed yet.',
    requires: null,
  },
  {
    host: 'api.telegram.org',
    what: 'A long poll asking for new messages, and her replies: text, photographs, voice notes.',
    when: 'Continuously while the server runs, in fifty-second polls.',
    requires: 'telegram',
  },
  {
    host: 'api.telegram.org',
    what: 'A download of a file you sent the bot, so she can look at it or hear it.',
    when: 'When you send the bot a photograph, a voice note or a video note.',
    requires: 'telegram',
  },
  {
    host: 'geocoding-api.open-meteo.com',
    what: 'One city name, taken from the last segment of your system timezone. Not your IP address, not a browser location prompt, and nothing else about you — several million people share the answer this sends.',
    when: 'Once per run of the server, the first time she wants to know what it is doing outside. The latitude and longitude that come back are held in memory and never written down.',
    requires: null,
  },
  {
    host: 'api.open-meteo.com',
    what: 'A latitude and a longitude rounded to whatever the geocoder returned for that city, asking for the current temperature, weather code and whether it is daylight.',
    when: 'At most once an hour while the server is running, so that she can mention the weather the way somebody sitting by a window would.',
    requires: null,
  },
];

/**
 * Hostnames that appear in the source and are never requested by it.
 *
 * Every one is either a link in a comment explaining why the code does what it
 * does, or an anchor on the setup page which reaches nothing until somebody
 * clicks it. Listed so that {@link DESTINATIONS} can be checked exhaustively
 * against the source rather than approximately.
 */
export const MENTIONED_ONLY: readonly { host: string; why: string }[] = [
  { host: 'aistudio.google.com', why: 'Where you get a Gemini key. A link on the setup page and a line the doctor prints.' },
  { host: 't.me', why: 'The link that opens your bot in Telegram, and @BotFather. Shown to you; opened by you.' },
  {
    host: 'ai.google.dev',
    why: "Google's own documentation for the Live API, cited in comments where this code depends on a documented behaviour. A link somebody may click while reading the source; nothing here requests it.",
  },
  {
    host: 'docs.cloud.google.com',
    why: "Where Google publishes which of the thirty prebuilt voices it labels female, which is the table the voice menu is built from. Cited in a comment so the claim can be checked; nothing here requests it.",
  },
  { host: 'localhost', why: 'This machine. Where the server binds and what the browser talks to.' },
  {
    host: '127.0.0.1',
    why: 'The same machine as localhost, written the other way. Both spellings are in the allowlist because a person may type either one into a browser, and the handshake has to recognise the address it was actually reached on.',
  },
];

/** Everything that is off until you configure it. */
export function requiresOf(destination: Destination): string {
  switch (destination.requires) {
    case 'gemini':
      return 'a Gemini key';
    case 'telegram':
      return 'TELEGRAM_BOT_TOKEN';
    default:
      return 'nothing';
  }
}

/** The hostnames alone, deduplicated, in the order they first appear. */
export function destinationHosts(): string[] {
  return [...new Set(DESTINATIONS.map((destination) => destination.host))];
}
