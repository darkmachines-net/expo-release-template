/** @file Immutable release retries, independent baselines and bounded GitHub reads without repeated writes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { github, historyFrom, reserve, begin, complete, operationPayload, loadHistory, perform, receipt } from '../src/github.mjs';
import { selectRelease } from '../src/engine.mjs';
import { submit } from '../src/eas.mjs';
import { plan, observation } from './helpers.mjs';

/** Deterministic GitHub API stand-in which records ordering without networking. */
function client({ deployments = [], states = {}, failAt } = {}) {
  deployments = structuredClone(deployments); states = { ...states };
  const calls = [], assets = new Map(), refs = new Map(), tags = new Map();
  let next = 42, release;
  return { calls, assets, deployments,
    /** Return independent persistent deployment history. */
    async pages(route) { calls.push(['pages', route]); return deployments; },
    /** Persist tags, deployments and success statuses across simulated workflow attempts. */
    async api(method, route, body, options = {}) {
      calls.push([method, route, body]);
      if (failAt?.(method, route)) throw new Error('connection lost');
      if (route.includes('/statuses?')) return states[route.split('/')[1]] === undefined ? [] : [{ state: states[route.split('/')[1]] }];
      if (route.endsWith('/statuses')) { states[route.split('/')[1]] = body.state; return {}; }
      if (method === 'GET' && route.startsWith('git/ref/')) return refs.get(route.slice(8)) ?? null;
      if (method === 'GET' && route.startsWith('git/tags/')) return tags.get(route.slice(9));
      if (route === 'git/tags') { const sha = String(next++).padStart(40, '0'); tags.set(sha, { message: body.message, object: { sha: body.object } }); return { sha }; }
      if (route === 'git/refs') { refs.set(body.ref.slice(5), { object: { type: 'tag', sha: body.sha } }); return {}; }
      if (route === 'releases') { release = { id: 42 }; return release; }
      if (route.startsWith('releases/tags/')) return release ?? (options.optional ? null : { id: 42 });
      if (route === 'deployments') { const deployment = { id: next++, payload: body.payload }; deployments.unshift(deployment); return deployment; }
      throw new Error('Unexpected API route: ' + route);
    },
    /** Return immutable evidence saved by an earlier attempt. */
    async readEvidence(id, name) { return assets.get(name) ?? null; },
    /** Persist evidence without replacing previously confirmed results. */
    async evidence(id, name, body) {
      calls.push(['evidence', id, name, body]);
      if (failAt?.('evidence', name)) throw new Error('connection lost');
      if (assets.has(name)) assert.deepEqual(assets.get(name), body);
      else assets.set(name, structuredClone(body));
    }
  };
}

const changedEnvironment = new WeakSet();
/** Set a workflow attempt for one test and restore the caller's environment afterward. */
function setAttempt(t, value) {
  if (!changedEnvironment.has(t)) {
    changedEnvironment.add(t);
    const original = process.env.GITHUB_RUN_ATTEMPT;
    t.after(() => { if (original === undefined) delete process.env.GITHUB_RUN_ATTEMPT; else process.env.GITHUB_RUN_ATTEMPT = original; });
  }
  process.env.GITHUB_RUN_ATTEMPT = value;
}

test('reservation writes immutable annotated tags before evidence', async () => {
  const fake = client(), value = plan(); await reserve(fake, value);
  const refs = fake.calls.filter(([method, route]) => method === 'POST' && route === 'git/refs');
  assert.deepEqual(refs.map(call => call[2].ref), [
    'refs/tags/expo-release/v3/run/123', 'refs/tags/expo-release/v3/mobile/v1.0.0', 'refs/tags/expo-release/v3/server/v1.2.4'
  ]);
  assert.equal(fake.calls.at(-1)[0], 'evidence'); assert.equal(fake.calls.at(-1)[2], 'plan.json');
  assert.equal(fake.calls.filter(call => call[0] === 'PATCH').length, 0);
  const tag = JSON.parse(fake.calls.find(([method, route]) => method === 'POST' && route === 'git/tags')[2].message);
  assert.equal(tag.build, value.build); assert.equal(tag.family, value.observation.family);
});

