export type MatchKind = 'typed_direct' | 'typed_transitive' | 'untyped_http' | 'dynamic_unresolved';
export type VersionGate = 'affected' | 'not_affected' | 'unresolved';

// Per-vendor code surface (spec section 8): the SDK module specifiers to treat as
// the vendor's, the HTTP base for raw fetch/axios consumers, and the SDK package
// name used to resolve the installed version for gating.
export interface VendorSurface {
  readonly vendorId: string;
  readonly moduleSpecifiers: readonly string[];
  readonly httpBasePattern: string;
  readonly sdkPackageName: string;
}

export interface Match {
  readonly match_id: string;
  readonly change_id: string;
  readonly installation_id: string;
  readonly vendor_id: string;
  readonly repo: string;
  readonly commit_sha: string;
  readonly file: string;
  readonly line: number;
  readonly end_line: number;
  readonly symbol: string;
  readonly match_kind: MatchKind;
  readonly sdk_version: string | null;
  readonly version_gate: VersionGate;
  readonly matched_code: string;
  readonly scanner_version: string;
  readonly sdk_package_name?: string;
  // Raw-HTTP matches only: the HTTP method and request path parsed from the call, so
  // the fix stage can map the call to its OpenAPI operation and request schema.
  readonly http_method?: string;
  readonly http_path?: string;
  readonly call_start?: number;
  readonly call_end?: number;
  readonly protocol_operations?: readonly string[];
  readonly dispatch?: {
    readonly kind: 'sdk' | 'http';
    readonly candidates: readonly string[];
    readonly complete: boolean;
    readonly source: 'static' | 'runtime';
  };
}
