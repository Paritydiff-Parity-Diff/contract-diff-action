export interface KafkaBatch {
  records: {
    key: Buffer | null;
    value: Buffer | null;
    headers: [string, Buffer | null][];
    offsetDelta: number;
    timestampDelta: number;
  }[];
  codec: number;
  firstOffset: string;
  firstTimestamp: string;
  maxTimestamp: string;
  producerId: string;
  producerEpoch: number;
  firstSequence: number;
  transactional: boolean;
}
export interface KafkaProduce {
  version: number;
  correlationId: number;
  clientId: string | null;
  transactionalId: string | null;
  acks: number;
  timeout: number;
  topics: { topic: string; partitions: { partition: number; batches: KafkaBatch[] }[] }[];
}
export function decodeKafkaProduce(
  input: Uint8Array,
  options?: { allowTransactions?: boolean },
): Promise<KafkaProduce>;
export function decodeKafkaFetchExchange(
  request: Uint8Array,
  response: Uint8Array,
): Promise<{
  version: number;
  correlationId: number;
  clientId: string | null;
  isolation: number;
  records: {
    topic: string;
    partition: number;
    offset: string;
    record: KafkaBatch['records'][number];
  }[];
}>;
export function decodeKafkaProduceResponse(
  input: Uint8Array,
  version: number,
): {
  correlationId: number;
  topics: {
    topic: string;
    partitions: {
      partition: number;
      errorCode: number;
      baseOffset: string;
      logAppendTime: string;
      logStartOffset?: string;
    }[];
  }[];
};
export function kafkaFrameStream(onFrame: (bytes: Buffer) => void): {
  push(input: Uint8Array): void;
  finish(): void;
};