test('lost reservation acknowledgement is not repeated', async () => {
  const fake = client({
    /** Lose acknowledgement while creating a reservation ref. */
    failAt: (_, route) => route === 'git/refs'
  });
  await assert.rejects(reserve(fake, plan()), /connection lost/);
  assert.equal(fake.calls.filter(call => call[1] === 'git/refs').length, 1);
  assert.ok(!fake.calls.some(call => call[1] === 'releases'));
});

test('known reservations consume failures independently of success baselines', () => {
  const value = plan();
  const records = [1, 2, 3].map(n => ({ format: 3, source: value.source, run: String(n), versions: { mobile: `1.${n}.0`, server: `0.0.${n}` }, family: 'native', pairCodeFloor: n * 2 }));
  const successful = operationPayload(value, 'build/android');
  const result = historyFrom(records, [{ payload: { ...successful, key: 'production/submit/android' }, state: 'pending' }, { payload: successful, state: 'success' }]);
  assert.equal(result.mobile.version, '1.3.0'); assert.equal(result.mobile.pairCodeFloor, 6);
  assert.equal(result.baselines['production/submit/android'], undefined);
  assert.equal(result.baselines['production/build/android'].runtime, '1');
  assert.equal(result.baselines['production/js/android'].input, 'js-A');
});

test('server failure cannot erase a successful mobile baseline or vice versa', () => {
  const value = plan();
  const result = historyFrom([], [
    { payload: operationPayload(value, 'deploy/server'), state: 'failure' },
    { payload: operationPayload(value, 'ota/android'), state: 'success' },
    { payload: { ...operationPayload(value, 'deploy/server'), input: 'old-server' }, state: 'success' }
  ]);
  assert.equal(result.baselines['production/deploy/server'].input, 'old-server');
  assert.equal(result.baselines['production/js/android'].input, 'js-A');
});

test('OTA reservations cannot erase earlier paired build-number reservations in either history order', () => {
  const records = [
    { format: 3, source: 'source', run: '1', versions: { mobile: '1.0.0' }, family: 'native', pairCodeFloor: 20 },
    { format: 3, source: 'source', run: '2', versions: { mobile: '1.0.1' }, family: 'native', pairCodeFloor: 0 },
  ];
  for (const order of [records, [...records].reverse()]) {
    const result = historyFrom(order, []);
    assert.equal(result.mobile.version, '1.0.1');
    assert.equal(result.mobile.pairCodeFloor, 20);
  }
});

test('latest successful native embedded bundle supersedes an earlier OTA baseline', () => {
  const value = plan();
  const result = historyFrom([], [
    { payload: { ...operationPayload(value, 'build/android'), bundleInput: 'reverted-js' }, state: 'success' },
    { payload: { ...operationPayload(value, 'ota/android'), input: 'old-ota' }, state: 'success' }
  ]);
  assert.equal(result.baselines['production/js/android'].input, 'reverted-js');
});

test('unconfirmed outcomes never advance a successful baseline', () => {
  for (const state of [undefined, 'pending', 'in_progress', 'queued', 'failure', 'error', 'inactive']) {
    const result = historyFrom([], [{ payload: operationPayload(plan(), 'ota/ios'), state }]);
    assert.deepEqual(result, { baselines: {} });
  }
});

test('intent is saved before the caller may invoke its provider', async () => {
  const fake = client(), value = plan();
  assert.equal(await begin(fake, value, 'ota/android'), 42);
  assert.equal(fake.calls.at(-1)[1], 'deployments');
  assert.equal(fake.calls.at(-1)[2].ref, value.build);
  assert.deepEqual(fake.calls.at(-1)[2].required_contexts, []);
  assert.equal(fake.calls.at(-1)[2].auto_merge, false);
});

