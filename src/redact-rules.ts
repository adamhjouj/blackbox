/**
 * Curated secret-detection corpus. High-precision known-format patterns (seeded
 * from the gitleaks/detect-secrets rulesets) plus the sensitive-path list. Kept
 * as static data — no shell-out, no per-event process spawn. Trimmed to
 * high-signal rules; the entropy fallback in redact.ts catches unknown formats.
 *
 * Maintenance: periodically re-sync patterns from upstream gitleaks rules.
 */

export type SecretType =
  | 'openai-key'
  | 'anthropic-key'
  | 'github-token'
  | 'gitlab-token'
  | 'aws-access-key'
  | 'slack-token'
  | 'google-api-key'
  | 'stripe-key'
  | 'npm-token'
  | 'jwt'
  | 'pem-private-key'
  | 'aws-secret-key'
  | 'assigned-secret'
  | 'high-entropy'
  | 'path-sensitive-content'
  | 'redactor-error';

export interface PrefixRule {
  type: SecretType;
  /** Must be a global regex so replace() can find every occurrence. */
  re: RegExp;
}

export const PREFIX_RULES: PrefixRule[] = [
  // Order matters: PEM first (multiline), then specific prefixes, then JWT.
  {
    type: 'pem-private-key',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  { type: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { type: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { type: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}/g },
  { type: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { type: 'aws-access-key', re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}/g },
  { type: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { type: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { type: 'stripe-key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/g },
  { type: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}/g },
  {
    type: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
];

/**
 * Files whose CONTENT is dropped to a hash regardless of entropy — a `.env`
 * value may be low-entropy but still a secret. Matched against the basename and
 * any path segment.
 */
const SENSITIVE_BASENAMES = [
  /^\.env(\..*)?$/,
  /^.*\.pem$/,
  /^.*\.key$/,
  /^id_(rsa|dsa|ecdsa|ed25519)$/,
  /^\.npmrc$/,
  /^\.netrc$/,
  /^\.git-credentials$/,
  /^credentials(\.json)?$/,
  /^secrets?(\..*)?$/,
];

const SENSITIVE_SEGMENTS = /(^|\/)\.(aws|ssh|gnupg)(\/|$)/;

export function isSensitivePath(path: string): boolean {
  if (SENSITIVE_SEGMENTS.test(path)) return true;
  const base = path.split('/').pop() ?? path;
  return SENSITIVE_BASENAMES.some((re) => re.test(base));
}
