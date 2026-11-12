import { contentHash, type OasdiffChange } from '@paritydiff/core';
import { object } from './contract-tree';
import { matchesMimeType, parseMimeType } from './mime-wire.mjs';

function restrictsContentType(before: unknown, after: unknown): boolean {
  if (before === after || typeof before !== 'string' || typeof after !== 'string') return false;
  try {
    return !matchesMimeType(after, parseMimeType(before));
  } catch {
    return false;
  }
}

function bindings(document: unknown): Record<string, unknown>[] {
  const root = object(document),
    values = root?.['x-paritydiff-asyncapi-bindings'];
  return root?.['x-paritydiff-source-format'] === 'asyncapi' && Array.isArray(values)
    ? values.map(object).filter((value): value is Record<string, unknown> => Boolean(value))
    : [];
}
export function asyncapiChanges(before: unknown, after: unknown): OasdiffChange[] {
  const old = bindings(before),
    next = bindings(after),
    output: OasdiffChange[] = [];
  for (const previous of old) {
    const path = previous['path'];
    if (typeof path !== 'string') continue;
    const candidates = next.filter((value) => value['path'] === path);
    if (old.filter((value) => value['path'] === path).length !== 1 || candidates.length !== 1)
      continue;
    const current = candidates[0]!;
    const emit = (id: string, field: string, from: unknown, to: unknown, level: number) => {
      output.push({
        id,
        path,
        operation: 'POST',
        fieldPath: '/native-binding/' + field,
        level,
        text:
          'Declared AsyncAPI ' +
          field +
          ' changed: ' +
          JSON.stringify(from) +
          ' -> ' +
          JSON.stringify(to),
        fingerprint: contentHash(id, path, field, from, to),
      });
    };
    const at = (value: unknown, path: readonly string[]): unknown =>
      path.reduce<unknown>((current, name) => object(current)?.[name], value);
    const scalars = (from: unknown, to: unknown, scope: string, paths: readonly string[][]) => {
      for (const path of paths) {
        const before = at(from, path),
          after = at(to, path);
        const changed =
          path.at(-1) === 'contentType' && typeof before === 'string' && typeof after === 'string'
            ? restrictsContentType(before, after)
            : before !== after;
        if (['string', 'number', 'boolean'].includes(typeof after) && changed)
          emit(
            'native-asyncapi-wire-binding-changed',
            scope + '/' + path.join('/'),
            before,
            after,
            3,
          );
      }
    };
    scalars(previous, current, 'operation', [
      ['bindings', 'mqtt', 'qos'],
      ['bindings', 'mqtt', 'retain'],
      ['bindings', 'mqtt', 'messageExpiryInterval'],
      ...['userId', 'priority', 'deliveryMode', 'expiration', 'mandatory', 'timestamp'].map(
        (name) => ['bindings', 'amqp', name],
      ),
      ['channelBindings', 'amqp', 'is'],
      ['channelBindings', 'amqp', 'queue', 'name'],
      ['channelBindings', 'amqp', 'queue', 'vhost'],
      ['channelBindings', 'amqp', 'exchange', 'name'],
      ['channelBindings', 'amqp', 'exchange', 'vhost'],
      ...['durable', 'exclusive', 'autoDelete'].map((name) => [
        'channelBindings',
        'amqp',
        'queue',
        name,
      ]),
      ...['type', 'durable', 'autoDelete'].map((name) => [
        'channelBindings',
        'amqp',
        'exchange',
        name,
      ]),
      ['channelBindings', 'kafka', 'topic'],
    ]);
    const messages = (value: unknown) =>
      Array.isArray(value)
        ? value.map(object).filter((entry): entry is Record<string, unknown> => Boolean(entry))
        : [];
    const messageChanges = (from: unknown, to: unknown, scope: string) => {
      const oldMessages = messages(from),
        newMessages = messages(to);
      for (const message of oldMessages) {
        if (
          !message['allowed'] ||
          oldMessages.filter((item) => item['id'] === message['id']).length !== 1
        )
          continue;
        const matches = newMessages.filter((item) => item['id'] === message['id']),
          name = String(message['id']).replace(/~/g, '~0').replace(/\//g, '~1'),
          field = scope + '/' + name;
        if (!matches.length || (matches.length === 1 && !matches[0]!['allowed'])) {
          emit('native-asyncapi-message-removed', field, message['id'], undefined, 3);
          continue;
        }
        if (matches.length !== 1) continue;
        const next = matches[0]!;
        for (const [key, id] of [
          ['contentType', 'content-type'],
          ['correlation', 'correlation'],
        ] as const)
          if (
            key === 'contentType'
              ? restrictsContentType(message[key], next[key])
              : message[key] !== undefined && next[key] !== undefined && message[key] !== next[key]
          )
            emit(
              'native-asyncapi-message-' + id + '-changed',
              field + '/' + key,
              message[key],
              next[key],
              3,
            );
        scalars(message, next, field, [
          ...['payloadFormatIndicator', 'contentType', 'responseTopic'].map((name) => [
            'bindings',
            'mqtt',
            name,
          ]),
          ...['contentEncoding', 'messageType'].map((name) => ['bindings', 'amqp', name]),
        ]);
      }
    };
    messageChanges(previous['messages'], current['messages'], 'messages');
    for (const field of ['address', 'direction'])
      if (contentHash(previous[field]) !== contentHash(current[field]))
        emit('native-asyncapi-' + field + '-changed', field, previous[field], current[field], 3);
    const oldReply = object(previous['reply']),
      newReply = object(current['reply']);
    if (oldReply && !newReply)
      emit('native-asyncapi-reply-removed', 'reply', oldReply, undefined, 3);
    if (oldReply?.['available'] && newReply?.['available']) {
      messageChanges(oldReply['messages'], newReply['messages'], 'reply/messages');
      const address = (reply: Record<string, unknown>) => [
        reply['address'],
        reply['addressLocation'],
      ];
      if (contentHash(address(oldReply)) !== contentHash(address(newReply)))
        emit(
          'native-asyncapi-reply-address-changed',
          'reply/address',
          address(oldReply),
          address(newReply),
          3,
        );
      const messages = (reply: Record<string, unknown>) =>
        Array.isArray(reply['messages'])
          ? reply['messages']
              .map(object)
              .filter((value): value is Record<string, unknown> => Boolean(value))
          : [];
      for (const message of messages(oldReply)) {
        const matching = messages(newReply).filter((next) => next['id'] === message['id']);
        if (matching.length !== 1) continue;
        const oldStatus = object(object(message['bindings'])?.['http'])?.['statusCode'];
        const newStatus = object(object(matching[0]!['bindings'])?.['http'])?.['statusCode'];
        if (oldStatus !== undefined && newStatus !== undefined && oldStatus !== newStatus)
          emit(
            'native-asyncapi-reply-status-changed',
            'reply/messages/' + String(message['id']) + '/statusCode',
            oldStatus,
            newStatus,
            3,
          );
      }
    }
    const servers = (value: unknown) =>
      Array.isArray(value)
        ? value.map(object).filter((entry): entry is Record<string, unknown> => Boolean(entry))
        : [];
    const from = servers(previous['servers']),
      to = servers(current['servers']);
    if (
      from.length &&
      from.some(
        (server) =>
          !to.some(
            (candidate) =>
              candidate['url'] === server['url'] &&
              candidate['protocol'] === server['protocol'] &&
              (!candidate['version'] || candidate['version'] === server['version']),
          ),
      )
    )
      emit('native-asyncapi-server-removed', 'servers', previous['servers'], current['servers'], 3);
    const earlierHttp = object(object(previous['bindings'])?.['http']),
      currentHttp = object(object(current['bindings'])?.['http']);
    if (
      earlierHttp?.['method'] !== currentHttp?.['method'] &&
      earlierHttp?.['method'] &&
      currentHttp?.['method']
    )
      emit(
        'native-asyncapi-http-method-changed',
        'http/method',
        earlierHttp['method'],
        currentHttp['method'],
        3,
      );
    for (const field of [
      'parameters',
      'bindings',
      'channelBindings',
      'messages',
      'reply',
      'servers',
    ])
      if (contentHash(previous[field]) !== contentHash(current[field]))
        emit('native-asyncapi-coverage-incomplete', field, previous[field], current[field], 2);
  }
  return output;
}