test('every prior outcome permits a fresh operation without inspecting or rewriting the old status', async () => {
  for (const operation of ['publish/server', 'deploy/server', 'build/android', 'submit/ios', 'ota/android']) {
    for (const state of [undefined, 'pending', 'in_progress', 'queued', 'failure', 'error', 'inactive', 'success']) {
      const fake = client({ deployments: [{ id: 9, payload: { key: `production/${operation}`, run: 'older' } }], states: { 9: state } });
      assert.equal(await begin(fake, plan(), operation), 42);
      assert.deepEqual(fake.calls.map(call => call.slice(0, 2)), [['pages', 'deployments?task=expo-release-v3'], ['POST', 'deployments']]);
    }
  }
});

test('same-run duplicate is rejected for every outcome, including a missing acknowledgement', async () => {
  for (const state of [undefined, 'pending', 'in_progress', 'queued', 'failure', 'error', 'inactive', 'success']) {
    const fake = client({ deployments: [{ id: 9, payload: operationPayload(plan(), 'ota/android') }], states: { 9: state } });
    await assert.rejects(begin(fake, plan(), 'ota/android'), /already attempted in this workflow attempt/);
    assert.equal(fake.calls.filter(call => call[0] === 'POST').length, 0);
  }
});

test('immutable evidence precedes success and failure leaves the intent outstanding', async () => {
  const fake = client(); await complete(fake, plan(), 'ota/ios', 77, { id: 'provider' });
  assert.deepEqual(fake.calls.filter(call => ['evidence', 'POST'].includes(call[0])).map(call => call[0]), ['evidence', 'POST']);
  assert.equal(fake.calls.at(-1)[2].auto_inactive, false);
  const failed = client({
    /** Fail evidence retention so success cannot be recorded. */
    failAt: method => method === 'evidence'
  });
  await assert.rejects(complete(failed, plan(), 'ota/ios', 77, {}));
  assert.ok(!failed.calls.some(call => call[0] === 'POST'));
});

test('old profile attempts do not block a fresh run but a same-run profile change cannot duplicate an operation', async () => {
  const fake = client({ deployments: [{ id: 9, payload: { key: 'internal/publish/server', run: 'older' } }] });
  assert.equal(await begin(fake, plan(), 'publish/server'), 42);
  assert.equal(await begin(fake, plan(), 'ota/android'), 43);
  await assert.rejects(begin(fake, plan({ run: 'older' }), 'publish/server'), /identity differs/);
});

test('partial failures consume reservations while fresh mixed releases use only confirmed target baselines', async () => {
  for (const state of [undefined, 'failure', 'pending', 'in_progress', 'queued', 'error', 'inactive']) {
    const old = plan(), input = observation(); input.server = 'server-B'; input.js.android = 'js-B';
    const reservation = { format: 3, source: old.source, run: old.run, versions: { server: '1.2.9', mobile: '1.0.8' }, family: input.family, pairCodeFloor: 24 };
    const failed = ['publish/server', 'deploy/server', 'build/android', 'submit/ios', 'ota/android'].map(operation => ({
      id: 9, payload: { ...operationPayload(old, operation), input: 'unconfirmed', bundleInput: 'unconfirmed' }, state
    }));
    const successful = ['deploy/server', 'build/android', 'build/ios'].map(operation => ({ payload: operationPayload(old, operation), state: 'success' }));
    const history = historyFrom([reservation], [...failed, ...successful]);
    const selection = selectRelease(old.config, old.profile, input, history);
    assert.deepEqual(selection.versions, { server: '1.2.10', mobile: '1.0.9' });
    assert.equal(selection.server, true); assert.equal(selection.native, false); assert.deepEqual(selection.ota, ['android']);
    assert.equal(history.baselines['production/deploy/server'].input, 'server-A');
    assert.equal(history.baselines['production/js/android'].input, 'js-A');
    assert.equal(history.mobile.pairCodeFloor, 24);
    const fake = client({ deployments: failed, states: { 9: state } });
    const next = { ...old, ...selection, run: '124' };
    assert.equal(await begin(fake, next, 'publish/server'), 42);
    assert.equal(await begin(fake, next, 'ota/android'), 43);
    assert.ok(fake.calls.filter(call => call[0] === 'POST').every(call => call[2].payload.run === '124'));
  }
});

