/**
 * `npm run doctor` — the live check the test suite cannot do.
 *
 * Every test in this repository fakes the network, deliberately: a reconnect is
 * not reproducible against a real socket and a suite that needs an API key is a
 * suite nobody runs. The gap that leaves is exactly one question — *is this
 * key, this model and this account actually working right now* — and this is
 * the answer to it.
 *
 * It opens a real Live session, says one thing, waits for audio to come back,
 * and closes. That single round trip exercises the key, the model name, the
 * quota, the voice, the websocket path and the audio pipeline in one go. If it
 * passes, the only things left between here and her talking are the browser's
 * own permissions.
 *
 * It also prints, before any of that, the two things `docs/PRIVACY.md` claims:
 * the absolute path of every file she keeps, and every host this build can
 * reach. Those come from {@link DESTINATIONS} and from the resolved config
 * rather than from prose, so what the program says about itself and what it
 * does cannot disagree. Both sections run with no key and reach nothing.
 */

import path from 'node:path';

import { Brain } from '../core/session/brain.ts';
import { KNOWN_LIVE_MODELS } from '../core/gemini/models.ts';
import { LiveConversation } from '../core/gemini/live.ts';
import { DESTINATIONS, requiresOf } from '../shared/destinations.ts';
import type { Requires } from '../shared/destinations.ts';
import { writesUnder } from '../shared/writers.ts';
import type { Root } from '../shared/writers.ts';
import { envFilePath, loadConfig, loadDotEnv } from './config.ts';
import type { Config } from './config.ts';

const ok = (message: string) => console.log(`  ✓ ${message}`);
const bad = (message: string) => console.log(`  ✗ ${message}`);
const note = (message: string) => console.log(`    ${message}`);

