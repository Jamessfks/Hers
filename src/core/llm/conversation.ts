/**
 * Turning a transcript into a message list a provider will actually accept.
 *
 * This exists because of two bugs that made long conversations fail hard, both
 * found by auditing a real session rather than by reading:
 *
 *  1. **The window can start on an assistant turn.** The transcript is capped
 *     at N turns and sliced by row count. With strict alternation the slice
 *     boundary lands on one of Anna's turns every other exchange, so
 *     `messages[0].role === 'assistant'` — which Anthropic rejects outright.
 *     From roughly the thirteenth exchange onward *every* request 400s and the
 *     conversation is over.
 *
 *  2. **Two same-role turns can end up adjacent.** The user's turn is recorded
 *     immediately; Anna's only after her audio finishes. Interrupt her, or let
 *     a turn fail, and the store holds user→user. Anthropic rejects consecutive
 *     same-role messages, so once that happens the session cannot recover on
 *     its own — which is precisely what "it just stopped working" looks like.
 *
 * Rather than making the store enforce an invariant it cannot guarantee (a
 * reply genuinely may never arrive), the repair happens here, at the boundary
 * where the constraint actually applies.
 */

import type { ChatMessage } from './types.ts';

export interface TranscriptTurn {
  speaker: 'user' | 'anna';
  text: string;
}

/**
 * Builds a valid, alternating message list ending with the most recent turn.
 *
 * Guarantees, all of them tested:
 *   - the first message is always `user`, or the list is empty;
 *   - no two adjacent messages share a role;
 *   - no message has empty content;
 *   - the most recent turns are kept when the list is trimmed.
 */
export function toConversation(
  turns: readonly TranscriptTurn[],
  options: { maxMessages?: number } = {},
): ChatMessage[] {
  const max = Math.max(1, options.maxMessages ?? 24);

  const messages: ChatMessage[] = [];
  for (const turn of turns) {
    const content = turn.text.trim();
    if (!content) continue;
    const role = turn.speaker === 'user' ? 'user' : 'assistant';
    const previous = messages.at(-1);

    if (previous?.role === role) {
      // Two of hers in a row, or two of his. Join rather than drop: both halves
      // were really said, and dropping one silently loses context.
      previous.content = `${previous.content}\n${content}`;
      continue;
    }
    messages.push({ role, content });
  }

  // Trim from the front, keeping the newest — then repair the front, because
  // trimming is exactly what can expose a leading assistant message.
  const trimmed = messages.slice(-max);
  while (trimmed.length > 0 && trimmed[0]?.role !== 'user') trimmed.shift();
  return trimmed;
}

/**
 * Last line of defence before a request goes out.
 *
 * Returns the problem as a string, or null when the list is valid. Cheap enough
 * to run on every turn, and it converts a vendor 400 — which reaches the user
 * as an opaque red banner — into something a log can explain.
 */
export function validateConversation(messages: readonly ChatMessage[]): string | null {
  if (messages.length === 0) return 'no messages';
  if (messages[0]?.role !== 'user') return `first message is ${messages[0]?.role}, must be user`;
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;
    if (!message.content.trim()) return `message ${i} is empty`;
    if (i > 0 && message.role === messages[i - 1]?.role) {
      return `messages ${i - 1} and ${i} are both ${message.role}`;
    }
  }
  return null;
}
