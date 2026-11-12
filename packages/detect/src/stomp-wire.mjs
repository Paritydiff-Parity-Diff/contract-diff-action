import { Parser } from '@stomp/stompjs';
const LIMIT = 1024 * 1024;
const invalid = () => new Error('stomp_wire_invalid');
const text = (bytes) => {
  const value = new TextDecoder('utf8', { fatal: true }).decode(bytes);
  if (value.includes('\0')) throw invalid();
  return value;
};
const unescape = (value) =>
  value.replace(/\\(.)|\\$/gs, (match, escaped) => {
    const values = { r: '\r', n: '\n', c: ':', '\\': '\\' };
    if (!Object.hasOwn(values, escaped)) throw invalid();
    return values[escaped];
  });
function structure(bytes) {
  let position = 0;
  const line = () => {
    const end = bytes.indexOf(10, position);
    if (end < 0) return undefined;
    if (end - position > 16384) throw invalid();
    const value = text(bytes.subarray(position, bytes[end - 1] === 13 ? end - 1 : end));
    if (value.includes('\r')) throw invalid();
    position = end + 1;
    return value;
  };
  const command = line();
  if (command === undefined) return;
  if (
    ![
      'CONNECT',
      'STOMP',
      'CONNECTED',
      'SEND',
      'SUBSCRIBE',
      'UNSUBSCRIBE',
      'ACK',
      'NACK',
      'BEGIN',
      'COMMIT',
      'ABORT',
      'DISCONNECT',
      'MESSAGE',
      'RECEIPT',
      'ERROR',
    ].includes(command)
  )
    throw invalid();
  const entries = [],
    first = new Map();
  const escaped = !['CONNECT', 'CONNECTED'].includes(command);
  for (;;) {
    const value = line();
    if (value === undefined) return;
    if (!value) break;
    if (entries.length >= 128) throw new Error('stomp_wire_header_limit');
    const colon = value.indexOf(':');
    if (colon < 1) throw invalid();
    const name = escaped ? unescape(value.slice(0, colon)) : value.slice(0, colon);
    const item = escaped ? unescape(value.slice(colon + 1)) : value.slice(colon + 1);
    entries.push([name, item]);
    if (!first.has(name)) first.set(name, item);
  }
  const length = first.get('content-length');
  let end;
  if (length !== undefined) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(length) || Number(length) > LIMIT) throw invalid();
    end = position + Number(length);
    if (bytes.length <= end) return;
    if (bytes[end] !== 0) throw invalid();
  } else {
    end = bytes.indexOf(0, position);
    if (end < 0) return;
  }
  if (!['SEND', 'MESSAGE', 'ERROR'].includes(command) && end !== position) throw invalid();
  return {
    length: end + 1,
    command,
    headers: Object.fromEntries(first),
    headerEntries: entries,
    body: bytes.subarray(position, end),
  };
}
export function decodeStompFrame(input) {
  if (!(input instanceof Uint8Array) || input.length > LIMIT) throw invalid();
  const bytes = Buffer.from(input),
    frame = structure(bytes);
  if (!frame || frame.length !== bytes.length) throw invalid();
  const parsed = [],
    parser = new Parser(
      (value) => parsed.push(value),
      () => {
        throw invalid();
      },
    );
  parser.parseChunk(bytes);
  if (
    parsed.length !== 1 ||
    parsed[0].command !== frame.command ||
    !Buffer.from(parsed[0].binaryBody).equals(frame.body) ||
    parsed[0].headers.length !== frame.headerEntries.length
  )
    throw invalid();
  return frame;
}
export function stompFrameStream(onFrame) {
  let pending = Buffer.alloc(0),
    count = 0;
  return {
    push(input) {
      if (!(input instanceof Uint8Array) || input.length > LIMIT) throw invalid();
      pending = Buffer.concat([pending, input]);
      if (pending.length > LIMIT) throw new Error('stomp_wire_frame_limit');
      for (;;) {
        while (pending[0] === 10 || (pending[0] === 13 && pending[1] === 10))
          pending = pending.subarray(pending[0] === 13 ? 2 : 1);
        if (!pending.length) return;
        const frame = structure(pending);
        if (!frame) return;
        if (++count > 4096) throw new Error('stomp_wire_frame_count_limit');
        const bytes = pending.subarray(0, frame.length);
        pending = pending.subarray(frame.length);
        onFrame(decodeStompFrame(bytes), bytes);
      }
    },
    finish() {
      if (pending.length) throw invalid();
    },
  };
}
