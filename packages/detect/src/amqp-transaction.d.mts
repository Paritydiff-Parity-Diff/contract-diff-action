export function amqpTransaction(wire: Record<string, unknown>): {
  groups: string[][];
  hash: string;
};
