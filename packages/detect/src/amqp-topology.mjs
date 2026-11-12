import { createHash } from 'node:crypto';
import { decodeAmqpFrame, amqpMethods as m } from './amqp-wire.mjs';
const unavailable = (reason) => Object.assign(new Error(reason), { available: false });
const invalid = (reason) => Object.assign(new Error(reason), { available: true });
export function amqpDeclaration(topology, kind, name, channel) {
  if (!Array.isArray(topology) || topology.length > 64)
    throw unavailable('asyncapi_amqp_declaration_unavailable');
  const declarations = [];
  let bytes = 0;
  for (const pair of topology) {
    if (!Array.isArray(pair) || pair.length !== 2)
      throw unavailable('asyncapi_amqp_declaration_unavailable');
    const frames = pair.map((value) => {
      if (
        typeof value !== 'string' ||
        value.length > 87384 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
      )
        throw unavailable('asyncapi_amqp_declaration_unavailable');
      const frame = Buffer.from(value, 'base64');
      bytes += frame.length;
      if (bytes > 65536) throw unavailable('asyncapi_amqp_declaration_limit');
      try {
        return decodeAmqpFrame(frame);
      } catch {
        throw invalid('asyncapi_amqp_declaration_invalid');
      }
    });
    const [request, response] = frames;
    const queue = request.id === m.QueueDeclare;
    if (
      (!queue && request.id !== m.ExchangeDeclare) ||
      response.id !== (queue ? m.QueueDeclareOk : m.ExchangeDeclareOk) ||
      !channel ||
      request.channel !== channel ||
      response.channel !== channel ||
      request.fields.passive ||
      request.fields.nowait ||
      (queue &&
        (!response.fields.queue ||
          (request.fields.queue && request.fields.queue !== response.fields.queue)))
    )
      throw invalid('asyncapi_amqp_declaration_invalid');
    declarations.push({
      kind: queue ? 'queue' : 'exchange',
      name: queue ? response.fields.queue : request.fields.exchange,
      fields: request.fields,
      pair,
    });
  }
  const matches = declarations.filter((value) => value.kind === kind && value.name === name);
  if (matches.length !== 1) throw unavailable('asyncapi_amqp_declaration_identity_unavailable');
  return {
    fields: matches[0].fields,
    hash: createHash('sha256')
      .update(Buffer.concat(matches[0].pair.map((value) => Buffer.from(value, 'base64'))))
      .digest('hex'),
  };
}