test('an interrupted native cutover can rebuild with new versions and paired codes without inventing compatibility', () => {
  const old = plan(); old.config.mobile.pairCodeFloor = 12;
  const history = historyFrom([{ format: 3, source: old.source, run: old.run, versions: old.versions, family: old.observation.family, pairCodeFloor: 14 }], [
    { payload: operationPayload(old, 'build/android'), state: 'pending' },
    { payload: operationPayload(old, 'deploy/server'), state: 'success' }
  ]);
  const result = selectRelease(old.config, old.profile, old.observation, history);
  assert.equal(result.native, true); assert.deepEqual(result.ota, []); assert.equal(result.runtime, '1');
  assert.equal(result.versions.mobile, '1.1.0'); assert.deepEqual(result.pair, [15, 16]); assert.equal(result.server, false);
});

test('legacy records cannot become current baselines or reservations', () => {
  assert.throws(() => historyFrom([{ schemaVersion: 1 }], []), /Legacy/);
  assert.throws(() => historyFrom([], [{ payload: { schemaVersion: 1 }, state: 'success' }]), /Legacy/);
});

test('history reads only the fresh namespace and rejects lightweight reservation tags', async () => {
  const fake = {
    /** Supply empty deployment history; this test exercises reservation validation only. */
    pages: async () => [],
    /** Return a lightweight tag from the current namespace to test annotated-tag enforcement. */
    api: async (_, route) => {
      assert.equal(route, 'git/matching-refs/tags/expo-release/v3/run/'); return [{ object: { type: 'commit' } }];
    }
  };
  await assert.rejects(loadHistory(fake), /annotated/);
});

test('transport never retries writes or interprets permission failure as absence', async () => {
  let requests = 0;
  const api = github('owner/app', { token: 'test',
    /** Count denied requests so permission failures cannot masquerade as empty history or trigger retries. */
    fetcher: async () => { requests++; return { ok: false, status: 403 }; }
  });
  await assert.rejects(api.api('POST', 'deployments', {}), /403/); assert.equal(requests, 1);
  await assert.rejects(api.pages('deployments'), /403/); assert.equal(requests, 2);
});

test('transient GitHub reads retry twice while writes and authorization failures remain single-attempt', async () => {
  for (const failure of ['network', 503, 403]) for (const method of ['GET', 'POST']) {
    let requests = 0; const waits = [];
    const api = github('owner/app', { token: 'test',
      /** Keep retry timing observable without sleeping. */
      wait: async ms => { waits.push(ms); },
      /** Fail transient reads twice; a write must never reach the third request. */
      fetcher: async () => {
        requests++;
        if (requests === 3) return { ok: true, status: 200,
          /** Supply the successful read after transient failures. */
          json: async () => ({ saved: true }) };
        if (failure === 'network') throw new Error('fetch failed');
        return { ok: false, status: failure };
      } });
    if (method === 'GET' && failure !== 403) {
      assert.deepEqual(await api.api(method, 'releases/42'), { saved: true }); assert.deepEqual(waits, [1000, 2000]);
    } else {
      await assert.rejects(api.api(method, 'releases/42'), /GitHub (GET|POST) releases\/42/);
      assert.equal(requests, 1); assert.deepEqual(waits, []);
    }
  }
  let requests = 0;
  const unavailable = github('owner/app', {
    /** Persistent failure must remain bounded. */
    fetcher: async () => { requests++; throw new Error('offline'); },
    /** Avoid real retry delays in the test. */
    wait: async () => {} });
  await assert.rejects(unavailable.api('GET', 'releases/42'), /GitHub GET releases\/42: offline/);
  assert.equal(requests, 3);
});

test('pagination reads beyond the first page and evidence conflicts are errors', async () => {
  const api = github('owner/app', { token: 'test',
    /** Supply two history pages and reject evidence writes to exercise immutable asset conflicts. */
    fetcher: async (url, options) => {
      if (options.method === 'POST') return { ok: false, status: 422 };
      return { ok: true, status: 200,
        /** Fill the first page so the client must fetch the final record from the second. */
        json: async () => url.endsWith('page=1') ? Array(100).fill({}) : [{ id: 101 }]
      };
    }
  });
  assert.equal((await api.pages('deployments')).length, 101);
  await assert.rejects(api.evidence(1, 'plan.json', {}), /422/);
});

