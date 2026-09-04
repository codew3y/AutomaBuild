/**
 * automa-webhook-gate — verify inbound webhooks properly, and send outbound
 * ones that can be verified properly.
 *
 * The framework integration lives in `./fastify.ts` and is not re-exported
 * here, so importing this does not pull Fastify into a project that verifies
 * webhooks somewhere else.
 */

export {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_TOLERANCE_SECONDS,
  WebhookVerificationError,
  checkTolerance,
  header,
  hmacBase64,
  hmacHex,
  matchAnySignature,
  secureCompare,
  toBuffer,
  type VerificationFailure,
  type VerificationResult,
  type VerifyInput,
} from './verify/common.ts'

export { parseStripeSignature, verifyStripe, type StripeSignatureHeader } from './verify/stripe.ts'
export { verifyGitHub } from './verify/github.ts'
export { verifySlack } from './verify/slack.ts'
export {
  decodeSecret,
  parseSignatureHeader,
  verifyStandardWebhooks,
  type ParsedSignatures,
} from './verify/standard-webhooks.ts'

export {
  DEFAULT_RETENTION_SECONDS,
  assertRetentionCoversTolerance,
  type DeliveryOutcome,
  type DeliveryRecord,
  type RecordResult,
  type ReplayStore,
} from './replay/store.ts'
export { MemoryReplayStore, type MemoryStoreOptions } from './replay/memory.ts'
export { PostgresReplayStore, type PostgresStoreOptions } from './replay/postgres.ts'

export {
  createGate,
  type EndpointConfig,
  type GateOptions,
  type GateRequest,
  type GateResult,
  type Scheme,
  SCHEMES,
  SIGNATURE_HEADERS,
  isScheme,
} from './gate.ts'

export {
  backoffMs,
  isRetryable,
  send,
  signPayload,
  type DeliveryAttempt,
  type DeliveryResult,
  type DlqEntry,
  type SendOptions,
  type SignedHeaders,
} from './outbound.ts'

export {
  MigrationDriftError,
  createPool,
  dbConfigFromEnv,
  migrate,
  type DbConfig,
} from './db.ts'
