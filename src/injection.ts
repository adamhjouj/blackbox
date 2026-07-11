/**
 * Prompt-injection scanner. Runs at CAPTURE time in normalize() on the ORIGINAL
 * (pre-elision) tool output, because output bodies are elided to a hash before
 * storage and therefore cannot be re-scanned later. Its result is persisted as a
 * FACT in the (hashed) `detail.output_signals`, not as an interpretation.
 *
 * In ruleset r1 this fact is scored 0 (informational). The injected-tamper combo
 * (the circle-back) is what turns it into a HIGH signal, after validation.
 */
export const INJECTION_SCANNER_VERSION = 'i1';

const MAX_SCAN = 64 * 1024;

const PATTERNS: [string, RegExp][] = [
  ['ignore-instructions', /\bignore\s+(all\s+)?(the\s+)?(previous|prior|above|earlier|preceding)\s+(instructions?|prompts?|messages?|context)/i],
  ['disregard', /\bdisregard\s+(all\s+)?(previous|prior|the above|your|any)/i],
  ['new-instructions', /\b(new|updated|revised|real|actual)\s+(instructions?|system\s+prompt|directive|task)\b/i],
  ['you-are-now', /\byou\s+are\s+now\s+(a|an|the|no longer)\b/i],
  ['reveal-prompt', /\b(reveal|print|show|output|repeat|display|dump)\s+(me\s+)?(your\s+)?(system\s+prompt|initial\s+(prompt|instructions)|instructions|guidelines)\b/i],
  ['conceal-from-user', /\bdo\s+not\s+(tell|inform|mention|reveal|disclose)[^.]{0,20}\b(the\s+)?(user|human|operator)\b/i],
  ['override-safety', /\boverride\s+(your\s+)?(instructions?|guidelines?|safety|restrictions?)\b/i],
  ['fake-role-tag', /<\/?(system|instructions?|important|admin)\s*>/i],
];

export interface InjectionResult {
  patterns: string[];
  truncated: boolean;
  scanner_version: string;
}

/** Scan text for injection-shaped markers. Returns null when clean. */
export function scanOutputForInjection(text: string): InjectionResult | null {
  if (!text) return null;
  const truncated = text.length > MAX_SCAN;
  const scan = truncated ? text.slice(0, MAX_SCAN) : text;
  const patterns = PATTERNS.filter(([, re]) => re.test(scan)).map(([id]) => id);
  return patterns.length ? { patterns, truncated, scanner_version: INJECTION_SCANNER_VERSION } : null;
}

/** Extract a scannable string from a tool_response of any shape (string / object / MCP content array). */
export function outputToText(output: unknown): string {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.map(outputToText).join('\n');
  if (typeof output === 'object') {
    const o = output as Record<string, unknown>;
    // common shapes: {stdout,stderr}, {text}, {file:{content}}, {content:[...]}
    return [o.stdout, o.stderr, o.text, o.content, (o.file as Record<string, unknown> | undefined)?.content]
      .filter((v) => v != null)
      .map(outputToText)
      .join('\n');
  }
  return '';
}
