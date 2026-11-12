export interface Xml11Tree {
  name: string;
  attributes: [string, string][];
  namespaces: [string, string][];
  children: (string | Xml11Tree)[];
}
export function xmlVersion(source: string): '1.0' | '1.1';
export function xml11SchemaSource(source: string): string;
export function parseXml11(source: string): {
  document: import('@xmldom/xmldom').Document;
  tree: Xml11Tree;
};
export const DOMParser: typeof import('@xmldom/xmldom').DOMParser;
export const XMLSerializer: typeof import('@xmldom/xmldom').XMLSerializer;