test('repeated and interrupted reservations retain the original versions, build and evidence', async () => {
  let fail = true;
  const fake = client({
    /** Interrupt reservation evidence after all tags exist. */
    failAt: (method, route) => method === 'evidence' && route === 'plan.json' && fail });
  const value = plan();
  await assert.rejects(reserve(fake, value), /connection lost/);
  fail = false; await reserve(fake, value); await reserve(fake, value);
  assert.equal(fake.calls.filter(([method, route]) => method === 'POST' && route === 'git/refs').length, 3);
  assert.equal(fake.calls.filter(([method, route]) => method === 'POST' && route === 'releases').length, 1);
  assert.deepEqual(fake.assets.get('plan.json'), value);
  await assert.rejects(reserve(fake, { ...value, build: 'e'.repeat(40) }), /Conflicting/);
});

test('a later explicit attempt can retry unconfirmed work but cannot repeat a confirmed operation', async t => {
  setAttempt(t, '1');
  for (const operation of ['publish/server', 'deploy/server', 'submit/android', 'submit/ios', 'ota/android']) {
    const fake = client(), value = plan(); let requests = 0;
    await assert.rejects(perform(fake, value, operation, () => { requests++; throw new Error('provider unavailable'); }));
    await assert.rejects(perform(fake, value, operation, () => { requests++; }), /already attempted/);
    setAttempt(t, '2');
    await perform(fake, value, operation, () => { requests++; return { id: 'confirmed' }; });
    await perform(fake, value, operation, () => { throw new Error('successful provider request repeated'); });
    assert.equal(requests, 2);
    assert.equal(fake.deployments.length, 2);
    setAttempt(t, '1');
  }
});

test('Android success survives iOS failure and a retry submits only iOS with the same plan', async t => {
  setAttempt(t, '1');
  const fake = client(), value = plan(), requests = [];
  /** Model a real two-platform submission job that stops when the second platform fails. */
  const submit = async fail => {
    for (const platform of ['android', 'ios']) await perform(fake, value, `submit/${platform}`, () => {
      requests.push(platform);
      if (fail && platform === 'ios') throw new Error('iOS credentials');
      return { id: `${platform}-submission`, destination: value.submitProfiles.production[platform] };
    });
  };
  await assert.rejects(submit(true), /iOS credentials/);
  const android = structuredClone(fake.assets.get('submit-android.json'));
  setAttempt(t, '2'); await submit(false);
  assert.deepEqual(requests, ['android', 'ios', 'ios']);
  assert.deepEqual(fake.assets.get('submit-android.json'), android);
  assert.equal(fake.assets.get('submit-ios.json').build, value.build);
  assert.equal(fake.assets.get('submit-ios.json').version, value.versions.mobile);
});

test('provider success retained before a status failure is repaired without another provider request', async () => {
  let fail = true, requests = 0;
  const fake = client({
    /** Lose the status write after successful provider evidence is durable. */
    failAt: (method, route) => method === 'POST' && route.endsWith('/statuses') && fail });
  const value = plan();
  await assert.rejects(perform(fake, value, 'deploy/server', () => { requests++; return { healthy: true }; }), /connection lost/);
  fail = false;
  await perform(fake, value, 'deploy/server', () => { requests++; });
  assert.equal(requests, 1);
  assert.equal(fake.calls.at(-1)[2].state, 'success');
});

