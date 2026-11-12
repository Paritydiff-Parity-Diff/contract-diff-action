export const amqpMethods: {
  BasicPublish: number;
  BasicDeliver: number;
  BasicConsume: number;
  BasicConsumeOk: number;
  BasicAck: number;
  BasicNack: number;
  TxSelect: number;
  TxSelectOk: number;
  TxCommit: number;
  TxCommitOk: number;
  TxRollback: number;
  TxRollbackOk: number;
  QueueDeclare: number;
  QueueDeclareOk: number;
  ExchangeDeclare: number;
  ExchangeDeclareOk: number;
  encodeMethod(id: number, channel: number, fields: Record<string, unknown>): Buffer;
  encodeProperties(
    id: number,
    channel: number,
    size: number,
    fields: Record<string, unknown>,
  ): Buffer;
};
export function decodeAmqpFrame(input: Uint8Array): {
  type: number;
  channel: number;
  id?: number;
  size?: number;
  fields?: Record<string, unknown>;
  content?: Buffer;
};
export function amqpFrameStream(
  onFrame: (frame: ReturnType<typeof decodeAmqpFrame>, bytes: Buffer) => void,
  protocolHeader?: boolean,
): { push(input: Uint8Array): void; finish(): void };
