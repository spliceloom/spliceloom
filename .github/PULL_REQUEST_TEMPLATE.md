## What and why

<!-- One topic per PR. What changed, and why. Link the issue if there is one. -->

## Checklist

- [ ] `npm test` passes (clean build + all tests)
- [ ] `npm run typecheck` passes
- [ ] Behaviour changes have tests; docs in `docs/` updated when commands or behaviour change
- [ ] No secrets, tokens or `.env` files; no new runtime dependency (or a stated reason)
- [ ] Security-sensitive change (runtime, network policy, verification, registry auth)? Regression
      tests added and `docs/security.md` updated — see [CONTRIBUTING.md](../CONTRIBUTING.md)
- [ ] Published skill files untouched, or the skill version is bumped
