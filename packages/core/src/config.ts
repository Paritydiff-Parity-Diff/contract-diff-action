import { z } from 'zod';
import { err, ok, type Result } from './result';

const urlLike = z.string().refine((v) => URL.canParse(v), { message: 'must be a valid URL' });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  SERVICE_NAME: z.string().min(1).default('paritydiff'),
  DATABASE_URL: urlLike,
  REDIS_URL: urlLike,
  // Object storage is optional: the spec store is filesystem-backed (SPEC_STORE_DIR). These
  // stay for a future S3 backup path but are not required to boot.
  OBJECT_STORE_ENDPOINT: z.string().default(''),
  OBJECT_STORE_BUCKET: z.string().default(''),
  OBJECT_STORE_ACCESS_KEY: z.string().default(''),
  OBJECT_STORE_SECRET_KEY: z.string().default(''),
  SENTRY_DSN: z.string().default(''),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(''),
  API_PORT: z.coerce.number().int().positive().default(3000),
  WEBHOOKS_PORT: z.coerce.number().int().positive().default(3001),
  // GitHub App (phase 7). Optional so the stack boots without them; the delivery
  // path checks they are present before acting.
  GITHUB_APP_ID: z.string().default(''),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().default(''),
  GITHUB_WEBHOOK_SECRET: z.string().default(''),
  GITHUB_APP_INSTALLATION_ID: z.string().default(''),
  SANDBOX_REPO: z.string().default(''),
  // Public slug of the GitHub App, used to build the install URL the onboarding flow
  // sends customers to. Onboarding session tokens are signed with ONBOARDING_SECRET;
  // both optional so the stack still boots without the customer-onboarding path.
  FIREBASE_PROJECT_ID: z.string().default(''),
  PADDLE_ENV: z.enum(['', 'sandbox', 'production']).default(''),
  CUSTOMER_DATA_KEY: z
    .string()
    .regex(/^$|^[a-f0-9]{64}$/i)
    .default(''),
  GITHUB_APP_SLUG: z.string().default(''),
  ONBOARDING_SECRET: z.string().default(''),
  // GitHub token (App token or a dedicated PAT) used only for cross-repo code search in
  // public-repo discovery. Optional so the stack boots without it; discovery no-ops when
  // absent.
  GITHUB_SEARCH_TOKEN: z.string().default(''),
  // KMS for envelope-encrypting stored credentials (packages/secrets). 'local' keeps the
  // 32-byte master key in KMS_LOCAL_MASTER_KEY (hex or base64) for dev and soak; 'aws' is
  // wired once its SDK is an approved dependency. KMS_KEY_ID labels the wrapping key.
  KMS_PROVIDER: z.enum(['local', 'aws']).default('local'),
  KMS_KEY_ID: z.string().default('local'),
  KMS_LOCAL_MASTER_KEY: z.string().default(''),
  // Content-addressed spec store directory (shared with the poller). Uploaded specs land
  // here before ingest records their lineage.
  SPEC_STORE_DIR: z.string().default('/data/specs'),
  // Gate for the provider self-serve vendor-creation endpoint. The onboarding flow presents
  // it; when unset the create route answers 503, so the endpoint is never open on the
  // internet before the owner provisions a secret.
  PROVIDER_SIGNUP_SECRET: z.string().default(''),
  // Worker monitor loop: registry-driven spec polling (and optional public-repo discovery
  // when GITHUB_SEARCH_TOKEN is set). Off by default so the worker keeps its event-only
  // behaviour until explicitly enabled.
  MONITOR_ENABLED: z.enum(['0', '1']).default('0'),
  MONITOR_INTERVAL_SECONDS: z.coerce.number().int().positive().default(3600),
  MONITOR_INLINE_DIFF: z.enum(['0', '1']).default('0'),
  CUSTOMER_RUNTIME_IMAGE: z
    .string()
    .regex(/^$|^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/)
    .default(''),
  CUSTOMER_PYTHON_BIN: z
    .string()
    .max(2000)
    .refine(
      (value) => !value.includes('\0') && (value === '' || /^(?:\/|[A-Za-z]:[\\/])/.test(value)),
      { message: 'must be an absolute runtime path' },
    )
    .default(''),
  XSD_PYTHON_BIN: z
    .string()
    .max(2000)
    .refine(
      (value) => !value.includes('\0') && (value === '' || /^(?:\/|[A-Za-z]:[\\/])/.test(value)),
      { message: 'must be an absolute runtime path' },
    )
    .default(''),
  DISCOVERY_MAX_REPOS_PER_VENDOR: z.coerce.number().int().positive().default(25),
});

export type AppConfig = z.infer<typeof schema>;

export type ConfigError = { readonly kind: 'invalid_config'; readonly issues: readonly string[] };

export function loadConfig(
  env: Record<string, string | undefined>,
): Result<AppConfig, ConfigError> {
  const parsed = schema.safeParse(env);
  if (parsed.success) return ok(parsed.data);
  const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  return err({ kind: 'invalid_config', issues });
}
