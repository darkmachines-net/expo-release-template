/** @file Configure development-first delivery and require a real reviewer gate before beta promotion. */
import { loadConfig, verifyPins } from './consumer/config.mjs';
import { hostedIdentity, output } from './worker.mjs';
import { github } from './github.mjs';
import { assert } from './engine.mjs';

/** Require reviewer-protected promotion and reviewer-free development so no publication can silently bypass testing. */
export function verifyPromotionEnvironments(promotion, development) {
  assert(promotion?.protection_rules?.some(rule => rule.type === 'required_reviewers' && rule.reviewers?.length),
    'Continuous delivery requires required reviewers on its promotion environment.');
  assert(!development?.protection_rules?.some(rule => rule.type === 'required_reviewers' && rule.reviewers?.length),
    'Development preparation must use a reviewer-free environment.');
}

/** Resolve immutable source and beta staging settings; release history is read later, after manual approval. */
export async function continuousContext(root, env = process.env, client) {
  const config = loadConfig(root), profile = env.RELEASE_PROFILE;
  const continuous = profile === 'beta' && Boolean(config.development?.channel && config.development?.promotionEnvironment);
  const identity = hostedIdentity(config, env, continuous ? ['workflow_dispatch', 'push'] : ['workflow_dispatch']);
  verifyPins(root, identity.toolkit);
  assert(config.profiles[profile], 'Unknown release profile.');
  if (continuous) {
    client ??= github(config.repository);
    const spec = config.development;
    verifyPromotionEnvironments(await client.api('GET', `environments/${encodeURIComponent(spec.promotionEnvironment)}`),
      await client.api('GET', `environments/${encodeURIComponent(spec.approvalEnvironment)}`, undefined, { optional: true }));
  }
  for (const [key, value] of Object.entries({ continuous, platforms: continuous ? config.development.platforms : [],
    channel: config.development?.channel, approval: config.development?.promotionEnvironment })) output(key, value);
}
