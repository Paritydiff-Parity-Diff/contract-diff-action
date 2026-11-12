import { createHash } from 'node:crypto';
import { parseLosslessJson } from '../../core/src/number-validation.mjs';
import { decodeStompFrame } from './stomp-wire.mjs';
import { avroBinaryContentType } from './asyncapi-avro.mjs';
import { protobufContentType } from './asyncapi-protobuf.mjs';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const unavailable = (reason) => Object.assign(new Error(reason), { available: false });
const invalid = (reason) => Object.assign(new Error(reason), { available: true });
const decode = (value) => {
  if (
    typeof value !== 'string' ||
    value.length > 1398104 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    throw unavailable('asyncapi_stomp_wire_unavailable');
  try {
    return decodeStompFrame(Buffer.from(value, 'base64'));
  } catch {
    throw invalid('asyncapi_stomp_wire_invalid');
  }
};
const protocolHeaders = new Set([
  'destination',
  'content-type',
  'content-length',
  'receipt',
  'transaction',
]);
export function stompWireInput(input) {
  const wire = input.transport.stomp;
  if (!wire) throw unavailable('asyncapi_stomp_wire_unavailable');
  const send = decode(wire.frame),
    connected = decode(wire.connected);
  if (connected.command !== 'CONNECTED' || connected.headers.version !== '1.2')
    throw unavailable('asyncapi_stomp_version_unavailable');
  const incoming = input.direction === 'output';
  if (
    send.command !== (incoming ? 'MESSAGE' : 'SEND') ||
    send.headers.destination !== input.transport.channel
  )
    throw invalid('asyncapi_stomp_destination_mismatch');
  if (incoming) {
    const subscription = decode(wire.subscription);
    if (
      subscription.command !== 'SUBSCRIBE' ||
      subscription.headers.destination !== send.headers.destination ||
      !subscription.headers.id ||
      subscription.headers.id !== send.headers.subscription ||
      !send.headers['message-id']
    )
      throw invalid('asyncapi_stomp_subscription_mismatch');
    const mode = subscription.headers.ack ?? 'auto';
    if (mode !== 'auto') {
      if (mode !== 'client-individual')
        throw unavailable('asyncapi_stomp_cumulative_ack_unavailable');
      const acknowledgment = decode(wire.acknowledgment),
        receipt = decode(wire.receipt);
      if (
        acknowledgment.command !== 'ACK' ||
        acknowledgment.headers.id !== send.headers.ack ||
        !send.headers.ack ||
        acknowledgment.headers.transaction !== undefined ||
        !acknowledgment.headers.receipt ||
        receipt.command !== 'RECEIPT' ||
        receipt.headers['receipt-id'] !== acknowledgment.headers.receipt
      )
        throw invalid('asyncapi_stomp_acknowledgment_invalid');
    } else if (wire.acknowledgment !== undefined)
      throw invalid('asyncapi_stomp_acknowledgment_invalid');
  }
  let transactionHash;
  if (send.headers.transaction !== undefined) {
    if (
      !Array.isArray(wire.transactionFrames) ||
      wire.transactionFrames.length < 3 ||
      wire.transactionFrames.length > 256 ||
      wire.transactionReceipt === undefined
    )
      throw unavailable('asyncapi_stomp_transaction_incomplete');
    let size = 0;
    const frames = wire.transactionFrames.map((value) => {
        const frame = decode(value);
        size += Buffer.from(value, 'base64').length;
        if (size > 1024 * 1024) throw unavailable('asyncapi_stomp_transaction_limit');
        return frame;
      }),
      begin = frames[0],
      commit = frames.at(-1),
      receipt = decode(wire.transactionReceipt),
      id = send.headers.transaction;
    if (
      !id ||
      id.length > 256 ||
      begin.command !== 'BEGIN' ||
      commit.command !== 'COMMIT' ||
      begin.headers.transaction !== id ||
      commit.headers.transaction !== id ||
      begin.headers.receipt !== undefined ||
      !commit.headers.receipt ||
      [begin, commit].some((frame) =>
        frame.headerEntries.some(
          ([name]) => !['transaction', 'receipt', 'content-length'].includes(name),
        ),
      )
    )
      throw invalid('asyncapi_stomp_transaction_invalid');
    const members = frames.slice(1, -1),
      ids = new Set();
    if (
      members.some(
        (frame) =>
          frame.command !== 'SEND' || frame.headers.transaction !== id || !frame.headers.receipt,
      ) ||
      wire.transactionFrames.filter((value) => value === wire.frame).length !== 1
    )
      throw invalid('asyncapi_stomp_transaction_member_mismatch');
    for (const frame of [...members, commit]) {
      if (ids.has(frame.headers.receipt))
        throw invalid('asyncapi_stomp_transaction_receipt_reused');
      ids.add(frame.headers.receipt);
    }
    if (receipt.command !== 'RECEIPT' || receipt.headers['receipt-id'] !== commit.headers.receipt)
      throw invalid('asyncapi_stomp_transaction_receipt_mismatch');
    transactionHash = hash(
      Buffer.concat(
        [...wire.transactionFrames, wire.transactionReceipt].map((value) =>
          Buffer.from(value, 'base64'),
        ),
      ),
    );
  } else if (wire.transactionFrames !== undefined || wire.transactionReceipt !== undefined)
    throw unavailable('asyncapi_stomp_transaction_context_unavailable');
  if (!incoming) {
    if (!send.headers.receipt || wire.receipt === undefined)
      throw unavailable('asyncapi_stomp_delivery_incomplete');
    const receipt = decode(wire.receipt);
    if (receipt.command !== 'RECEIPT' || receipt.headers['receipt-id'] !== send.headers.receipt)
      throw invalid('asyncapi_stomp_receipt_mismatch');
  }
  const avro =
    avroBinaryContentType(send.headers['content-type']) ||
    protobufContentType(send.headers['content-type']);
  if (!avro && !/^application\/(?:[^;]+\+)?json(?:;|$)/i.test(send.headers['content-type'] ?? ''))
    throw unavailable('asyncapi_stomp_payload_codec_unavailable');
  let payload;
  try {
    if (!avro)
      payload = parseLosslessJson(new TextDecoder('utf8', { fatal: true }).decode(send.body));
  } catch (error) {
    throw error.message.endsWith('_unavailable')
      ? unavailable(error.message)
      : invalid('asyncapi_stomp_payload_invalid');
  }
  return {
    ...input,
    payload,
    payloadBytesBase64: send.body.toString('base64'),
    transport: {
      ...input.transport,
      protocolVersion: '1.2',
      contentType: send.headers['content-type'],
      headers: Object.fromEntries(
        Object.entries(send.headers).filter(
          ([name]) =>
            !protocolHeaders.has(name) &&
            !(incoming && ['message-id', 'subscription', 'ack'].includes(name)),
        ),
      ),
      stomp: {
        ...wire,
        send,
        packetHash: hash(Buffer.from(wire.frame, 'base64')),
        transactionHash,
      },
    },
  };
}
export function validateStompBindings(model, message, servers) {
  const bindings = [
    model.bindings.stomp,
    model.channelBindings.stomp,
    message.bindings.stomp,
    ...servers.map((server) => server.bindings.stomp),
  ];
  if (bindings.some((value) => value && Object.keys(value).length))
    throw unavailable('asyncapi_stomp_binding_unavailable');
}
