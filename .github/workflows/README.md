# Release workflow operations

[release.yml](release.yml) owns the three fixed release paths and their approval boundaries; [worker.mjs](../../src/worker.mjs) implements its phases. Consumers call this workflow from a manual `workflow_dispatch` with `profile` and optional `rebuild`. The worker requires a fresh invocation from the configured default branch and rejects job reruns. The [root README](../../README.md) describes selection, versions and execution order; the [consumer module](../../src/consumer/README.md) owns configuration and hooks.

## Set up a consumer

1. Choose a reviewed toolkit commit. Install the root package through a full-SHA Git dependency and pin the reusable workflow to that same SHA. Run [scripts/sync-engine.mjs](../../scripts/sync-engine.mjs) as described in the root README to update both pins and regenerate the npm lock. Install with `npm ci`.
2. Protect the default branch, the configured publication/signing/submission/deployment environments and the `expo-release/v3/**` tag namespace. Preserve application IDs, upload/signing keys, EAS projects, channels and deployment destinations.
3. Read existing metadata and provider high-water marks. Set `versionFloor` values at or above already used semantic versions so the next allocation is higher. Set Calibrate's `pairCodeFloor` at or above every used phone/watch code. For ordinary EAS builds, use `eas build:version:set` to initialize independent Android/iOS remote counters at or above the verified platform floors. Never reset a live counter downward.
4. Configure existing credentials through official EAS tools. For EAS Submit, configure the exact Android track or numeric iOS `ascAppId` and assign existing remote submission credentials. Do not generate replacement signing keys. Configure the command builder's signing inputs using [commandBuild](../../src/build.mjs).
5. Verify declared public EAS inputs and protected environment credentials. For server delivery, preserve the existing WireGuard webhook configuration; [deploymentInputs](../../src/deploy.mjs) documents the exact variable/secret names. Preview with `npm run release -- plan --profile PROFILE`; it is read-only.
6. A human dispatches the first release from the protected default branch. Without current-format history, it creates a new mobile major, builds all enabled platforms and establishes fresh successful baselines. Old installed runtimes need a binary upgrade. Later OTA delivery reaches installations sharing the new major; a later major retires automatic delivery to the previous runtime.

## Immutable evidence and interrupted operations

Only current-format history is supported. Old plans, receipts, pending requests, signer histories and runtime baselines are not imported; existing legacy releases cannot be recovered through this toolkit.

Keep reservation tags, plans and provider evidence immutable. [begin](../../src/github.mjs) records operation intent as a GitHub deployment before an external request. Its payload identifies the target, source/build commit and run. [complete](../../src/github.mjs) retains provider evidence on the corresponding GitHub Release before marking that deployment successful. Missing acknowledgement leaves an outstanding operation; no rerun, missing receipt or timeout authorizes another request.

Investigate interrupted operations in GitHub, EAS and store tooling. Preserve actual provider evidence on the corresponding GitHub Release before recording a terminal status. A confirmed success can be marked `success`; a confirmed terminal failure or never-accepted request can be marked `failure`. `inactive`, absent and error statuses remain blocking. An unknown outcome must stay unresolved. After resolution, start a new dispatch; there is no replay/recovery CLI.
