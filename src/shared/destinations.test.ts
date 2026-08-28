import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { DESTINATIONS, MENTIONED_ONLY, destinationHosts } from './destinations.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The code that runs: the server, the browser bundle, the phone's call page,
 * and the scripts. Tests are excluded because they are full of hostnames that
 * exist to be refused — `https://evil.example` is the point of the origin test,
 * not an outbound call.
 */
const SCANNED = ['src', 'scripts', 'call'];

/** Anything that looks like a URL, whatever it is embedded in. */
const URL_LITERAL = /(?:https?|wss?):\/\/([A-Za-z0-9._~%-]+)/g;

function sourceFiles(): string[] {
  const found: string[] = [];
  for (const dir of SCANNED) {
    for (const entry of readdirSync(path.join(root, dir), {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!entry.isFile()) continue;
      if (!/\.(ts|js|mjs|html)$/.test(entry.name)) continue;
      if (entry.name.endsWith('.test.ts')) continue;
      found.push(path.join(entry.parentPath, entry.name));
    }
  }
  return found;
}

/** Every hostname literal in the source, with the file it came from. */
function hostsInSource(): Map<string, string[]> {
  const hosts = new Map<string, string[]>();
  for (const file of sourceFiles()) {
    const text = readFileSync(file, 'utf8');
    for (const [, host] of text.matchAll(URL_LITERAL)) {
      if (!host) continue;
      // A template literal that interpolates its host says nothing here; the
      // constant it is built from is matched on its own line.
      if (host.includes('$')) continue;
      const where = hosts.get(host) ?? [];
      where.push(path.relative(root, file));
      hosts.set(host, where);
    }
  }
  return hosts;
}

test('no hostname appears in the source that is not accounted for', () => {
  const known = new Set([...destinationHosts(), ...MENTIONED_ONLY.map((entry) => entry.host)]);

  for (const [host, files] of hostsInSource()) {
    assert.ok(
      known.has(host),
      `${host} appears in ${files.join(', ')} and is in neither DESTINATIONS nor MENTIONED_ONLY. ` +
        'If the program dials it, add it to DESTINATIONS and to docs/PRIVACY.md. If it is a ' +
        'documentation link or something a person clicks, add it to MENTIONED_ONLY.',
    );
  }
});

test('the two lists do not overlap', () => {
  // A host cannot be both dialled and merely mentioned; that would make the
  // first list a claim nobody can check.
  const dialled = new Set(destinationHosts());
  for (const { host } of MENTIONED_ONLY) {
    assert.ok(!dialled.has(host), `${host} is in both lists`);
  }
});

test('every hostname the program can dial is named in docs/PRIVACY.md', () => {
  // The document is what a reader trusts. This is what stops it from being the
  // last thing anyone remembers to change.
  const privacy = readFileSync(path.join(root, 'docs', 'PRIVACY.md'), 'utf8');
  for (const host of destinationHosts()) {
    // Angle brackets mark a host that comes from configuration; the document
    // names the variable rather than a value it cannot know.
    const needle = host.replace(/[<>]/g, '');
    assert.ok(privacy.includes(needle), `docs/PRIVACY.md never mentions ${needle}`);
  }
});

test('each destination says what is sent and what triggers it', () => {
  // Both fields go straight into `npm run doctor` and into the document, so an
  // empty one is a hostname with no explanation attached — which is the thing
  // this whole file exists to prevent.
  for (const destination of DESTINATIONS) {
    assert.ok(destination.host.length > 0);
    assert.match(destination.what, /\S.*\.$/s, `${destination.host}: "${destination.what}"`);
    assert.match(destination.when, /\S.*\.$/s, `${destination.host}: "${destination.when}"`);
  }
});

test('the one destination reached from a phone is marked as such', () => {
  /*
   * It is not visible to a network monitor on this machine, so a document that
   * lumps it in with the rest is telling the reader to look in the wrong place.
   *
   * There were two. The other was `cdn.jsdelivr.net`, which the call page
   * imported LiveKit's client from at run time — the hardest outbound request in
   * this project to notice, because the phone made it and no monitor here would
   * ever have shown it. The library is a devDependency now, copied in beside the
   * page at build time, so the only thing the phone still fetches is the page
   * you told it to open.
   */
  const phone = DESTINATIONS.filter((destination) => destination.fromPhone);
  assert.deepEqual(
    phone.map((destination) => destination.host),
    ['<HERS_CALL_PAGE_URL>'],
  );
});
