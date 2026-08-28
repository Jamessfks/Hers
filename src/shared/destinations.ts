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
 *   **`LIVEKIT_URL` is a host you supply.** It is in the list as a variable
 *   because only the person who configured it knows what it resolves to.
 */

/** Which switch has to be on before a destination can be reached at all. */
export type Requires = 'gemini' | 'telegram' | 'livekit' | 'call-page';

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
  /**
   * True when the request is made by the phone's call page rather than by this
   * program. Worth separating: those come from the phone's network, not the
   * machine Hers runs on, so a network monitor here will not see them.
   */
  fromPhone?: boolean;
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
    what: 'The photograph you gave her as a reference, and a text prompt describing the picture wanted.',
    when: 'Each time she generates a picture of herself, and once per expression you ask for.',
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
    host: '<LIVEKIT_URL>',
    what: "Her voice out, your phone's audio and video in. She dials out and waits in the room; nothing on your machine is listening.",
    when: 'When you ask for a call, until it ends or an hour passes.',
    requires: 'livekit',
  },
  {
    host: '<HERS_CALL_PAGE_URL>',
    what: 'A request for the call page itself. The room name and token travel in the URL fragment, which is never sent to the host serving it.',
    when: 'When you open a call link on your phone.',
    requires: 'call-page',
    fromPhone: true,
  },
  {
    host: 'cdn.jsdelivr.net',
    what: 'A download of livekit-client 2.21.0, which the call page imports as a module. jsDelivr sees your phone’s IP and that it asked for this file.',
    when: 'Every time the call page loads, before the call starts. The page is one static file with no build step, so it fetches the library rather than bundling it.',
    requires: 'call-page',
    fromPhone: true,
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
  { host: 'ai.google.dev', why: "Google's Live API documentation, cited in comments." },
  { host: 'docs.cloud.google.com', why: "Google's voice documentation, cited in a comment." },
  { host: 'localhost', why: 'This machine. Where the server binds and what the browser talks to.' },
  { host: '127.0.0.1', why: 'The same machine, written the other way.' },
];

/** Everything that is off until you configure it. */
export function requiresOf(destination: Destination): string {
  switch (destination.requires) {
    case 'gemini':
      return 'a Gemini key';
    case 'telegram':
      return 'TELEGRAM_BOT_TOKEN';
    case 'livekit':
      return 'the three LIVEKIT_ variables';
    case 'call-page':
      return 'LiveKit, and opening a call link';
    default:
      return 'nothing';
  }
}

/** The hostnames alone, deduplicated, in the order they first appear. */
export function destinationHosts(): string[] {
  return [...new Set(DESTINATIONS.map((destination) => destination.host))];
}
