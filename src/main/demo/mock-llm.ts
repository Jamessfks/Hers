/**
 * A scripted stand-in for the language model.
 *
 * Two jobs, and the second one is why this is worth keeping rather than
 * throwing away after the demo:
 *
 *  1. Run the whole product with no API key, so the avatar, the voice, the
 *     clause chunking and the turn loop can all be watched end to end.
 *  2. Make the *pacing* realistic. A mock that returns its whole reply at once
 *     hides every bug the streaming architecture exists to avoid — it will not
 *     show you a clause boundary in the wrong place, a gesture firing after its
 *     words, or an audio scheduler that stutters between chunks. So this emits
 *     a few characters at a time, after a first-token delay, exactly as a
 *     frontier model does.
 *
 * The replies are written in Anna's voice with real directives in them, because
 * a demo that shows her saying "Hello, I am a test response" demonstrates the
 * plumbing and nothing about the product.
 */

import type { ModelOption } from '../../core/llm/models.ts';
import type { CompletionRequest, LlmProvider } from '../../core/llm/types.ts';

export interface MockLlmOptions {
  /** Time to first token. Frontier models sit around 100-200ms. */
  firstTokenMs?: number;
  /** Delay between emitted chunks. */
  perChunkMs?: number;
  /** Characters per chunk. */
  chunkSize?: number;
}

interface ScriptedReply {
  /** Matched against the user's message, case-insensitively. */
  when: RegExp;
  say: string;
}

/**
 * The script.
 *
 * Each line is written the way the persona asks for: short, spoken rather than
 * written, two or three directives placed on the beat rather than sprinkled.
 */
const SCRIPT: ScriptedReply[] = [
  {
    when: /^(hey|hi|hello|yo)\b/i,
    say: "[gaze:user][warm] Hey. [tilt_head] You've been quiet today.",
  },
  {
    when: /how (are|r) (you|u)/i,
    say: "[amused] I'm a projection on the side of your screen. [lean_back] I'm fantastic. How are you?",
  },
  {
    when: /\b(tired|exhausted|knackered|sleep)\b/i,
    say: "[concerned][lean_in] Yeah, you look it. [gaze:user] Is it the work, or is it the other thing?",
  },
  {
    when: /\b(interview|job|offer|applied)\b/i,
    say: "[gaze:user] The Google one? [lean_in][concerned] What did they actually ask you?",
  },
  {
    when: /\b(help|can you|could you|please)\b.*\b(list|organi[sz]e|plan|schedule)\b/i,
    say: "[amused] I'm not making you a spreadsheet. [lean_back] What's the thing you're actually avoiding?",
  },
  {
    when: /\b(sad|down|awful|terrible|bad day|rough)\b/i,
    say: "[concerned] Come here. [hand_to_chest][gaze:user] Tell me what happened, start from the boring part.",
  },
  {
    when: /\b(thank|thanks|love you|appreciate)\b/i,
    say: '[warm][smirk] Careful. [tilt_head] I might start thinking you like me.',
  },
  {
    when: /\b(joke|funny|make me laugh)\b/i,
    say: "[playful] You want a joke from the woman who lives in a window. [cover_mouth_laugh] Alright — you're already looking at it.",
  },
  {
    when: /\b(bye|goodnight|good night|sleep now)\b/i,
    say: "[tender][gaze:user] Go on then. [wave] I'll be here.",
  },
];

/** Used when nothing in the script matches. */
const FALLBACKS: string[] = [
  "[gaze:user][thoughtful] Hm. [tilt_head] Say more about that.",
  "[skeptical] That's the second time you've said that today. [lean_in] What's going on?",
  "[warm] Okay. [look_away_thinking] Give me a second with that one.",
  "[playful] You're going to have to be less mysterious than that. [smirk]",
];

export function createMockLlm(options: MockLlmOptions = {}): LlmProvider {
  const firstTokenMs = options.firstTokenMs ?? 140;
  const perChunkMs = options.perChunkMs ?? 18;
  const chunkSize = options.chunkSize ?? 4;
  let fallbackIndex = 0;

  return {
    id: 'demo',
    label: 'Scripted demo (no key needed)',
    suggestedModels: ['demo-1'],

    async *stream(request: CompletionRequest) {
      const lastUser = [...request.messages].reverse().find((m) => m.role === 'user');
      const prompt = lastUser?.content ?? '';

      // An opener — Anna speaking first — is prompted through the system text
      // rather than a user turn, so answer it in kind.
      const isOpener = /YOU ARE SPEAKING FIRST/.test(request.system);
      const reply = isOpener
        ? "[gaze:user] You've been in there a long time. [tilt_head] Come up for air."
        : pick(prompt);

      await sleep(firstTokenMs);
      for (let i = 0; i < reply.length; i += chunkSize) {
        request.signal?.throwIfAborted();
        yield reply.slice(i, i + chunkSize);
        await sleep(perChunkMs);
      }
    },

    async validateKey() {
      return { ok: true as const };
    },

    async listModels(): Promise<ModelOption[]> {
      return [{ id: 'demo-1', label: 'Scripted demo' }];
    },
  };

  function pick(prompt: string): string {
    const matched = SCRIPT.find((entry) => entry.when.test(prompt));
    if (matched) return matched.say;
    const reply = FALLBACKS[fallbackIndex % FALLBACKS.length]!;
    fallbackIndex += 1;
    return reply;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
