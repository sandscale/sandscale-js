<!-- Copyright 2026 Neural Inverse -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Releasing @sandscale/sdk

This repository is a mirror: the source of truth is the private Neural Inverse Keystone
repository (`sdk/ts/sandscale`), and `sdk/scripts/sync-sandscale-sdks.sh` there writes this
tree. Do not commit here directly; changes go through Keystone and are synced on release.

A release is a `v*` tag on `main`. `.github/workflows/release.yml` checks that the tag equals
`package.json` and `src/version.ts`, runs typecheck, tests and the build, then runs
`npm publish --provenance --access public` using **npm trusted publishing**: GitHub's OIDC token
is exchanged for a short-lived publish credential, so no npm token exists in this repository.
A tag with a `-` (for example `v1.1.0-rc.1`) publishes under the `next` dist-tag.

## One-time owner setup

Do these in one sitting and finish with step 6: npm expires a trusted publisher configuration
that has not completed its first successful publish within 2 days.

1. Create the npm organization `sandscale` at https://www.npmjs.com/org/create (the free plan
   is enough for public packages). Add the people who may publish as owners.
2. A package's Trusted Publisher settings exist only on a package that exists, so claim the name
   once by hand, from any empty directory, signed in with `npm login` (2FA on):
   ```bash
   mkdir bootstrap && cd bootstrap
   echo '{"name":"@sandscale/sdk","version":"0.0.0","description":"placeholder","license":"Apache-2.0"}' > package.json
   npm publish --access public --tag bootstrap
   ```
   npm may still point `latest` at this empty placeholder (the first version of a package usually
   gets `latest` whatever tag you pass), so until step 6 completes `npm i @sandscale/sdk`
   installs nothing useful: do not announce the package before then.
3. Open https://www.npmjs.com/package/@sandscale/sdk/access (Settings, Trusted Publisher),
   choose GitHub Actions and fill in exactly:
   - Organization or user: `sandscale`
   - Repository: `sandscale-js`
   - Workflow filename: `release.yml`
   - Environment name: leave empty
   - Allowed actions: tick `npm publish` (the workflow publishes with `npm publish`; `npm stage
     publish` is always allowed)
4. On the same page set "Publishing access" to "Require two-factor authentication and
   disallow tokens". Revoke any automation token created while setting up.
5. Optionally `npm deprecate "@sandscale/sdk@0.0.0" "placeholder"`.
6. Publish the first real release by pushing the tag (the version in `package.json` is already
   1.0.0):
   ```bash
   git clone https://github.com/sandscale/sandscale-js && cd sandscale-js
   git tag v1.0.0 && git push origin v1.0.0
   ```
   Watch the `release` workflow; afterwards `npm view @sandscale/sdk dist-tags` shows `latest:
   1.0.0` and the package page shows the provenance badge. Requirements npm states for trusted
   publishing: npm CLI 11.5.1 or later and Node 22.14 or later (the workflow uses Node 24).

## Cutting a release (done by the Keystone sync, or by hand)

```bash
# In Keystone: node sdk/scripts/set-version.mjs --sandscale X.Y.Z, then run the sync script.
# In this repository, after reviewing and committing the synced tree:
git tag vX.Y.Z && git push origin vX.Y.Z
```

Watch the `release` workflow. Published versions are never overwritten; a bad version is
deprecated (`npm deprecate`) and fixed by a new one. Verify with `npm audit signatures` after
installing, and look for the provenance badge on the package page.

## If a publish fails

- `E404` or "not found" on publish: the trusted publisher is not configured, expired (2 days
  without a first publish; delete it and add it again), `npm publish` is not ticked under Allowed
  actions, or its repository, workflow filename or environment does not match what is above.
- `ENEEDAUTH`: the runner's npm is older than 11.5.1 (the workflow uses Node 24) or `id-token:
  write` was removed.
