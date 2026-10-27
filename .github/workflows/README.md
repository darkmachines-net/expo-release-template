# Release workflow operations

[release.yml](release.yml) owns the three fixed release paths and their approval boundaries; [worker.mjs](../../src/worker.mjs) implements its phases. Consumers call this workflow from a manual `workflow_dispatch` with `profile` and optional `rebuild`. The worker accepts dispatches from the configured default branch and GitHub retries of those runs. The [root README](../../README.md) describes selection, versions and execution order; the [consumer module](../../src/consumer/README.md) owns configuration and hooks.

## Set up a consumer

1. Choose a reviewed toolkit commit. Install the root package through a full-SHA Git dependency and pin the reusable workflow to that same SHA. Run [scripts/sync-engine.mjs](../../scripts/sync-engine.mjs) as described in the root README to update both pins and regenerate the npm lock. Install with `npm ci`.
2. Protect the default branch, the configured publication/signing/submission/deployment environments and the `expo-release/v3/**` tag namespace. Preserve application IDs, upload/signing keys, EAS projects, channels and deployment destinations.
3. Read existing metadata and provider high-water marks. Set `versionFloor` values at or above already used semantic versions so the next allocation is higher. Set Calibrate's `pairCodeFloor` at or above every used phone/watch code. For ordinary EAS builds, use `eas build:version:set` to initialize independent Android/iOS remote counters at or above the verified platform floors. Never reset a live counter downward.
4. Configure existing credentials through official EAS tools. For EAS Submit, configure the exact Android track or numeric iOS `ascAppId` and assign existing remote submission credentials. Do not generate replacement signing keys. Configure the command builder's signing inputs using [commandBuild](../../src/build.mjs).
5. Verify declared public EAS inputs and protected environment credentials. For server delivery, preserve the existing WireGuard webhook configuration; [deploymentInputs](../../src/deploy.mjs) documents the exact variable/secret names. Preview with `npm run release -- plan --profile PROFILE`; it is read-only.
6. A human dispatches the first release from the protected default branch. Without current-format history, it creates a new mobile major, builds all enabled platforms and establishes fresh successful baselines. Old installed runtimes need a binary upgrade. Later OTA delivery reaches installations sharing the new major; a later major retires automatic delivery to the previous runtime.

## Immutable evidence and job retries

Only current-format history is supported. Old plans, receipts, pending requests, signer histories and runtime baselines are not imported; existing legacy releases cannot be recovered through this toolkit.

Use GitHub's **Re-run failed jobs** after fixing credentials or another failure. Retries retain the original source, tagged build commit, plan, semantic versions and paired build-number reservation. Completed job artifacts are restored from the same run and never overwritten. An expired or missing artifact cannot replace a conflicting reservation or receipt; start a fresh dispatch if the original inputs are no longer available.

[perform](../../src/github.mjs) reads immutable provider evidence before a publication, submission or deployment. Confirmed operations are skipped, including a successful phone/Android submission when its watch/iOS sibling failed. A receipt saved before a failed deployment-status write repairs that status without another provider request. Only confirmed successes advance target baselines. Native recording/submission validates the available platform artifacts; an entirely missing build set fails explicitly. Paired command builds still require both artifacts.

[EAS cloud builds](../../src/eas.mjs) use the official build-list/view interfaces to reconnect to this run's accepted build. Pending builds resume waiting and finished builds are reused; failed or cancelled builds may be replaced with a new managed build number. Native compatibility remains independent of store submission.

EAS submissions of cloud builds also reconcile through official submit-list/view interfaces before another submission. A finished submission for the exact build and destination is reused even if its GitHub receipt was lost; a pending submission resumes waiting. Failed or cancelled submissions can be replaced. Command-built AAB uploads have no EAS build identity, so only their saved GitHub receipts prevent resubmission.

Each operation makes at most one provider write per workflow attempt. A later explicit retry can repeat other unconfirmed work; redundant delivery remains possible when no receipt or matching provider record survived. Missing evidence never counts as success, denied/read failures stop the job, and a successful deployment missing its receipt is rejected. Transient GitHub GET failures retry twice; there are no automatic write retries or recovery CLI. Repository serialization, protected environments, signing and artifact identity checks apply to every attempt.

A fresh dispatch remains available after failure without GitHub deployment cleanup or manual reconciliation. It selects work against each target's last confirmed success and allocates new versions; previous reservations remain consumed. Existing runs pin their original toolkit revision, so a newly merged retry fix only affects new dispatches.

## Development build and preview workflow

[development.yml](development.yml) is an optional manual workflow alongside release.yml. It never dispatches a release. Configure and use it as described in the [development preview contract](../../src/consumer/README.md#development-previews). Package, release-workflow and development-workflow pins must match; the shared pin updater handles all three.

## Cloud Run and Firebase Hosting

Set server.deployment to provider cloud-run, the existing service, repository, region, migrationJob, optional jobs, and originVariable naming the public HTTPS origin in each profile public environment. Bootstrap infrastructure before release. The deployment worker owns image promotion, migration execution, isolated readiness, traffic, scheduled-job images and Hosting rewrites. It does not provision databases or run account imports.

The protected deployment environment supplies GCP_PROJECT_ID, GCP_WORKLOAD_IDENTITY_PROVIDER and GCP_SERVICE_ACCOUNT. Configure GitHub OIDC federation restricted to the repository, default branch, protected environment and trusted reusable workflow. Grant that identity registry write, Cloud Run deployment/job execution, runtime service-account use and Hosting deployment. The caller must permit id-token: write. No service-account key is needed. The runtime identity remains separate.

A confirmed current-run deployment receipt skips repeat work. An unconfirmed job retry uses a new revision suffix for the workflow attempt; migration commands must be safe to rerun. Failures never advance the success baseline. Inspect ambiguous provider executions before maintenance or destructive recovery. New releases remain possible regardless of previous uncertainty. Tests inject every command and never dispatch a live release.
