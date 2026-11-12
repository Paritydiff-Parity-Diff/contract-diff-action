export function grpcStatusCode(value = 0) {
  if (typeof value === 'number')
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
  return typeof value === 'string' && value.length <= 2000 && /^(?:0|[1-9][0-9]*)$/.test(value)
    ? value
    : undefined;
}
export function grpcStatusDetailsBytes(value) {
  if (
    typeof value !== 'string' ||
    value.length > 8192 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/.test(value)
  )
    return undefined;
  return Buffer.from(value, 'base64');
}
