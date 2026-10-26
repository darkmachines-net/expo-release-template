# Expo releases: three fixed paths

This package provides one reusable GitHub Actions workflow for Docker server releases, native Expo builds and current-runtime OTA updates. GitHub runs jobs and approvals. Official EAS tooling builds, submits and distributes mobile releases. Consumers provide application configuration, input boundaries, metadata transformations and exceptional builders.

The complete toolkit requires Node 22.14+; CI uses Node 24 on Windows and Linux. The pure planning engine supports Node 20+ without dependencies. The only runtime package dependency is Ajv for configuration validation.

## Install and configure

Install `@mchartier/expo-release` from a reviewed full Git SHA and use that same SHA for `.github/workflows/release.yml`. Run `node scripts/sync-engine.mjs FULL_SHA CONSUMER...` from this repository to update consumer package/workflow pins and regenerate npm locks. It copies no engine snapshots.

Add a small [release.config.json](schemas/release.config.schema.json), an EAS profile for each release destination, and a manual `workflow_dispatch` caller. Profiles name the EAS environment/channel and existing protected GitHub environments. The reusable workflow verifies the protected default-branch invocation and serializes all releases in the repository. Dispatch only `profile` and optional `rebuild`.

Use `npm run release -- validate` to check configuration. `npm run release -- plan --profile production` previews selection by reading GitHub history and EAS public environment values. It requires `gh` authentication and the pinned official EAS CLI on PATH. `--history CONTEXT.json` permits an offline preview with explicit `history` and `environments`. Planning never reserves versions or publishes anything.

Hosted jobs install EAS CLI **25.3.0** using the pinned official Expo GitHub Action. There is no custom installer, bundled EAS lockfile or private EAS API adapter. Ordinary Expo builds use `appVersionSource: remote` and `autoIncrement: true`. Follow [workflow setup](.github/workflows/README.md#set-up-a-consumer) to initialize counters and credentials before the first dispatch.

See the [serverless example](examples/expo-only/README.md), [consumer contract and hooks](src/consumer/README.md), and [workflow operations](.github/workflows/README.md).

## Development, beta and production

Use three build profiles but only two persistent release channels. `development` is a custom Expo development client that opens a selected preview; `beta` and `production` are release-mode builds following their corresponding channels. Development is configured separately from `profiles`, so previews do not allocate release versions, establish release baselines, deploy servers or submit to stores.

For the manual pre-review workflow and native-client setup, see [development previews](src/consumer/README.md#development-previews). The optional [Development workflow](.github/workflows/development.yml) builds an installable client with a matching hosted preview, or publishes a preview for an existing compatible client. Store releases continue through [release.yml](.github/workflows/release.yml).

## Selection and versions

| Work | Mobile version | Action |
| --- | --- | --- |
| Native fingerprint changed, including first cutover | Next major | Build every enabled platform; runtime is the new major |
| Compatible binary rebuild requested | Next minor | Build binaries and publish OTA for the same runtime |
| JS/assets changed with compatible native inputs | Next patch | OTA for affected platforms |
| No relevant changes | Unchanged | No release work |

There is one mobile semantic version across platforms. Expo runtime is an explicit string such as `"2"`. Binaries 2.0.0 and 2.1.0 can receive bundle version 2.1.1 when their native compatibility is unchanged. Installed binaries keep their original binary version; OTA metadata carries the newer bundle release version. A changed fingerprint always starts a new major. OTA never backports to a different runtime.

The server has an independent patch version. Git input sets retain binary changes, deletions, lockfiles and shared packages. Baselines belong to each successful target, independent of the overall workflow conclusion. Native compatibility belongs to successful builds, independently of store submission status. Calibrate additionally deploys its diagnostic server metadata when producing a new native version.

The workflow stamps a detached child commit of the selected source and reserves annotated tags under `expo-release/v3/`. Failed reservations consume their versions. GitHub job retries reuse the same plan and versions, restore completed artifacts and skip confirmed provider operations. Failed or interrupted operations do not block a fresh dispatch or require manual cleanup; only confirmed successes advance baselines. A lost provider acknowledgement can therefore cause redundant work in a later release. The workflow never changes the default branch or opens a version PR. Calibrate's one exception reserves an odd phone/even watch build-number pair above all prior reservations and the verified seed floor.

## Execution and trust

The server path builds and smoke-tests a Docker archive without registry credentials. A separate protected job verifies the current-run artifact, publishes version/commit tags and records its digest. The deployment job opens the configured WireGuard tunnel, invokes the existing webhook once and requires its success/health response before advancing the deployment baseline. A health response does not prove the exact remotely running image digest.

Selected server deployment precedes native delivery. Ordinary apps use EAS Build, followed by EAS Submit when configured. Internal distribution finishes with EAS Build. Calibrate keeps its paired Gradle builder and signing/artifact checks, then submits the resulting phone and watch bundles in order through EAS. Store review and promotions remain in provider tooling.

OTA export runs without publishing credentials. A separate protected publisher verifies the exact exported bytes and uses `eas update --skip-bundler`. On a new major, embedded bundles establish compatibility; no update is sent to the previous runtime. A compatible rebuild can publish OTA once native build evidence exists without waiting for store review.

Signing, publication and deployment use separate jobs. Privileged publishers use inert temporary EAS projects and never run consumer scripts. Source checks, Docker builds and OTA exports receive no publishing credentials. EAS cloud build's authenticated source evaluation is its explicit exception. Artifacts must match the current run, source, toolkit, plan, destination and file digests; local and imported receipts are unsupported.

## Maintenance

Run `npm run check` for documentation lint plus selection, reservations, preparation, trust boundaries, provider contracts, workflow ordering and installation checks. `npm run lint` checks file overviews and JSDoc descriptions on named functions/methods, including public APIs; `npm test` runs the behavioral suite. Tests never dispatch a live release. Keep authored shared implementation plus consumer integration below 3,000 physical lines; report tests, documentation, generated locks and existing application build tools separately.

Keep documentation with the code it describes, in file/function comments or the owning module's README. Update it with behavior changes and link to its owner rather than duplicating contracts. See [workflow operations](.github/workflows/README.md#immutable-evidence-and-job-retries) for evidence, retry and fresh-release behavior.
