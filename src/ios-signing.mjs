/** @file Check live iOS store signing and refresh existing profiles through the pinned EAS credential adapter. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { assert } from './engine.mjs';
import { run } from './io.mjs';
import { targetBuilder } from './consumer/config.mjs';
import { EAS_VERSION } from './eas.mjs';

/** Select only planned iOS cloud builds; OTA and server-only releases need no signing access. */
export function iosSigningTargets(plan) {
  return plan.native ? (plan.config.mobile?.targets ?? []).filter(target => target.platform === 'ios' && targetBuilder(plan.config, target) === 'eas') : [];
}

/** Resolve the installed official CLI on Windows/Linux and reject internal API use with another version. */
export function installedEas(binary = 'eas') {
  const executable = binary === 'eas' ? run(process.platform === 'win32' ? 'where.exe' : 'which',
    [process.platform === 'win32' ? 'eas.cmd' : 'eas']).trim().split(/\r?\n/)[0] : binary;
  const manifest = executable.endsWith('.cmd') ? [path.resolve(path.dirname(executable), '../eas-cli/package.json'),
    path.join(path.dirname(executable), 'node_modules/eas-cli/package.json')].find(file => fs.existsSync(file))
    : path.resolve(fs.realpathSync(executable), '../../package.json');
  assert(manifest, 'Cannot resolve the installed EAS CLI for iOS signing.');
  const upstream = createRequire(manifest), pkg = upstream('./package.json');
  assert(pkg.name === 'eas-cli' && pkg.version === EAS_VERSION, `iOS signing requires the pinned EAS CLI ${EAS_VERSION}.`);
  return upstream;
}

/** Match required entitlements against profile grants, including Apple prefix substitutions and grant wildcards. */
export function permitsEntitlements(required, granted, prefixes = {}) {
  if (Array.isArray(required)) return (Array.isArray(granted) || typeof granted === 'string')
    && required.every(value => (Array.isArray(granted) ? granted : [granted]).some(grant => permitsEntitlements(value, grant, prefixes)));
  if (required && typeof required === 'object') return !!granted && typeof granted === 'object'
    && Object.entries(required).every(([key, value]) => permitsEntitlements(value, granted[key], prefixes));
  if (typeof required === 'string' && typeof granted === 'string') {
    const resolved = required.replace(/\$\((AppIdentifierPrefix|TeamIdentifierPrefix)\)/g, (token, key) => prefixes[key] ?? token);
    return granted.endsWith('*') ? resolved.startsWith(granted.slice(0, -1)) : resolved === granted;
  }
  return required === granted;
}

/**
 * Validate the selected store app and extensions against Apple, optionally refreshing its assigned profile once.
 * Requires the app's assigned EAS team API key. Never creates/revokes certificates, changes capabilities, or writes secrets to disk.
 * Provider errors stop the check; successful checks are deliberately not persisted as reusable release evidence.
 */
