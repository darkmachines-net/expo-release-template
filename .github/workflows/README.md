# Release workflow operations

[release.yml](release.yml) owns the three fixed release paths and their approval boundaries; [worker.mjs](../../src/worker.mjs) implements its phases. Consumers call this workflow from a manual `workflow_dispatch` with `profile` and optional `rebuild`. The worker requires a fresh invocation from the configured default branch and rejects job reruns. The [root README](../../README.md) describes selection, versions and execution order; the [consumer module](../../src/consumer/README.md) owns configuration and hooks.

## Set up a consumer

1. Choose a reviewed toolkit commit. Install the root package through a full-SHA Git dependency and pin the reusable workflow to that same SHA. Run [scripts/sync-engine.mjs](../../scripts/sync-engine.mjs) as described in the root README to update both pins and regenerate the npm lock. Install with `npm ci`.
2. Protect the default branch, the configured publication/signing/submission/deployment environments and the `expo-release/v3/**` tag namespace. Preserve application IDs, upload/signing keys, EAS projects, channels and deployment destinations.
3. Read existing metadata and provider high-water marks. Set `versionFloor` values at or above already used semantic versions so the next allocation is higher. Set Calibrate's `pairCodeFloor` at or above every used phone/watch code. For ordinary EAS builds, use `eas build:version:set` to initialize independent Android/iOS remote counters at or above the verified platform floors. Never reset a live counter downward.
4. Configure existing credentials through official EAS tools. For EAS Submit, configure the exact Android track or numeric iOS `ascAppId` and assign existing remote submission credentials. Do not generate replacement signing keys. Configure the command builder's signing inputs using [commandBuild](../../src/build.mjs).
5. Verify declared public EAS inputs and protected environment credentials. For server delivery, preserve the existing WireGuard webhook configuration; [deploymentInputs](../../src/deploy.mjs) documents the exact variable/secret names. Preview with `npm run release -- plan --profile PROFILE`; it is read-only.
6. A human dispatches the first release from the protected default branch. Without current-format history, it creates a new mobile major, builds all enabled platforms and establishes fresh successful baselines. Old installed runtimes need a binary upgrade. Later OTA delivery reaches installations sharing the new major; a later major retires automatic delivery to the previous runtime.

## Immutable evidence and fresh releases after failure

Only current-format history is supported. Old plans, receipts, pending requests, signer histories and runtime baselines are not imported; existing legacy releases cannot be recovered through this toolkit.

Keep reservation tags, plans and provider evidence immutable. [begin](../../src/github.mjs) records operation intent as a GitHub deployment before an external request and rejects a second attempt for that operation in the same run. Its payload identifies the target, source/build commit and run. [complete](../../src/github.mjs) retains provider evidence on the corresponding GitHub Release before marking that deployment successful. Only confirmed successes advance target baselines; missing evidence never counts as success.

After a failed, cancelled or interrupted release, start a fresh dispatch from the protected default branch. No GitHub deployment cleanup or manual reconciliation is required. Earlier attempts remain available for diagnosis but cannot block a new run, even when their status is absent, pending or uncertain. Reserved versions remain consumed; the new run selects work against each target's last confirmed success and allocates new versions where needed. If a provider accepted a request whose acknowledgement was lost, the new release may perform redundant work. This is an intentional availability tradeoff, not evidence that the earlier request failed.

Within a run, provider writes remain single-attempt and workflow job reruns are rejected. Repository release serialization, approval environments, artifact identity checks and provider-side restrictions still apply. A continuing credentials, service or provider error can fail a new attempt; historical toolkit records cannot permanently disable delivery. There is no replay/recovery CLI.
