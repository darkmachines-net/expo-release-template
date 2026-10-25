/** @file Fresh releases survive prior failures while reservations, successful baselines and same-run duplicate guards remain intact. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { github, historyFrom, reserve, begin, complete, operationPayload, loadHistory } from '../src/github.mjs';
import { selectRelease } from '../src/engine.mjs';
import { plan, observation } from './helpers.mjs';

/** Deterministic GitHub API stand-in which records ordering without networking. */
function client({ deployments = [], states = {}, failAt } = {}) {
  const calls = [];
  return { calls,
    /** Return the supplied deployment history and record the requested list route. */
    async pages(route) { calls.push(['pages', route]); return deployments; },
    /** Return deterministic IDs/statuses or inject a lost connection at the selected write. */
    async api(method, route, body) {
      calls.push([method, route, body]);
      if (failAt?.(method, route)) throw new Error('connection lost');
      if (route.includes('/statuses?')) return states[route.split('/')[1]] === undefined ? [] : [{ state: states[route.split('/')[1]] }];
      if (route === 'git/tags') return { sha: 'd'.repeat(40) };
      return { id: 42 };
    },
    /** Capture evidence ordering and optionally simulate an upload with unknown outcome. */
    async evidence(id, name, body) { calls.push(['evidence', id, name, body]); if (failAt?.('evidence', name)) throw new Error('connection lost'); }
  };
}

test('reservation writes immutable annotated tags before evidence', async () => {
  const fake = client(), value = plan(); await reserve(fake, value);
  const refs = fake.calls.filter(([method, route]) => method === 'POST' && route === 'git/refs');
  assert.deepEqual(refs.map(call => call[2].ref), [
    'refs/tags/expo-release/v3/run/123', 'refs/tags/expo-release/v3/mobile/v1.0.0', 'refs/tags/expo-release/v3/server/v1.2.4'
  ]);
  assert.equal(fake.calls.at(-1)[0], 'evidence'); assert.equal(fake.calls.at(-1)[2], 'plan.json');
  assert.equal(fake.calls.filter(call => call[0] === 'PATCH').length, 0);
  const tag = JSON.parse(fake.calls[0][2].message);
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
    const fake = client({ deployments: [{ id: 9, payload: { key: 'production/ota/android', run: '123' } }], states: { 9: state } });
    await assert.rejects(begin(fake, plan(), 'ota/android'), /already attempted in this run/);
    assert.equal(fake.calls.filter(call => call[0] === 'POST').length, 0);
  }
});

test('immutable evidence precedes success and failure leaves the intent outstanding', async () => {
  const fake = client(); await complete(fake, plan(), 'ota/ios', 77, { id: 'provider' });
  assert.deepEqual(fake.calls.map(call => call[0]), ['GET', 'evidence', 'POST']);
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
  assert.equal(await begin(fake, plan(), 'ota/android'), 42);
  await assert.rejects(begin(fake, plan({ run: 'older' }), 'publish/server'), /already attempted in this run/);
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
    assert.equal(await begin(fake, next, 'ota/android'), 42);
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
