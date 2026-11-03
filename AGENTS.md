<!-- BEGIN CODEX PROJECT VALIDATION -->
## Project validation

- `.pre-commit-config.yaml` is the canonical fast-check configuration.
  Use `prek`; do not install or invoke `pre-commit`.
- After meaningful executable changes, run `prek run --files <changed files>`
  and the related project-native tests before reporting completion.
- Native lint: `npm run lint`
- Native typecheck: `npm run typecheck`
- Native test: `npm run test`
- Native build: `npm run build`
- Run Gitleaks before commits and releases, OSV-Scanner when dependency inputs change,
  and Semgrep for security-sensitive source changes.
- Fix and rerun failures without weakening checks.
  Do not modify unrelated pre-existing changes merely to make validation pass.
- Do not write generated validation state under the reserved project `.codex` directory
  or accumulate project validation reports.
<!-- END CODEX PROJECT VALIDATION -->