test('EAS success followed by a lost GitHub receipt is reconciled on retry without resubmission', async t => {
  const value = plan(), target = value.config.mobile.targets[0]; let fail = true, writes = 0;
  const fake = client({
    /** Lose the GitHub receipt after EAS has finished. */
    failAt: method => method === 'evidence' && fail });
  const record = { id: '12345678-1234-1234-1234-123456789012', status: 'FINISHED', platform: 'ANDROID', app: { id: value.config.mobile.projectId },
    androidConfig: { track: 'internal', releaseStatus: 'COMPLETED' }, submittedBuild: { id: 'provider-id', status: 'FINISHED', app: { id: value.config.mobile.projectId },
      appIdentifier: target.applicationId, platform: 'ANDROID', gitCommitHash: value.build, buildProfile: 'production', appVersion: value.versions.mobile,
      runtime: { version: value.runtime }, updateChannel: { name: 'production' }, fingerprint: { hash: value.observation.fingerprints.production.android } } };
  /** Persist the provider operation independently of GitHub's receipt write. */
  const command = args => {
    if (args[0] === 'submit:list') return writes ? [record] : [];
    if (args[0] === 'submit:view') return record;
    assert.equal(args[0], 'submit'); writes++;
    return `https://expo.dev/accounts/owner/projects/app/submissions/${record.id}`;
  };
  /** Exercise the real worker's operation/adapter boundary without live providers. */
  const attempt = () => perform(fake, value, 'submit/android', () => submit(value, target, { buildId: 'provider-id' }, value.submitProfiles, command));
  setAttempt(t, '1'); await assert.rejects(attempt(), /connection lost/);
  assert.equal(fake.assets.has('submit-android.json'), false);
  fail = false; setAttempt(t, '2'); await attempt(); await attempt();
  assert.equal(writes, 1); assert.equal(fake.assets.get('submit-android.json').result.id, record.id);
  assert.equal(fake.calls.at(-1)[0], 'GET');
});

test('native recording is idempotent when a sibling platform is completed on a later attempt', async () => {
  const fake = client(), value = plan();
  await complete(fake, value, 'build/android', 12, { id: 'android-build', updatedAt: 'earlier' });
  await complete(fake, value, 'build/android', 12, { id: 'android-build', updatedAt: 'later' });
  await complete(fake, value, 'build/ios', 13, { id: 'ios-build' });
  assert.equal(fake.calls.filter(call => call[0] === 'evidence').length, 2);
  assert.equal(fake.calls.filter(call => call[0] === 'POST').length, 2);
  await assert.rejects(complete(fake, value, 'build/android', 12, { id: 'another-build' }), /conflicts/);
});

test('receipt identity, destination or plan tampering never authorizes reuse or another request', async () => {
  const value = plan(), fake = client();
  await perform(fake, value, 'submit/ios', () => ({ id: 'submission' }));
  const saved = fake.assets.get('submit-ios.json');
  for (const changed of [{ run: '124' }, { source: value.build }, { destination: 'other.app' }, { plan: 'wrong' }, { toolkit: 'local' }]) {
    fake.assets.set('submit-ios.json', { ...saved, ...changed });
    await assert.rejects(perform(fake, value, 'submit/ios', () => { throw new Error('provider called'); }), /identity/);
  }
  fake.assets.set('submit-ios.json', saved);
  await assert.rejects(receipt(fake, { ...value, submitProfiles: {} }, 'submit/ios'), /identity/);
  fake.assets.delete('submit-ios.json');
  await assert.rejects(begin(fake, value, 'submit/ios', '2'), /Successful operation is missing/);
});

test('evidence writes reuse identical bytes, reject conflicts and distinguish 404 from denied reads', async () => {
  const saved = { plan: 'immutable' }; let uploads = 0;
  const api = github('owner/app', { token: 'test',
    /** Serve one existing immutable asset and count accidental replacement requests. */
    fetcher: async (url, options) => {
    if (options.method === 'POST') uploads++;
    return { ok: true, status: 200,
      /** Return asset metadata or its original contents. */
      json: async () => url.includes('/assets?') ? [{ id: 9, name: 'plan.json' }] : saved };
  } });
  await api.evidence(42, 'plan.json', saved);
  await assert.rejects(api.evidence(42, 'plan.json', { plan: 'changed' }), /Conflicting/);
  assert.equal(uploads, 0);
  for (const status of [404, 403, 500]) {
    const missing = github('owner/app', {
      /** Simulate absent, forbidden and unavailable GitHub resources independently. */
      fetcher: async () => ({ ok: false, status }) });
    if (status === 404) assert.equal(await missing.api('GET', 'git/ref/missing', undefined, { optional: true }), null);
    else await assert.rejects(missing.api('GET', 'git/ref/missing', undefined, { optional: true }), new RegExp(String(status)));
  }
});