export async function checkIosSigning(plan, target, { upstream = installedEas(), repair = true, now = Date.now() } = {}) {
  assert(iosSigningTargets(plan).some(value => value.id === target.id && value.applicationId === target.applicationId), 'Unknown iOS signing target.');
  const requirements = plan.iosSigning?.[target.id];
  assert(Array.isArray(requirements) && requirements.length && requirements[0].bundleIdentifier === target.applicationId
    && requirements.every(value => value.bundleIdentifier === target.applicationId || value.bundleIdentifier.startsWith(`${target.applicationId}.`)),
  'Missing or mismatched inspected iOS signing requirements.');
  assert(process.env.EXPO_TOKEN, 'iOS signing needs EXPO_TOKEN in the protected signing environment.');
  const { createGraphqlClient } = upstream('./build/commandUtils/context/contextUtils/createGraphqlClient.js');
  const { getOwnerAccountForProjectIdAsync } = upstream('./build/project/projectUtils.js');
  const { CredentialsContext } = upstream('./build/credentials/context.js');
  const { getBuildCredentialsAsync, assignBuildCredentialsAsync } = upstream('./build/credentials/ios/actions/BuildCredentialsUtils.js');
  const { tryAuthenticateAppStoreWithEasAscApiKeyAsync } = upstream('./build/credentials/ios/actions/AscApiKeyUtils.js');
  const { ConfigureProvisioningProfile } = upstream('./build/credentials/ios/actions/ConfigureProvisioningProfile.js');
  const { CreateProvisioningProfile } = upstream('./build/credentials/ios/actions/CreateProvisioningProfile.js');
  const { validateProvisioningProfileAsync } = upstream('./build/credentials/ios/validators/validateProvisioningProfile.js');
  const { parse } = upstream('./build/credentials/ios/utils/provisioningProfile.js');
  const { IosDistributionType } = upstream('./build/graphql/generated.js');
  const { AppleTeamType } = upstream('./build/credentials/ios/appstore/authenticateTypes.js');
  const client = createGraphqlClient({ accessToken: process.env.EXPO_TOKEN, sessionSecret: null });
  const account = await getOwnerAccountForProjectIdAsync(client, plan.config.mobile.projectId);
  assert(account.name === plan.config.mobile.owner, 'EAS project owner differs from the release configuration.');
  for (const requirement of requirements) {
    const app = { account, projectName: plan.config.mobile.slug, bundleIdentifier: requirement.bundleIdentifier };
    const context = new CredentialsContext({ projectDir: process.cwd(), graphqlClient: client, nonInteractive: true });
    const identity = { targetName: app.bundleIdentifier, bundleIdentifier: app.bundleIdentifier };
    const setup = `Run eas credentials:configure-build --platform ios --profile ${plan.config.profiles[plan.profile].easProfile} from the app directory.`;
    try {
      assert(await tryAuthenticateAppStoreWithEasAscApiKeyAsync(context, app, AppleTeamType.COMPANY_OR_ORGANIZATION),
        `iOS signing for ${app.bundleIdentifier} needs an assigned App Store Connect team API key with provisioning access. ${setup}`);
      const before = await getBuildCredentialsAsync(context, app, IosDistributionType.AppStore);
      const certificate = before?.distributionCertificate;
      assert(certificate && new Date(certificate.validityNotBefore).getTime() <= now && new Date(certificate.validityNotAfter).getTime() > now,
        `iOS distribution certificate is missing or expired for ${app.bundleIdentifier}; operator renewal is required. ${setup}`);
      const certificates = await context.appStore.listDistributionCertificatesAsync();
      assert(certificates.some(value => value.serialNumber === certificate.serialNumber),
        `iOS distribution certificate was revoked or is unavailable for ${app.bundleIdentifier}; operator renewal is required. ${setup}`);
      assert(before.provisioningProfile, `No existing App Store provisioning profile for ${app.bundleIdentifier}. ${setup}`);
      /** Check both live provider validity and the entitlements inspected without credentials from this release's source. */
      const valid = async credentials => {
        if (!await validateProvisioningProfileAsync(context, identity, app, credentials)) return false;
        const profile = parse(credentials.provisioningProfile.provisioningProfile);
        return new Date(profile.ExpirationDate).getTime() > now && permitsEntitlements(requirement.entitlements, profile.Entitlements, {
          AppIdentifierPrefix: `${profile.ApplicationIdentifierPrefix?.[0]}.`, TeamIdentifierPrefix: `${profile.TeamIdentifier?.[0]}.`,
        });
      };
      if (!await valid(before)) {
        assert(repair, `iOS provisioning profile needs refresh for ${app.bundleIdentifier}. ${setup}`);
        const refreshed = await new ConfigureProvisioningProfile(app, identity, certificate, before.provisioningProfile).runAsync(context);
        // Apple regeneration can replace the profile ID before EAS acknowledges it. A later attempt may replace that missing profile.
        if (!refreshed) {
          const replacement = await new CreateProvisioningProfile(app, identity, certificate).runAsync(context);
          await assignBuildCredentialsAsync(context, app, IosDistributionType.AppStore, certificate, replacement);
        }
        const after = await getBuildCredentialsAsync(context, app, IosDistributionType.AppStore);
        assert(after?.distributionCertificate?.id === certificate.id && after.distributionCertificate.serialNumber === certificate.serialNumber,
          'iOS profile repair unexpectedly changed the distribution certificate.');
        assert(await valid(after), `Refreshed iOS profile is invalid or lacks required entitlements for ${app.bundleIdentifier}; verify Apple App ID capabilities. ${setup}`);
      }
      console.error(`Verified iOS store signing for ${app.bundleIdentifier}; existing distribution certificate retained.`);
    } catch (error) {
      throw new Error(`iOS signing check failed for ${app.bundleIdentifier}: ${error.message} Verify the assigned team API key and Apple provisioning access. ${setup}`, { cause: error });
    }
  }
}
