## Project rules

1. When adding a package, use Bun to install its latest available version. Do not guess or copy a
   version number into `package.json`.

2. Prefer arrow functions over anonymous `function` expressions and named declarations. Use a
   normal function only when JavaScript or TypeScript semantics require one, such as a dynamic
   `this`, `arguments`, a constructor, or declaration-based control-flow narrowing.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for `LSP-Software/DotRelay`. See `docs/agents/issue-tracker.md`.

### Triage labels

The default five-label triage vocabulary is used. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses the single-context domain-doc layout. See `docs/agents/domain.md`.
