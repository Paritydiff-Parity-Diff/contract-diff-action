import protobuf from 'protobufjs';

export function createProtobufMessage(payload, type) {
  const message = type.create();
  for (const [name, value] of Object.entries(payload)) {
    const field = type.fields[name];
    const convert = (value) => {
      if (field.resolvedType instanceof protobuf.Type)
        return createProtobufMessage(value, field.resolvedType);
      if (field.resolvedType instanceof protobuf.Enum)
        return typeof value === 'string' ? field.resolvedType.values[value] : value;
      if (field.type === 'bytes') return Buffer.from(value, 'base64');
      if (/64$/.test(field.type) && field.type !== 'double') {
        if (!protobuf.util.Long) throw new Error('grpc_long_type_unavailable');
        return protobuf.util.Long.fromString(
          String(value),
          field.type.startsWith('u') || field.type === 'fixed64',
        );
      }
      return value;
    };
    let converted;
    if (field.map) {
      converted = Object.create(null);
      for (const [key, item] of Object.entries(value))
        Object.defineProperty(converted, key, {
          value: convert(item),
          enumerable: true,
          writable: true,
          configurable: true,
        });
    } else converted = field.repeated ? value.map(convert) : convert(value);
    Object.defineProperty(message, name, {
      value: converted,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return message;
}

export function validProtobufMapKey(key, type) {
  if (type === 'string') return true;
  if (type === 'bool') return key === 'true' || key === 'false';
  if (!/^(?:0|-?[1-9][0-9]*)$/.test(key) || key.length > 21) return false;
  const bits = type.endsWith('32') ? 32n : 64n;
  const unsigned = type.startsWith('u') || type.startsWith('fixed');
  const value = BigInt(key);
  return (
    value >= (unsigned ? 0n : -(1n << (bits - 1n))) &&
    value <= (unsigned ? (1n << bits) - 1n : (1n << (bits - 1n)) - 1n)
  );
}

export function encodeProtobufMessage(message, type) {
  const write = (message, type, writer, depth = 0) => {
    if (depth > 32) throw new Error('grpc_wire_resource_limit');
    const value = (field, item, id, delimited = false) => {
      if (field.resolvedType instanceof protobuf.Type) {
        if (field.resolvedType.group && !delimited) {
          writer.uint32(id * 8 + 3);
          write(item, field.resolvedType, writer, depth + 1);
          writer.uint32(id * 8 + 4);
        } else {
          writer.uint32(id * 8 + 2).fork();
          write(item, field.resolvedType, writer, depth + 1);
          writer.ldelim();
        }
      } else {
        const kind = field.resolvedType instanceof protobuf.Enum ? 'int32' : field.type;
        writer.uint32(id * 8 + protobuf.types.basic[kind])[kind](item);
      }
    };
    for (const field of [...type.fieldsArray].sort((a, b) => a.id - b.id)) {
      if (!Object.hasOwn(message, field.name)) continue;
      const item = message[field.name];
      if (field.map) {
        for (const [key, entry] of Object.entries(item)) {
          const keyValue = field.keyType === 'bool' ? key === 'true' : key;
          writer.uint32(field.id * 8 + 2).fork();
          value({ type: field.keyType }, keyValue, 1);
          value(field, entry, 2, true);
          writer.ldelim();
        }
      } else if (field.repeated) {
        const kind = field.resolvedType instanceof protobuf.Enum ? 'int32' : field.type;
        if (field.packed && protobuf.types.packed[kind] !== undefined && item.length) {
          writer.uint32(field.id * 8 + 2).fork();
          for (const entry of item) writer[kind](entry);
          writer.ldelim();
        } else for (const entry of item) value(field, entry, field.id);
      } else value(field, item, field.id);
    }
  };
  const writer = protobuf.Writer.create();
  write(message, type, writer);
  return writer.finish();
}
