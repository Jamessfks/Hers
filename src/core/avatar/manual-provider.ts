/**
 * The provider that is a person.
 *
 * Every hosted adapter in video-provider.ts is a stub, and an interface with
 * nothing behind it is a claim rather than an abstraction — the exact criticism
 * docs/adr/0003-avatar-renderer.md makes of the existing `AvatarRendererId`
 * seam. This is the one implementation that makes the claim true, and it turns
 * out to also be the one most people should use first:
 *
 *  - Generation happens **once, at setup**. Nineteen clips pasted into whichever
 *    web UI the user already pays for is an afternoon, not a workflow, and it
 *    needs no key, no billing setup and no trust in this app with a card.
 *  - It is the only way to *look at each clip before accepting it*. Loop
 *    closure either worked or it did not, and a human can see that in one
 *    second and a program cannot see it at all — there is no cheap automatic
 *    check for "does the last frame match the first".
 *  - It costs nothing here, so the whole submit/poll/download path, the
 *    manifest, the resume logic and the fallback behaviour can be exercised end
 *    to end without spending a cent.
 *
 * The mechanism is a drop folder. `submit` writes the prompt out as a text file
 * to paste; `poll` watches for a video file named after the slot; `download`
 * reads it. The "job" is a human, which is the only reason the timeout below is
 * measured in hours.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildClipPrompt } from './prompts.ts';
import type { ClipSlotName } from './clips.ts';
import {
  VideoClipError,
  type ClipJobHandle,
  type ClipJobState,
  type ClipRequest,
  type SucceededState,
  type VideoClipProvider,
} from './video-provider.ts';

/** Containers a browser `<video>` will play, which is the only consumer. */
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.m4v'];

export function createManualProvider(dropDir: string): VideoClipProvider {
  const requireDir = (): string => {
    if (!dropDir) {
      throw new VideoClipError(
        'No folder is set for hand-made clips. Choose one in settings first.',
        { provider: 'manual' },
      );
    }
    return dropDir;
  };

  return {
    id: 'manual',
    label: 'Bring your own clips',
    cost: {
      // Whatever the user spends, they spend somewhere else, on their own
      // account, having seen the price first. Nothing here can bill them.
      usdPerClip: 0,
      assumedUsdPerClip: 0,
      pricingUrl: null,
      verified: true,
    },
    // A person, not a GPU. The build driver is not really the intended caller
    // here — the UI should re-poll when the user says they are done — but if
    // something does await one of these jobs, a day is long enough that the
    // timeout never fires spuriously and short enough that it is not forever.
    timeoutMs: 24 * 60 * 60 * 1000,

    async submit(request: ClipRequest): Promise<ClipJobHandle> {
      const dir = requireDir();
      await mkdir(dir, { recursive: true });

      // The instruction sheet is the actual product of this call: the prompts
      // are the expensive part of this module and they are useless locked
      // inside a process the user cannot see into.
      const built = buildClipPrompt(request.slot);
      await writeFile(
        join(dir, `${request.slot}.txt`),
        [
          `# ${request.slot}`,
          '',
          'Generate this clip from the source photograph, then save the result in',
          `this folder as ${request.slot}.mp4 (webm, mov and m4v also work).`,
          '',
          `Length: about ${request.seconds} seconds.`,
          '',
          '## Prompt',
          '',
          request.prompt || built.prompt,
          '',
          '## Negative prompt',
          '',
          request.avoid || built.avoid,
          '',
        ].join('\n'),
        'utf8',
      );

      return { providerId: 'manual', id: request.slot, submittedAt: Date.now() };
    },

    async poll(job: ClipJobHandle): Promise<ClipJobState> {
      const file = await findClipFile(requireDir(), job.id as ClipSlotName);
      if (file) return { status: 'succeeded', seconds: null, costUsd: 0 };
      return { status: 'running', progress: null };
    },

    async download(job: ClipJobHandle, _state: SucceededState): Promise<Uint8Array> {
      const dir = requireDir();
      const file = await findClipFile(dir, job.id as ClipSlotName);
      if (!file) {
        throw new VideoClipError(`No clip named ${job.id} in ${dir}.`, { provider: 'manual' });
      }
      return new Uint8Array(await readFile(join(dir, file)));
    },

    async validateKey() {
      if (!dropDir) return { ok: false, reason: 'Choose a folder for your clips first.' };
      try {
        await mkdir(dropDir, { recursive: true });
        return { ok: true as const };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : 'Unusable folder.' };
      }
    },
  };
}

/**
 * The first file in `dir` named after this slot, whatever its extension.
 *
 * Matching on extension rather than demanding `.mp4` is not politeness: the
 * vendors hand back different containers and a user who renamed nothing has
 * done nothing wrong. Returning the name rather than the path keeps the caller
 * in charge of where the library lives.
 */
async function findClipFile(dir: string, slot: ClipSlotName): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  for (const extension of VIDEO_EXTENSIONS) {
    const wanted = `${slot}${extension}`;
    if (entries.includes(wanted)) return wanted;
  }
  return null;
}
