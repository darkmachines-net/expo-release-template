# Serverless Expo application

Copy these configuration and metadata-hook examples into a normal Expo application. Set the real repository, owner, project ID and Android/iOS application identities. Add enabled targets and verified version floors. A `server` section is unnecessary. The [consumer module](../../src/consumer/README.md) documents the shared configuration and hook contract.

Follow the [installation instructions](../../README.md#install-and-configure), add `"release": "expo-release"`, and use Node 24.

The example provides development, beta and production build profiles. Development opens ad-hoc preview branches; beta and production follow their matching channels. Both release profiles use managed build counters. Store submission is disabled in this fixture; enable it and configure the exact submission destinations in a real consumer. Add the SDK-compatible expo-dev-client and follow the [development preview contract](../../src/consumer/README.md#development-previews) for manual pre-review uploads. Complete [workflow setup](../../.github/workflows/README.md#set-up-a-consumer) before dispatching.

The example follows the shared [selection and version policy](../../README.md#selection-and-versions). Tests exercise this configuration without server, WireGuard or store submission dependencies.
