import { parseMimeType, decodeMimeParts, matchesMimeType } from './mime-wire.mjs';
import { validateApplicationAttachments } from './application-attachments.mjs';
const unavailable = (reason) => Object.assign(new Error(reason), { available: false });
const mismatch = () => new Error('wsdl_http_mime_mismatch');
export function bindMimeFormats({ formats, bytes, contentType, partIds = {}, leaf }) {
  let nodes = 0,
    wireParts = 0;
  const mappingUsed = new Set();
  const bind = (alternatives, body, type, headers, depth, isRoot = false) => {
    if (!alternatives.length) throw unavailable('wsdl_http_mime_format_unavailable');
    if (++nodes > 1024 || depth > 8) throw unavailable('wsdl_http_mime_resource_limit');
    const successes = new Map();
    let unknown;
    for (const format of alternatives) {
      try {
        let result;
        if (format.kind === 'multipartRelated') {
          if (type.essence !== 'multipart/related') continue;
          const parts = decodeMimeParts(body, type.toString());
          if ((wireParts += parts.length) > 64) throw unavailable('wsdl_http_mime_resource_limit');
          const rootId = type.params.get('start'),
            root = rootId
              ? parts.find((part) => part.headers.get('content-id') === rootId)
              : parts[0],
            rootType = type.params.get('type');
          if (
            !root ||
            !rootType ||
            parseMimeType(rootType).essence !== parseMimeType(root.contentType).essence
          )
            throw mismatch();
          if (type.params.has('start-info'))
            throw unavailable('wsdl_http_mime_start_info_unavailable');
          if (parts.length !== format.parts.length) throw mismatch();
          const matrix = format.parts.map((slot) =>
            parts.map((part) => {
              try {
                return bind(
                  slot,
                  part.bytes,
                  parseMimeType(part.contentType),
                  part.headers,
                  depth + 1,
                  part === root,
                );
              } catch (error) {
                if (error.available === false) throw error;
                return undefined;
              }
            }),
          );
          const matches = [];
          const visit = (index, used, selected) => {
            if (++nodes > 1024) throw unavailable('wsdl_http_mime_resource_limit');
            if (matches.length > 1) return;
            if (index === matrix.length) {
              matches.push(selected);
              return;
            }
            for (let candidate = 0; candidate < parts.length; candidate++) {
              if (!used.has(candidate) && matrix[index][candidate]) {
                used.add(candidate);
                visit(index + 1, used, selected.concat(matrix[index][candidate]));
                used.delete(candidate);
              }
            }
          };
          visit(0, new Set(), []);
          if (!matches.length) throw mismatch();
          if (matches.length !== 1) throw unavailable('wsdl_http_mime_part_binding_ambiguous');
          result = {
            checks: matches[0].flatMap((match) => match.checks),
            names: matches[0].flatMap((match) => match.names),
          };
        } else if (['content', 'mimeXml', 'soapBody'].includes(format.kind)) {
          if (format.kind === 'soapBody' && (!isRoot || type.essence !== format.media)) continue;
          if (format.kind === 'content') {
            if (!matchesMimeType(format.media, type)) continue;
          } else if (
            format.kind === 'mimeXml' &&
            !['application/xml', 'text/xml'].includes(type.essence) &&
            !type.subtype.endsWith('+xml')
          )
            continue;
          const selected = leaf(format, body, type);
          const names = selected.names ?? [selected.name],
            checks = selected.checks ?? [selected.check];
          for (const name of names)
            if (Object.hasOwn(partIds, name)) {
              if (headers?.get('content-id') !== partIds[name]) throw mismatch();
              mappingUsed.add(name);
            }
          result = { checks, names };
        } else throw unavailable('wsdl_http_mime_format_unavailable');
        if (new Set(result.names).size !== result.names.length)
          throw unavailable('wsdl_http_mime_part_repeated');
        successes.set(JSON.stringify(result), result);
      } catch (error) {
        if (error.available === false) unknown = error;
      }
    }
    if (unknown) throw unknown;
    if (!successes.size) throw mismatch();
    if (successes.size !== 1) throw unavailable('wsdl_http_mime_alternative_ambiguous');
    return successes.values().next().value;
  };
  const result = bind(formats, bytes, contentType, undefined, 0);
  if (Object.keys(partIds).some((name) => !mappingUsed.has(name)))
    throw unavailable('wsdl_http_mime_mapping_unbound');
  validateApplicationAttachments(result.checks);
  return result;
}
