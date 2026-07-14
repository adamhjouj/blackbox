## What changed

<!-- Describe behavior, not just files. -->

## Why

<!-- Which recording, investigation, or usability problem does this solve? -->

## Verification

- [ ] `npm test`
- [ ] `npm audit --omit=dev`
- [ ] Tested with `npm run demo` when user-facing
- [ ] No real session data, local paths, credentials, databases, or keys committed

## Security and evidence integrity

- [ ] Redaction still occurs before persistence
- [ ] Existing event bytes and chain verification are unchanged, or the schema change is explicitly documented
- [ ] Recorded data still uses safe text rendering
- [ ] New limitations and trust-boundary changes are documented