async function main(): Promise<number> {
  loadDotEnv();
  const config = loadConfig();
  let failures = 0;

  console.log('\nHers — checking\n');

  // -- configuration --------------------------------------------------------

  if (config.geminiApiKey) {
    ok(`Gemini key present (${config.geminiApiKey.length} characters)`);
  } else {
    bad('No Gemini key.');
    note('Get one at https://aistudio.google.com/apikey, then put this in .env:');
    note('GEMINI_API_KEY=…');
    failures += 1;
  }

  if (KNOWN_LIVE_MODELS.includes(config.model)) {
    ok(`Model ${config.model}`);
  } else {
    ok(`Model ${config.model} (not one I know; affective dialog will be left off)`);
  }

  for (const warning of config.warnings) {
    bad(warning);
  }

  // -- the profile and the memory -------------------------------------------

  try {
    const brain = await Brain.open(config, { offline: true });
    ok(`Profile at ${config.profileDir}`);
    note(
      `${brain.profile.identity.name}, ${brain.profile.identity.age}, ${brain.profile.identity.gender}, ` +
        `voice ${brain.profile.voice.voice}, ` +
        `${brain.avatar.face() ? 'has a photograph' : 'no photograph yet'}`,
    );
    ok(`Memory at ${config.dataDir} — ${brain.memory.turnCount()} turns in this conversation`);
    ok(`Gallery has ${(await brain.gallery.list()).length} things in it`);
    ok(`Mood: ${brain.mood.read().label}`);
    await brain.close();
  } catch (error) {
    bad(`Could not open her profile or memory: ${String(error)}`);
    failures += 1;
  }

  // -- the bridges ----------------------------------------------------------

  console.log(config.telegram ? '  ✓ Telegram configured' : '  · Telegram off');
  console.log(config.livekit ? '  ✓ LiveKit configured' : '  · Phone calls off');

  // -- what docs/PRIVACY.md claims, printed from the code ------------------

  printFiles(config);
  printDestinations(config);

  // -- the one thing only a real key can answer -----------------------------

  if (config.geminiApiKey) {
    console.log('\n  Opening a real session…');
    const result = await liveRoundTrip(config.geminiApiKey, config.model);
    if (result.ok) {
      ok(`Gemini answered — ${result.bytes} bytes of audio, ${result.ms}ms to first sound`);
      if (result.said) note(`She said: “${result.said.trim()}”`);
    } else {
      bad(`Gemini did not answer: ${result.reason}`);
      note('A 400 usually means the model name; a 403 means the key; a 429 means quota.');
      failures += 1;
    }
  }

  console.log(failures === 0 ? '\nAll good.\n' : `\n${failures} thing(s) to fix.\n`);
  return failures === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// What the privacy document claims, stated by the program instead
// ---------------------------------------------------------------------------

/**
 * Every path she can write to, resolved.
 *
 * Printed rather than described because the defaults are relative — `hers-profile`
 * and `data`, next to wherever you started her — so a document cannot know them
 * and this can. Copy a line out of here and open it; that is the whole point.
 *
 * The filenames come from {@link WRITERS} rather than from a string literal
 * here. The literal is what this used to be, and it had already drifted: it had
 * stopped listing `README.md` and `gallery/README.md`, both of which
 * `profile.ts` writes on every first run. `writers.test.ts` now fails if a
 * module writes something this list does not know about.
 */
function printFiles(config: Config): void {
  console.log('\n  Everything she keeps, and nowhere else');

  const roots: { root: Root; label: string; dir: string }[] = [
    { root: 'profile', label: 'profile', dir: config.profileDir },
    { root: 'data', label: 'memory', dir: config.dataDir },
    { root: 'cwd', label: 'keys', dir: path.dirname(envFilePath()) },
  ];

  for (const { root, label, dir } of roots) {
    const files = writesUnder(root);
    if (files.length === 0) continue;
    console.log('');
    // A root with one file gets the whole path on one line, because "the
    // directory your .env is in" is not what somebody looking for their .env
    // wants to be handed.
    if (files.length === 1) {
      note(`${label.padEnd(8)}  ${path.join(dir, files[0] ?? '')}`);
      continue;
    }
    note(`${label.padEnd(8)}  ${dir}`);
    for (const line of wrap(files.join('   '), 64)) note(`          ${line}`);
  }

  console.log('');
  note('Video frames and microphone audio appear nowhere above. They are encoded,');
  note('sent, and dropped — there is no buffer, cache, or debug dump to find.');
  note('Start over deletes the first two directories outright and never touches');
  note('the third, because the keys in it are yours rather than hers.');
}

/**
 * Every host this build can open a connection to.
 *
 * The list is {@link DESTINATIONS}, which a test holds against both the source
 * and `docs/PRIVACY.md` — so this is not a summary of the document, it is the
 * same statement from the other end. Where a host comes from configuration the
 * configured value is substituted, because by the time anyone runs this the
 * program knows it and prose still does not.
 */
function printDestinations(config: Config): void {
  console.log('\n  Every host this build can reach, and nothing else');

  // Grouped by host, because that is the unit a network monitor shows and the
  // unit a reader is checking against. A host counts as reachable if *any* of
  // the reasons it is listed for is switched on — the key check needs no key,
  // so Google stays reachable even on a fresh install with nothing configured.
  const byHost = new Map<string, typeof DESTINATIONS>();
  for (const destination of DESTINATIONS) {
    const host = resolveHost(destination.host, config);
    byHost.set(host, [...(byHost.get(host) ?? []), destination]);
  }

  for (const [host, reasons] of byHost) {
    const live = reasons.some((reason) => switchedOn(reason.requires, config));
    const off = reasons.find((reason) => !switchedOn(reason.requires, config));
    console.log('');
    note(`${live ? '→' : '·'} ${host}${live || !off ? '' : `   (off — needs ${requiresOf(off)})`}`);
    for (const reason of reasons) {
      for (const line of wrap(`${reason.what} ${reason.when}`, 66)) note(`    ${line}`);
      if (reason.fromPhone) {
        note('    Reached by the phone, not by this machine. A network monitor');
        note('    here will not show it; one on the phone will.');
      }
    }
  }

  console.log('');
  note('Nothing checks for updates, counts a launch, or reports a crash. If you');
  note('see a hostname that is not on this list, that is a bug worth reporting.');
}

/** Substitutes a configured host for the placeholder, when there is one. */
function resolveHost(host: string, config: Config): string {
  const configured =
    host === '<LIVEKIT_URL>'
      ? config.livekit?.url
      : host === '<HERS_CALL_PAGE_URL>'
        ? config.livekit?.callPageUrl
        : undefined;
  if (!configured) return host;
  try {
    return new URL(configured).host;
  } catch {
    // An unparseable value is still worth showing; it is what would be dialled.
    return configured;
  }
}

function switchedOn(requires: Requires | null, config: Config): boolean {
  switch (requires) {
    case 'gemini':
      return Boolean(config.geminiApiKey);
    case 'telegram':
      return Boolean(config.telegram);
    case 'livekit':
      return Boolean(config.livekit);
    case 'call-page':
      return Boolean(config.livekit?.callPageUrl);
    default:
      return true;
  }
}

/** Greedy wrap. The terminal is the only thing this has to satisfy. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

interface RoundTrip {
  ok: boolean;
  reason?: string;
  bytes?: number;
  ms?: number;
  said?: string;
}

function liveRoundTrip(apiKey: string, model: string): Promise<RoundTrip> {
  return new Promise((resolve) => {
    let bytes = 0;
    let said = '';
    let firstAudioAt = 0;
    const startedAt = Date.now();

    const finish = (result: RoundTrip) => {
      clearTimeout(deadline);
      void live.close().then(() => resolve(result));
    };

    const deadline = setTimeout(() => {
      finish(
        bytes > 0
          ? { ok: true, bytes, ms: firstAudioAt - startedAt, said }
          : { ok: false, reason: 'no audio within 25 seconds' },
      );
    }, 25_000);

    const live = new LiveConversation({
      apiKey,
      model,
      voice: 'Aoede',
      systemInstruction: () =>
        'You are being tested by a setup script. Reply with exactly: "I can hear you." Nothing else.',
      handlers: {
        onAudio: (pcm) => {
          if (bytes === 0) firstAudioAt = Date.now();
          bytes += pcm.length;
        },
        onUserText: () => undefined,
        onHerText: (text, final) => {
          if (final) said = text;
        },
        onTurnComplete: () => {
          if (bytes > 0) finish({ ok: true, bytes, ms: firstAudioAt - startedAt, said });
        },
        onInterrupted: () => undefined,
        onToolCall: async () => ({}),
        onState: (state) => {
          // The first reconnect during a check means the setup was rejected;
          // waiting out the backoff would only produce the same rejection.
          if (state === 'reconnecting') finish({ ok: false, reason: 'the session was refused' });
        },
        onTrouble: () => undefined,
      },
    });

    void live
      .start()
      .then(() => live.sendText('Say the test line.'))
      .catch((error: unknown) => finish({ ok: false, reason: String(error) }));
  });
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
