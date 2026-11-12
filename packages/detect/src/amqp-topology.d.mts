export function amqpDeclaration(
  topology: unknown,
  kind: 'queue' | 'exchange',
  name: string,
  channel: number,
): { fields: Record<string, unknown>; hash: string };
