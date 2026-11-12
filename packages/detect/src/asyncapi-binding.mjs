import { createHash } from 'node:crypto';
import { compiler } from './semantic-compare.mjs';
import { createAsyncapiSchemas } from './asyncapi-schemas.mjs';
import { parseMimeType, matchesMimeType } from './mime-wire.mjs';
import { mqttWireInput, validateMqttBindings } from './asyncapi-mqtt.mjs';
import { amqpWireInput, validateAmqpBindings } from './asyncapi-amqp.mjs';
import { stompWireInput, validateStompBindings } from './asyncapi-stomp.mjs';
import { validateKafkaBindings } from './asyncapi-kafka.mjs';
import { validateAvroPayload } from './asyncapi-avro.mjs';
import { validateAsyncapiProtobuf } from './asyncapi-protobuf.mjs';
import { validateRamlPayload } from './asyncapi-raml.mjs';
import { compileAsyncapiDiscriminator } from './asyncapi-discriminator.mjs';
import {
  httpApplicationHeaders,
  selectAsyncapiServers,
  validateHttpBindings,
  validateHttpApplicationHeaders,
} from './asyncapi-http.mjs';
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const escape = (value) => value.replace(/~/g, '~0').replace(/\//g, '~1');
const invalid = (reason) => Object.assign(new Error(reason), { available: true });
const unavailable = (reason) => Object.assign(new Error(reason), { available: false });
const hash = (value) => createHash('sha256').update(value).digest('hex');
function mergePatch(left, right, depth = 0) {
  if (depth > 64) throw unavailable('asyncapi_trait_resource_limit');
  if (!object(right)) return structuredClone(right);
  const result = new Map(object(left) ? Object.entries(left) : []);
  for (const [key, value] of Object.entries(right)) {
    if (value === null) result.delete(key);
    else result.set(key, mergePatch(result.get(key), value, depth + 1));
  }
  return Object.fromEntries(result);
}
export function extractAsyncapiBindings(source, parsed, issues) {
  const store = createAsyncapiSchemas(source),
    output = [],
    isV3 = String(source.asyncapi).startsWith('3.');
  const protocolFields = (pointer) => {
    const resolved = store.protocolObject(pointer);
    if (!object(resolved.node)) throw unavailable('asyncapi_protocol_object_unavailable');
    const value = { ...resolved.node };
    for (const field of ['correlationId', 'bindings'])
      if (object(value[field]))
        value[field] = store.protocolObject(resolved.pointer + '/' + field).node;
    return value;
  };
  const traits = (pointer) => {
    const original = store.protocolObject(pointer),
      value = protocolFields(original.pointer);
    if (!object(value)) throw unavailable('asyncapi_message_unavailable');
    const own = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'traits'));
    let merged = isV3 ? {} : own;
    for (let index = 0; index < (value.traits?.length ?? 0); index++)
      merged = mergePatch(merged, protocolFields(original.pointer + '/traits/' + index));
    return isV3 ? mergePatch(merged, own) : merged;
  };
  const context = (value, format) => {
    try {
      const result = store.compileContext(value, format);
      if (result.kind === 'asyncapi-polymorphic') compileAsyncapiDiscriminator(result);
      else if (!['avro', 'protobuf', 'raml'].includes(result.kind))
        compiler(result.schema, result.resources, result.dialect);
      return { available: true, ...result };
    } catch (error) {
      issues.add('AsyncAPI schema validation unavailable: ' + String(error.message).slice(0, 100));
      return { available: false, reason: String(error.message).slice(0, 100) };
    }
  };
  const messageContext = ({ id, pointer }, allowed) => {
    const value = traits(pointer);
    const payload = context(value.payload, value.schemaFormat);
    const headers = value.headers === undefined ? undefined : context(value.headers);
    return {
      id,
      allowed: allowed.includes(pointer),
      payload,
      ...(headers ? { headers } : {}),
      ...((value.contentType ?? source.defaultContentType)
        ? { contentType: value.contentType ?? source.defaultContentType }
        : {}),
      ...(value.correlationId ? { correlation: value.correlationId.location } : {}),
      bindings: value.bindings ?? {},
      ...(value.bindings?.kafka?.key !== undefined
        ? { kafkaKey: context(value.bindings.kafka.key) }
        : {}),
      ...(value.bindings?.http?.headers
        ? { httpHeaders: context(value.bindings.http.headers) }
        : {}),
      ...(value.bindings?.mqtt?.correlationData !== undefined
        ? { mqttCorrelation: context(value.bindings.mqtt.correlationData) }
        : {}),
      ...(typeof value.bindings?.mqtt?.responseTopic === 'object'
        ? { mqttResponseTopic: context(value.bindings.mqtt.responseTopic) }
        : {}),
    };
  };
  const parametersFor = (channel, rawChannel) =>
    Object.fromEntries(
      Object.keys(rawChannel.parameters ?? {}).map((name) => {
        const value = store.protocolObject(channel.pointer + '/parameters/' + escape(name)).node;
        return [
          name,
          context(
            isV3 ? { type: 'string', ...(value.enum ? { enum: value.enum } : {}) } : value.schema,
          ),
        ];
      }),
    );
  const serversFor = (servers) =>
    servers.map((server) => ({
      id: server.id(),
      protocol: server.protocol(),
      version: server.protocolVersion(),
      url: server.url(),
      variables: server.json('variables') ?? {},
      parameters: Object.fromEntries(
        Object.entries(server.json('variables') ?? {}).map(([name, value]) => [
          name,
          context({ type: 'string', ...(value.enum ? { enum: value.enum } : {}) }),
        ]),
      ),
      bindings: server.json('bindings') ?? {},
      ...(typeof server.json('bindings')?.mqtt?.sessionExpiryInterval === 'object'
        ? { mqttSessionExpiry: context(server.json('bindings').mqtt.sessionExpiryInterval) }
        : {}),
      ...(typeof server.json('bindings')?.mqtt?.maximumPacketSize === 'object'
        ? { mqttMaximumPacketSize: context(server.json('bindings').mqtt.maximumPacketSize) }
        : {}),
    }));
  for (const operation of parsed.operations()) {
    const opSource = store.protocolObject(
      isV3 ? '/operations/' + escape(operation.id()) : operation.meta('pointer'),
    );
    const op = traits(opSource.pointer);
    const channel = store.protocolObject(
      isV3
        ? opSource.pointer + '/channel'
        : opSource.pointer.slice(0, opSource.pointer.lastIndexOf('/')),
    );
    const rawChannel = protocolFields(channel.pointer);
    const address = isV3 ? rawChannel.address : operation.channels()[0]?.address();
    const messagePaths = isV3
      ? Object.keys(rawChannel.messages ?? {}).map((id) => ({
          id,
          pointer: channel.pointer + '/messages/' + escape(id),
        }))
      : Array.isArray(op.message?.oneOf)
        ? op.message.oneOf.map((_, index) => ({
            id: operation.messages()[index]?.id() ?? String(index),
            pointer: opSource.pointer + '/message/oneOf/' + index,
          }))
        : [
            {
              id: operation.messages()[0]?.id() ?? 'message',
              pointer: opSource.pointer + '/message',
            },
          ];
    if (messagePaths.length > 128) throw unavailable('asyncapi_message_resource_limit');
    const allowed =
      isV3 && Array.isArray(op.messages)
        ? op.messages
            .map(
              (_, index) => store.protocolObject(opSource.pointer + '/messages/' + index).pointers,
            )
            .flat()
        : messagePaths.map((message) => message.pointer);
    const messages = messagePaths.map((message) => messageContext(message, allowed));
    const parameters = parametersFor(channel, rawChannel);
    const servers = serversFor(operation.servers());
    let reply;
    if (isV3 && op.reply) {
      const original = store.protocolObject(opSource.pointer + '/reply');
      if (!original.node.channel)
        reply = { available: false, reason: 'asyncapi_reply_channel_unavailable' };
      else {
        const replyChannel = store.protocolObject(original.pointer + '/channel');
        const raw = protocolFields(replyChannel.pointer);
        const paths = Object.keys(raw.messages ?? {}).map((id) => ({
          id,
          pointer: replyChannel.pointer + '/messages/' + escape(id),
        }));
        if (paths.length > 128) throw unavailable('asyncapi_message_resource_limit');
        const allowed = Array.isArray(original.node.messages)
          ? original.node.messages.flatMap(
              (_, index) => store.protocolObject(original.pointer + '/messages/' + index).pointers,
            )
          : paths.map(({ pointer }) => pointer);
        const address = original.node.address
          ? store.protocolObject(original.pointer + '/address').node.location
          : undefined;
        reply = {
          available: true,
          channel: replyChannel.pointer,
          address: raw.address,
          ...(address ? { addressLocation: address } : {}),
          parameters: parametersFor(replyChannel, raw),
          messages: paths.map((message) => messageContext(message, allowed)),
          bindings: {},
          channelBindings: raw.bindings ?? {},
          servers: serversFor(operation.reply().channel().servers()),
        };
      }
    }
    output.push({
      path: '/asyncapi/' + encodeURIComponent(operation.id()),
      direction: operation.isSend() ? 'input' : 'output',
      channel: channel.pointer,
      address,
      parameters,
      messages,
      bindings: op.bindings ?? {},
      ...(op.bindings?.kafka?.clientId !== undefined
        ? { kafkaClientId: context(op.bindings.kafka.clientId) }
        : {}),
      ...(op.bindings?.http?.query ? { httpQuery: context(op.bindings.http.query) } : {}),
      ...(typeof op.bindings?.mqtt?.messageExpiryInterval === 'object'
        ? { mqttExpiry: context(op.bindings.mqtt.messageExpiryInterval) }
        : {}),
      channelBindings: rawChannel.bindings ?? {},
      servers,
      ...(reply ? { reply } : {}),
    });
  }
  return output;
}
export function asyncapiPayloadProjection(model, issues) {
  const contexts = model.messages
    .filter((message) => message.allowed)
    .map((message) => message.payload);
  if (
    !contexts.length ||
    contexts.some(
      (context) =>
        !context.available ||
        ['avro', 'protobuf', 'raml', 'asyncapi-polymorphic'].includes(context.kind) ||
        context.dialect === 'openapi3.0',
    ) ||
    new Set(contexts.map((context) => context.dialect)).size !== 1
  ) {
    issues.add('AsyncAPI payload projection requires native message/dialect validation');
    return {};
  }
  const resources = new Map();
  for (const context of contexts)
    for (const resource of context.resources) {
      if (
        resources.has(resource.$id) &&
        JSON.stringify(resources.get(resource.$id)) !== JSON.stringify(resource)
      )
        throw unavailable('asyncapi_projection_resource_collision');
      resources.set(resource.$id, resource);
    }
  const references = contexts.map((context) => context.schema),
    dialect = contexts[0].dialect;
  return {
    $schema: dialect,
    ...(references.length === 1 ? references[0] : { anyOf: references }),
    [dialect.includes('/draft-0') ? 'definitions' : '$defs']: Object.fromEntries(
      [...resources.values()].map((resource, index) => ['captured' + index, resource]),
    ),
  };
}
function channelParameters(model, address, decode = false) {
  if (typeof model.address !== 'string' || typeof address !== 'string' || address.length > 4096)
    throw unavailable('asyncapi_channel_unavailable');
  const names = [],
    pieces = [];
  let offset = 0;
  for (const match of model.address.matchAll(/\{([A-Za-z0-9_-]+)\}/g)) {
    pieces.push(model.address.slice(offset, match.index));
    names.push(match[1]);
    offset = match.index + match[0].length;
  }
  pieces.push(model.address.slice(offset));
  if (
    names.length > 32 ||
    /[{}]/.test(pieces.join('')) ||
    Object.keys(model.parameters).some((key) => !names.includes(key)) ||
    names.some((name) => !Object.hasOwn(model.parameters, name))
  )
    throw unavailable('asyncapi_channel_parameters_unavailable');
  const matches = new Map();
  let steps = 0;
  const walk = (index, position, values) => {
    if (++steps > 4096) throw unavailable('asyncapi_channel_resource_limit');
    if (index === names.length) {
      if (position === address.length)
        matches.set(JSON.stringify([...values].sort(([a], [b]) => a.localeCompare(b))), values);
      return;
    }
    const literal = pieces[index + 1],
      last = index === names.length - 1;
    let end = last
      ? address.endsWith(literal)
        ? address.length - literal.length
        : -1
      : literal
        ? address.indexOf(literal, position)
        : position;
    while (end >= position && end <= address.length) {
      let value = address.slice(position, end);
      if (decode) {
        try {
          value = decodeURIComponent(value);
        } catch {
          throw invalid('asyncapi_channel_encoding_invalid');
        }
      }
      if (!values.has(names[index]) || values.get(names[index]) === value) {
        const next = new Map(values);
        next.set(names[index], value);
        walk(index + 1, end + literal.length, next);
        if (matches.size > 1) throw unavailable('asyncapi_channel_ambiguous');
      }
      end = last ? -1 : literal ? address.indexOf(literal, end + 1) : end + 1;
    }
  };
  if (address.startsWith(pieces[0])) walk(0, pieces[0].length, new Map());
  if (!matches.size) throw invalid('asyncapi_channel_mismatch');
  const values = matches.values().next().value;
  for (const [name, value] of values) {
    const context = model.parameters[name];
    if (!context.available) throw unavailable('asyncapi_parameter_schema_unavailable');
    if (!compiler(context.schema, context.resources, context.dialect)(value))
      throw invalid('asyncapi_channel_parameter_invalid');
  }
  return Object.fromEntries(values);
}
export function asyncapiExpression(expression, payload, headers) {
  const match = /^\$message\.(header|payload)(?:#(.*))?$/.exec(expression);
  if (!match) throw unavailable('asyncapi_runtime_expression_unavailable');
  let value = match[1] === 'header' ? headers : payload;
  const fragment = decodeURIComponent(match[2] ?? '');
  if (fragment && !fragment.startsWith('/'))
    throw unavailable('asyncapi_runtime_expression_unavailable');
  for (const part of fragment ? fragment.slice(1).split('/') : []) {
    if (/~(?![01])/.test(part)) throw unavailable('asyncapi_runtime_expression_unavailable');
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key))
      throw invalid('asyncapi_runtime_expression_missing');
    value = value[key];
  }
  return value;
}
export async function validateAsyncapiPayload(input) {
  try {
    if (input.transport?.protocol === 'mqtt' && input.bytesBase64 !== undefined)
      input = mqttWireInput(input);
    if (input.transport?.protocol === 'amqp') input = amqpWireInput(input);
    if (input.transport?.protocol === 'stomp') input = stompWireInput(input);
    const transport = input.transport;
    if (
      !object(transport) ||
      typeof transport.protocol !== 'string' ||
      !object(transport.headers ?? {})
    )
      throw unavailable('asyncapi_transport_unavailable');
    const candidates = (input.native.document['x-paritydiff-asyncapi-bindings'] ?? []).filter(
      (model) => input.native.operationPaths?.includes(model.path),
    );
    let request;
    let replyModel;
    if (input.direction === 'output') {
      const parents = candidates.filter((model) => model.direction === 'input' && model.reply);
      if (parents.length === 1) {
        const parent = parents[0];
        if (!parent.reply.available) throw unavailable(parent.reply.reason);
        if (!object(input.requestTransport))
          throw unavailable('asyncapi_reply_request_unavailable');
        request = await validateAsyncapiPayload({
          ...input,
          direction: 'input',
          payload: input.requestPayload,
          bytesBase64: input.requestBytesBase64,
          payloadBytesBase64: input.requestPayloadBytesBase64,
          transport: input.requestTransport,
        });
        if (!request.available) throw unavailable('asyncapi_reply_request_unavailable');
        if (!request.valid) throw invalid('asyncapi_reply_request_invalid');
        replyModel = parent.reply;
        if (request.replyAddressHash !== undefined) {
          if (
            typeof transport.channel !== 'string' ||
            hash(transport.channel) !== request.replyAddressHash
          )
            throw invalid('asyncapi_reply_address_mismatch');
          replyModel = { ...replyModel, address: transport.channel };
        }
      }
    }
    const models = replyModel
      ? [replyModel]
      : candidates.filter(
          (model) =>
            input.native.operationPaths?.includes(model.path) &&
            model.direction === (input.direction ?? 'input'),
        );
    if (models.length !== 1) throw unavailable('asyncapi_operation_binding_unavailable');
    const model = models[0],
      http = ['http', 'https'].includes(transport.protocol),
      headers = http ? httpApplicationHeaders(transport) : (transport.headers ?? {});
    const servers = selectAsyncapiServers(model, transport, channelParameters);
    if (Object.keys(headers).length > 256 || Buffer.byteLength(JSON.stringify(headers)) > 16384)
      throw unavailable('asyncapi_header_resource_limit');
    const valid = [];
    for (const message of model.messages) {
      if (message.contentType) {
        if (typeof transport.contentType !== 'string')
          throw unavailable('asyncapi_content_type_unavailable');
        if (!matchesMimeType(message.contentType, parseMimeType(transport.contentType))) continue;
      }
      if (!message.payload.available || message.headers?.available === false)
        throw unavailable('asyncapi_message_schema_unavailable');
      let selectedPayload;
      try {
        selectedPayload =
          message.payload.kind === 'avro'
            ? validateAvroPayload(message.payload, input)
            : message.payload.kind === 'protobuf'
              ? validateAsyncapiProtobuf(message.payload, input)
              : message.payload.kind === 'raml'
                ? await validateRamlPayload(message.payload, input)
                : {
                    valid: (message.payload.kind === 'asyncapi-polymorphic'
                      ? compileAsyncapiDiscriminator(message.payload)
                      : compiler(
                          message.payload.schema,
                          message.payload.resources,
                          message.payload.dialect,
                        ))(input.payload),
                    payload: input.payload,
                  };
      } catch (error) {
        if (error.available === true) continue;
        throw error;
      }
      if (!selectedPayload.valid) continue;
      if (['avro', 'protobuf', 'raml', 'asyncapi-polymorphic'].includes(message.headers?.kind))
        throw unavailable('asyncapi_native_header_codec_unavailable');
      let selectedHeaders = headers;
      if (http && message.headers) {
        try {
          selectedHeaders = validateHttpApplicationHeaders(message.headers, headers);
        } catch (error) {
          if (error.available === true) continue;
          throw error;
        }
      }
      if (
        message.headers &&
        !compiler(
          message.headers.schema,
          message.headers.resources,
          message.headers.dialect,
        )(selectedHeaders)
      )
        continue;
      valid.push({
        message,
        headers: selectedHeaders,
        payload: selectedPayload.payload,
        wireHash: selectedPayload.wireHash,
        implementation: selectedPayload.implementation,
      });
    }
    if (valid.length !== 1 || !valid[0].message.allowed) throw invalid('asyncapi_message_mismatch');
    const {
      message,
      headers: boundHeaders,
      payload: boundPayload,
      wireHash,
      implementation,
    } = valid[0];
    let correlation;
    if (message.correlation) {
      try {
        correlation = asyncapiExpression(message.correlation, boundPayload, boundHeaders);
      } catch (error) {
        if (error.available === true)
          throw unavailable('asyncapi_correlation_evidence_unavailable');
        throw error;
      }
    }
    if (transport.messageId !== undefined && transport.messageId !== message.id)
      throw invalid('asyncapi_message_selector_mismatch');
    const correlationHash = message.correlation ? hash(JSON.stringify(correlation)) : undefined;
    if (request && (request.correlationHash !== undefined || correlationHash !== undefined)) {
      if (request.correlationHash === undefined || correlationHash === undefined)
        throw unavailable('asyncapi_reply_correlation_unavailable');
      if (request.correlationHash !== correlationHash)
        throw invalid('asyncapi_reply_correlation_mismatch');
    }
    let replyAddressHash;
    if (model.reply?.addressLocation) {
      const address = asyncapiExpression(model.reply.addressLocation, boundPayload, boundHeaders);
      if (
        typeof address !== 'string' ||
        !address.length ||
        address.length > 4096 ||
        /[\r\n\0]/.test(address)
      )
        throw invalid('asyncapi_reply_address_invalid');
      replyAddressHash = hash(address);
    }
    if (http) validateHttpBindings(model, message, servers, transport);
    else if (transport.protocol === 'mqtt')
      validateMqttBindings(model, message, servers, transport);
    else if (transport.protocol === 'amqp')
      validateAmqpBindings(model, message, servers, transport);
    else if (transport.protocol === 'stomp') validateStompBindings(model, message, servers);
    else if (transport.protocol === 'kafka')
      validateKafkaBindings(model, message, servers, transport);
    else if (
      Object.keys(model.bindings).length ||
      Object.keys(model.channelBindings).length ||
      Object.keys(message.bindings).length ||
      servers.some((server) => Object.keys(server.bindings).length)
    )
      throw unavailable('asyncapi_protocol_binding_evidence_unavailable');
    return {
      available: true,
      valid: true,
      protocol: 'asyncapi',
      messageId: message.id,
      channel: model.address,
      validation: 'selected_operation_message_headers_and_payload',
      ...(wireHash
        ? {
            wirePayloadHash: wireHash,
            nativeSchemaFormat: message.payload.format,
            nativeSchemaImplementation: implementation ?? message.payload.implementation,
            ...(message.payload.resourceHash
              ? { nativeSchemaResourceHash: message.payload.resourceHash }
              : {}),
          }
        : {}),
      ...(message.payload.kind === 'asyncapi-polymorphic'
        ? {
            nativeSchemaFormat:
              message.payload.format ??
              'application/vnd.aai.asyncapi;version=' +
                input.native.document['x-paritydiff-native-contract'].asyncapi,
            nativeSchemaImplementation: message.payload.implementation,
          }
        : {}),
      ...(replyAddressHash ? { replyAddressHash } : {}),
      ...(request ? { requestMessageId: request.messageId, reply: true } : {}),
      ...(transport.mqtt?.packet
        ? {
            wirePayloadHash: hash(transport.mqtt.packet.payload),
            wirePacketHash: hash(Buffer.from(input.bytesBase64, 'base64')),
            wireHeaderNames: Object.keys(transport.mqtt.packet.userProperties ?? {}),
            mqttQos: transport.mqtt.packet.qos,
            mqttDelivery: transport.mqtt.packet.qos ? 'acknowledged' : 'sent',
            mqttAttempts: 1 + (transport.mqtt.retries?.length ?? 0),
          }
        : {}),
      ...(transport.amqp?.publish
        ? {
            wirePayloadHash: hash(transport.amqp.body),
            wireDecodedHash: hash(transport.amqp.decoded),
            wirePacketHash: transport.amqp.packetHash,
            wireHeaderNames: Object.keys(transport.amqp.properties.headers ?? {}),
            wirePropertyNames: Object.keys(transport.amqp.properties),
            amqpDelivery: transport.amqp.transactionHash ? 'transaction_committed' : 'acknowledged',
            ...(transport.amqp.topologyHash
              ? { wireTopologyHash: transport.amqp.topologyHash }
              : {}),
            ...(transport.amqp.transactionHash
              ? { wireTransactionHash: transport.amqp.transactionHash }
              : {}),
          }
        : {}),
      ...(transport.stomp?.send
        ? {
            wirePayloadHash: hash(transport.stomp.send.body),
            wirePacketHash: transport.stomp.packetHash,
            wireHeaderNames: Object.keys(transport.headers),
            stompDelivery: transport.stomp.transactionHash
              ? 'transaction_committed'
              : 'broker_receipt',
            ...(transport.stomp.transactionHash
              ? { wireTransactionHash: transport.stomp.transactionHash }
              : {}),
          }
        : {}),
      ...(message.correlation
        ? {
            correlationHash,
          }
        : {}),
    };
  } catch (error) {
    return {
      available: error.available === true,
      valid: false,
      protocol: 'asyncapi',
      reason: error.available === true ? error.message : String(error.message).slice(0, 100),
    };
  }
}
