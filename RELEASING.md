# Building and releasing

## Now: a tarball in each consumer's `vendor/`

1. Check everything: `npm run typecheck && npm test && npm run build && npx typedoc --treatWarningsAsErrors && npx tsc -p example --noEmit`.
2. Bump `version` in `package.json` (semver; a change to options, exports or migrations is at least a minor bump while 0.x).
3. `npm run pack:local` → `dist/helix-x-nestjs-api-gateway-<version>.tgz`. The tarball holds `dist/`, `migrations/`,
   `README.md` and `LICENSE`. Check it with `npm pack --dry-run`.
4. In each consumer's gateway package, run its `gateway-lib:sync` script (copy the tarball into `vendor/`, update
   the `file:` dependency, `npm install`), then its own build, tests and a boot.

A new migration file ships in `migrations/` with its sqlite twin. It records itself in `gateway_schema_migrations`
and is applied to every consumer at its next boot. Never edit or renumber a file that has been released.

## Later: npm

Copy `.github/workflows/` and `.github/scripts/` from `helix-x-db-manager` (CI, publish, docs, republish). Replace
its PostgreSQL service and `dist/cli.js` check with this package's checks (the steps above). Then follow that
repository's `RELEASING.md`: registry secrets, version bumps on the runner and release notes.
