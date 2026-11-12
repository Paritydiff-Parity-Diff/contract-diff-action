export function decodeSoapPackage(input: {
  bytesBase64: string;
  transport: { contentType: string };
}): { payload: string; packaging: string; attachments: number; rootType: string };
export function bindSoapWirePayload(input: unknown): unknown;
