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

The root package exports source hashing/environment helpers from [io.mjs](../io.mjs) and selection/version helpers from [engine.mjs](../engine.mjs). `@mchartier/expo-release/engine` exposes the dependency-free engine. `@mchartier/expo-release/expo` exposes `runtimeVersion(version)` and `fingerprintTransform` from [expo.cjs](expo.cjs). Other modules are internal.

Use Expo's fingerprint configuration to exclude only allocated metadata. Retain native code, dependency versions, configuration and relevant environment inputs. [prepare](source.mjs) re-inspects compatibility after stamping and rejects a changed fingerprint family; consumer tests must also prove version stamping leaves fingerprints unchanged. The [serverless example](../../examples/expo-only/README.md) shows the configuration hooks in use.
