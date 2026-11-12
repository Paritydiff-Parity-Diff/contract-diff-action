export interface VendorBranding {
  readonly displayName: string;
  readonly logoUrl?: string;
  readonly primaryColor?: string;
}

export type ContractEncoding =
  | 'json'
  | 'yaml'
  | 'graphql'
  | 'protobuf'
  | 'xml'
  | 'pdf'
  | 'image'
  | 'text'
  | 'markdown'
  | 'html'
  | 'binary';
export const CONTRACT_ENCODINGS: readonly ContractEncoding[] = [
  'json',
  'yaml',
  'graphql',
  'protobuf',
  'xml',
  'pdf',
  'image',
  'text',
  'markdown',
  'html',
  'binary',
];
export function isContractEncoding(value: unknown): value is ContractEncoding {
  return typeof value === 'string' && CONTRACT_ENCODINGS.includes(value as ContractEncoding);
}
export type SpecSource =
  | { readonly kind: 'openapi'; readonly url: string; readonly format: ContractEncoding }
  | { readonly kind: 'changelog'; readonly url: string; readonly parser: string }
  // A self-served spec pushed to the upload endpoint rather than polled. storageRef is the
  // content-addressed hash of the most recently ingested normalized spec.
  | { readonly kind: 'upload'; readonly storageRef: string; readonly format: ContractEncoding };

// How a self-served vendor was created and who may see it. Built-in vendors are public and
// ownerless; provider/tenant vendors carry their owner id and, when private, are visible
// to the owner and explicitly authorized workspaces.
export type VendorOwnerKind = 'builtin' | 'provider' | 'tenant';
export type VendorVisibility = 'public' | 'private';

export type AuthMethod = 'none' | 'api_key' | 'bearer';

export interface SdkPackage {
  readonly language: string;
  readonly packageName: string;
  readonly moduleSpecifiers: readonly string[];
  readonly registry?: {
    readonly url: string;
    readonly authentication?: 'none' | 'required';
    readonly credentialRevision?: string;
  };
  readonly operations?: readonly {
    readonly symbol: string;
    readonly method: string;
    readonly path: string;
    readonly affectedRange: string;
  }[];
}

// Whether the API rejects unknown request fields. Drives the classification of a
// removed request field (spec section 9.2); 'unknown' routes that case to review.
export type RequestStrictness = boolean | 'unknown';

export interface VendorConfig {
  readonly vendorId: string;
  readonly branding: VendorBranding;
  readonly specSource: SpecSource;
  readonly authMethod: AuthMethod;
  readonly pollIntervalMinutes: number;
  readonly pollingEnabled?: boolean;
  readonly sdkPackages: readonly SdkPackage[];
  // URL substring identifying raw-HTTP calls to this vendor (e.g. api.mistral.ai).
  readonly httpBasePattern?: string;
  readonly strictUnknownRequestFields: RequestStrictness;
  // Per-vendor outbound exit path (spec section 5.3); a config value, not a
  // hardcoded route, so switching to a proxy never touches code.
  readonly egressProfile: string;
  readonly classificationOverrides?: Readonly<Record<string, string>>;
  readonly escalationContact?: string;
  // Credential for a private spec URL, resolved to an Authorization header at fetch time.
  readonly specAuthSecretId?: string;
  // Hosts the spec fetch may reach for this vendor (SSRF allowlist). Defaults to the
  // spec URL's own host; private/loopback/metadata IPs stay blocked regardless.
  readonly specHostAllowlist?: readonly string[];
  readonly ownerKind?: VendorOwnerKind;
  readonly ownerId?: string;
  readonly visibility?: VendorVisibility;
}

// Read seam over the set of vendors. The static registry (vendors package) is the built-in
// source of truth; the DB-backed registry (db package) adds self-served vendors. Both
// expose the same shape so every consumer stays impl-agnostic.
export interface VendorRegistry {
  get(vendorId: string): VendorConfig | undefined;
  list(): readonly VendorConfig[];
}
