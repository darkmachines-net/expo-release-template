# Consumer integration

This module owns the boundary between application code and the shared release workflow: [config.mjs](config.mjs) validates configuration, [source.mjs](source.mjs) inspects and prepares source, and [expo.cjs](expo.cjs) supplies the public Expo helpers. Provider operations remain in the shared workers.

## Configuration

`release.config.json` is authoritative and validated against the [package schema](../../schemas/release.config.schema.json). It declares repository/default branch, profiles, source input prefixes, application identity, version floors, metadata files, install commands and optional hooks. It does not define an execution graph. Each mobile profile names an EAS environment/channel/build profile; workflow environments govern approvals, signing, submission and deployment.

Public source values come from `profiles.*.publicEnvironment` and declared `mobile.publicVariables` read from EAS. [readEnvironments](../eas.mjs) rejects undeclared values, hidden secrets and file variables because native compatibility must be inspectable before a build. Committed public values must agree with EAS.

## Hooks

Hooks are argv arrays executed in the consumer checkout. Each receives one JSON object on stdin containing `root`, `action` and the fields below, and returns one JSON object on stdout. Send diagnostic and child-process logs to stderr. An absent optional hook returns `{}`. Hooks never publish or write release lifecycle state.

| Hook | Request and result |
| --- | --- |
| `inspect` | Receives `source` and `config`; optionally returns `server`, `js` keyed by platform, and `extraNative` identities. |
| `prepare` | Receives `plan`; stamps allocated versions in declared `metadataFiles` only. |
| `validate` | Receives `plan`; runs application source checks. |
| `buildPrepare` | Required for the command builder; receives `plan` and generates native source without signing or publication secrets. |
| `build` | Required for the command builder; receives `plan` and an absolute artifact `directory`, writes per-target artifacts, and returns `{ "targets": ["target-id"] }`. See [commandBuild](../build.mjs) for filenames and the signing environment. |
| `verify` | Required for the command builder; receives `plan`, `target`, and `directory` for native artifacts, or `baseUrl` for the isolated server smoke container. Checks application artifacts. |

[hook](source.mjs) filters the environment to allowlisted host/tool paths and supplied public inputs. Only the exceptional command build receives Android signing variables. Ordinary EAS builds use EAS-managed credentials; their authenticated source evaluation boundary is documented in [cloudBuild](../eas.mjs).

## Package helpers and fingerprints

The root package exports source hashing/environment helpers from [io.mjs](../io.mjs) and selection/version helpers from [engine.mjs](../engine.mjs). `@mchartier/expo-release/engine` exposes the dependency-free engine. `@mchartier/expo-release/expo` exposes `runtimeVersion(version)`, `fingerprintTransform` and `developmentConfig` from [expo.cjs](expo.cjs). Other modules are internal.

Use Expo's fingerprint configuration to exclude only allocated metadata. Retain native code, dependency versions, configuration and relevant environment inputs. [prepare](source.mjs) re-inspects compatibility after stamping and rejects a changed fingerprint family; consumer tests must also prove version stamping leaves fingerprints unchanged. The [serverless example](../../examples/expo-only/README.md) shows the configuration hooks in use.

## Development previews

Add a top-level `development` configuration with `easProfile: "development"`, an EAS environment, an existing protected `approvalEnvironment`, supported phone `platforms`, and declared `publicEnvironment` values including `EXPO_RELEASE_VARIANT: "development"`. It is separate from release profiles and has no channel or submission destination. The existing public EAS input rules apply.

Install the Expo-SDK-compatible `expo-dev-client` and keep `expo-updates`. Wrap the final Expo config with `developmentConfig(config)` from `@mchartier/expo-release/expo`. It leaves release builds intact and gives the development app its own name, scheme, application ID and fingerprint runtime. It removes store deep-link ownership and the update-channel header. Development previews require the corresponding development native inputs; they do not validate the release-mode OTA startup lifecycle. Do the final candidate validation in beta.

The EAS development profile must set `developmentClient: true`, `distribution: "internal"`, `autoIncrement: false`, its declared environment and public env values, with no `channel` or inherited profile. Android produces an APK; physical iOS uses ad hoc signing and registered devices. Set up the new development application IDs and signing through official EAS tooling before noninteractive CI; existing store installations remain separate. Rebuild when native dependencies or configuration change.

Add root scripts `"preview": "expo-release preview"` and `"dev:native": "expo-release dev"`. Install dependencies and EAS CLI 25.3.0, authenticate with `eas login`, and install a development build. Then, before opening a review:

```sh
npm run preview -- --platform android
# or: npm run preview -- --platform ios
```

The command exports the current working copy, including uncommitted edits, without source publishing credentials. It checks native inputs again after export, seals the exact files, and publishes them from an inert project to a unique `preview-…` branch. It prints the EAS dashboard link, source/dirty status and native runtime. Open Preview on that page and scan the QR code with a compatible development app. No PR, push, beta promotion or production channel change is required. Each invocation publishes a separate preview; there is no mutable shared development channel. EAS project access controls apply to shared links. Cleanup of old preview branches is an explicit EAS operation.

`npm run dev:native` starts Metro with the development app identity for local live reload. `preview` uploads a self-contained bundle, so its recipient does not need Metro running. Both use declared public configuration; backend selection is independent of OTA channel selection.

Pin an optional manual consumer `.github/workflows/development.yml` caller to the same toolkit SHA as the package and release workflow. The shared workflow accepts `build` or `update`, platform, and an optional source branch name or full commit SHA in the same repository; dispatch the workflow from the default branch. For example, select the app's default branch under Use workflow from and enter codex/android-tile-audio as Source. Push the source branch first. The context job resolves it to a commit once, so builds, exports and job retries retain that source even if the branch advances. A blank Source uses the dispatch commit.

`build` exports a hosted preview, builds the client from the same source and public environment, and publishes the preview only after the finished client's identity and runtime match the export. A successful run provides both an install link and a compatible preview link. Install the client, then scan the preview's development-build QR code or refresh the client's Updates tab and select the branch named in the summary. Metro is not required. An export, build or runtime-verification failure prevents publication; a publish failure leaves the client available but the workflow incomplete. Retry failed jobs to reuse the completed export and client. `update` exports and publishes for an existing compatible client without building another one. Older previews with different native fingerprints cannot be opened by a newly built client; publish from that client's source or make a paired build.

Source install/export run without provider credentials. EAS Build's authenticated source evaluation remains the documented exception. Only the isolated preview publisher receives upload credentials. No release history, reservation or store state is changed. Retries reuse completed current-run producers; lost preview/build acknowledgements can lead to redundant delivery.

Release profiles should be named `beta` and `production` with matching channels. Beta uses TestFlight/Play testing, while production uses its public OTA channel and an explicitly configured store destination. An EAS iOS submission uploads to App Store Connect/TestFlight; public App Store review and release remain separate. Android draft submissions likewise require store completion. Approval environment names are independent and can reuse existing protected environments. For paired targets, `profiles.*.submitProfiles` maps target IDs to EAS submit profiles, overriding the target's default so beta cannot accidentally use a production track.
