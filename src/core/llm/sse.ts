/**
 * A minimal Server-Sent Events reader.
 *
 * Every provider we support streams over SSE, and every provider frames it
 * slightly differently. Rather than take three SDK dependencies that each pull
 * in their own HTTP stack, we parse the wire format once, here, correctly.
 *
 * The one subtlety worth stating: network chunks do not respect event
 * boundaries. A single `read()` can deliver half an event, or six events plus
 * half of a seventh. Any parser that assumes otherwise works perfectly in
 * development against a fast local connection and drops tokens in the field.
 */

export interface SseEvent {
  event?: string;
  data: string;
}

/** Reads an SSE body and yields one event per `data:` block. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Events are separated by a blank line. \r\n is legal and Azure uses it.
      let boundary = findBoundary(buffer);
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const event = parseEvent(raw);
        if (event) yield event;
        boundary = findBoundary(buffer);
      }
    }
    const tail = parseEvent(buffer);
    if (tail) yield tail;
  } finally {
    reader.cancel().catch(() => {});
  }
}

function findBoundary(buffer: string): { index: number; length: number } | -1 {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return -1;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function parseEvent(raw: string): SseEvent | null {
  if (!raw.trim()) return null;
  let event: string | undefined;
  const data: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // Per spec a single leading space after the colon is stripped.
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }

  if (data.length === 0) return null;
  return event === undefined ? { data: data.join('\n') } : { event, data: data.join('\n') };
}

/** Parses JSON, returning null rather than throwing on a malformed frame. */
export function tryJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
