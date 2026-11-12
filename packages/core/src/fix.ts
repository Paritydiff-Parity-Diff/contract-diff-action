export type FixStatus = 'code_fixable' | 'not_code_fixable' | 'validation_failed';

export interface FixRecord {
  readonly fix_id: string;
  readonly match_id: string;
  readonly release_id: string;
  readonly installation_id: string;
  readonly status: FixStatus | 'pending' | 'superseded';
  readonly codemod_id: string | null;
  readonly codemod_version: string | null;
  readonly diff: string | null;
  readonly explanation: string;
  readonly validation_report: Readonly<Record<string, unknown>> | null;
  readonly validated: boolean;
  readonly attempt: number;
}
