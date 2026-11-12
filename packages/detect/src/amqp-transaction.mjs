import { createHash } from 'node:crypto';
import { decodeAmqpFrame, amqpMethods as m } from './amqp-wire.mjs';
const reject = (reason) => {
  throw Object.assign(new Error(reason), { available: false });
};
const decode = (value) => {
  if (
    typeof value !== 'string' ||
    value.length > 1398104 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    reject('asyncapi_amqp_transaction_wire_unavailable');
  return decodeAmqpFrame(Buffer.from(value, 'base64'));
};
export function amqpTransaction(wire) {
  if (
    !Array.isArray(wire.setup) ||
    wire.setup.length !== 2 ||
    !Array.isArray(wire.transactionFrames) ||
    wire.transactionFrames.length < 4 ||
    wire.transactionFrames.length > 256
  )
    reject('asyncapi_amqp_transaction_incomplete');
  const values = [...wire.setup, ...wire.transactionFrames];
  if (
    values.some((value) => typeof value !== 'string') ||
    values.reduce((sum, value) => sum + value.length, 0) > 1398104
  )
    reject('asyncapi_amqp_transaction_limit');
  const [select, selected] = wire.setup.map(decode),
    frames = wire.transactionFrames.map(decode);
  if (
    select.id !== m.TxSelect ||
    selected.id !== m.TxSelectOk ||
    select.channel !== selected.channel ||
    !select.channel
  )
    reject('asyncapi_amqp_transaction_setup_invalid');
  if (
    frames.some((frame) => frame.channel !== select.channel) ||
    frames.at(-2).id !== m.TxCommit ||
    frames.at(-1).id !== m.TxCommitOk
  )
    reject('asyncapi_amqp_transaction_commit_invalid');
  const groups = [];
  for (let index = 0; index < frames.length - 2;) {
    const start = index,
      publish = frames[index++],
      header = frames[index++];
    if (
      publish?.id !== m.BasicPublish ||
      publish.fields.mandatory ||
      publish.fields.immediate ||
      header?.type !== 2
    )
      reject('asyncapi_amqp_transaction_publish_unavailable');
    let remaining = header.size;
    while (remaining > 0) {
      const body = frames[index++];
      if (body?.type !== 3 || !body.content.length || body.content.length > remaining)
        reject('asyncapi_amqp_transaction_content_invalid');
      remaining -= body.content.length;
    }
    if (index > frames.length - 2 || groups.length >= 16) reject('asyncapi_amqp_transaction_limit');
    groups.push(wire.transactionFrames.slice(start, index));
  }
  if (
    !Number.isSafeInteger(wire.transactionIndex) ||
    wire.transactionIndex < 0 ||
    wire.transactionIndex >= groups.length ||
    JSON.stringify(groups[wire.transactionIndex]) !== JSON.stringify(wire.frames) ||
    wire.acknowledgment !== undefined
  )
    reject('asyncapi_amqp_transaction_member_invalid');
  if (values.reduce((sum, value) => sum + value.length, 0) * groups.length > 1398104)
    reject('asyncapi_amqp_transaction_limit');
  return {
    groups,
    hash: createHash('sha256')
      .update(Buffer.concat(values.map((value) => Buffer.from(value, 'base64'))))
      .digest('hex'),
  };
}
