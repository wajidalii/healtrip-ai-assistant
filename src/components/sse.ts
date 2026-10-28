/**
 * Minimal Server-Sent Events parser over a fetch body.
 *
 * Kept free of React so it can be unit-tested with a plain ReadableStream.
 * Follows the SSE wire format used by docs/API.md: `event:` + `data:` lines,
 * blank-line delimited, `:` comment lines ignored. Multi-line `data:` is
 * joined with "\n" per the spec.
 */
export type SseMessage = { event: string; data: string };

export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let dataLines: string[] = [];

  const flush = (): SseMessage | null => {
    if (dataLines.length === 0) {
      event = "message";
      return null;
    }
    const msg = { event, data: dataLines.join("\n") };
    event = "message";
    dataLines = [];
    return msg;
  };

  const handleLine = (line: string): SseMessage | null => {
    if (line === "") return flush();
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
    // `id` and `retry` are not used by this API; other fields are ignored.
    return null;
  };

  /**
   * Removes and returns the next complete line, accepting LF, CRLF or CR
   * terminators. A lone trailing CR is kept back because its LF partner may be
   * in the next chunk; treating it as a terminator early would inject a blank
   * line and dispatch a half-built event.
   */
  const takeLine = (): string | null => {
    for (let i = 0; i < buffer.length; i++) {
      const ch = buffer[i];
      if (ch === "\n") {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        return line;
      }
      if (ch === "\r") {
        if (i === buffer.length - 1) return null;
        const line = buffer.slice(0, i);
        buffer = buffer.slice(buffer[i + 1] === "\n" ? i + 2 : i + 1);
        return line;
      }
    }
    return null;
  };

  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let line = takeLine(); line !== null; line = takeLine()) {
        const msg = handleLine(line);
        if (msg) yield msg;
      }
    }
    // Stream ended: a trailing lone CR is a terminator now that no LF can
    // follow it, so a frame closed by a bare CR is still dispatched.
    buffer += decoder.decode();
    if (buffer.endsWith("\r")) buffer = buffer.slice(0, -1) + "\n";
    for (let line = takeLine(); line !== null; line = takeLine()) {
      const msg = handleLine(line);
      if (msg) yield msg;
    }
    // Anything left (an unterminated line or an event with no closing blank
    // line) is discarded per the SSE spec. The server always terminates its
    // frames, so this can only be a truncated frame from a dropped connection;
    // delivering it would hand half a payload to the decoder.
  } finally {
    reader.releaseLock();
  }
}
