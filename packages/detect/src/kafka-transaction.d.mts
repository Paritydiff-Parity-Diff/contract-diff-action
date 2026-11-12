export function validateKafkaTransaction(wire: Record<string, unknown>): Promise<{
  members: { frame: string; response: string; connectionId: string }[];
  hash: string;
}>;
