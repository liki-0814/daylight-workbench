import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchCredits } from '../proxy/qoder/quota.js';

const personal = { unit: 'credits', used: 20, remaining: 80, total: 100 };
const organization = { unit: 'credits', used: 38, remaining: 25962, cap: 26000, available: true };
const expectedOrganization = { id: 'organization', label: '团队资源包', used: 38, remaining: 25962, total: 26000 };
const httpFor = body => ({
  algoUrl: pathname => `https://example.test${pathname}`,
  signedGet: async () => ({ ok: true, json: async () => body }),
});

test('Credits use the signed quota endpoint and hide the empty personal quota for Teams', async () => {
  const session = { fixture: 'test-session' }, startedAt = Date.now();
  const http = httpFor({ usageType: 'credits', userQuota: { unit: 'credits', total: 0, used: 0, remaining: 0 }, orgResourcePackage: organization });
  const get = http.signedGet;
  http.signedGet = async (url, actualSession) => {
    assert.equal(url, 'https://example.test/algo/api/v2/quota/usage');
    assert.equal(actualSession, session);
    return get();
  };
  const result = await fetchCredits(http, session);
  assert.deepEqual(result.buckets, [expectedOrganization]);
  assert.equal(new Date(result.updatedAt).toISOString(), result.updatedAt);
  assert.ok(Date.parse(result.updatedAt) >= startedAt && Date.parse(result.updatedAt) <= Date.now());
});

test('Credits preserve separate personal and organization balances', async () => {
  const result = await fetchCredits(httpFor({ userQuota: personal, orgResourcePackage: organization }), {});
  assert.deepEqual(result.buckets, [
    { id: 'personal', label: '个人额度', used: 20, remaining: 80, total: 100 },
    expectedOrganization,
  ]);
});

test('Credits accept decimal numeric strings and explicit top-level units', async () => {
  const result = await fetchCredits(httpFor({ usageType: 'credits', userQuota: { used: ' 2.5 ', remaining: '97.5', total: '1e2' } }), {});
  assert.deepEqual(result.buckets, [{ id: 'personal', label: '个人额度', used: 2.5, remaining: 97.5, total: 100 }]);
});

test('missing, invalid, or non-credit values never become zero balances', async () => {
  for (const field of ['used', 'remaining', 'total']) {
    for (const value of [undefined, null, '', ' ', false, true, -1, '-1', Infinity, NaN, 'NaN', 'Infinity', '12 credits', '0x10', {}, []]) {
      const result = await fetchCredits(httpFor({ userQuota: { ...personal, [field]: value } }), {});
      assert.deepEqual(result.buckets, [], `${field}: ${String(value)}`);
    }
  }
  for (const body of [null, {}, { userQuota: {} }, { userQuota: { ...personal, unit: undefined } }, { usageType: 'credits', userQuota: { ...personal, unit: 'tokens' } }, { userQuota: { ...personal, unit: null } }]) {
    assert.deepEqual((await fetchCredits(httpFor(body), {})).buckets, []);
  }
  assert.deepEqual((await fetchCredits(httpFor({ orgResourcePackage: { ...organization, cap: undefined } }), {})).buckets, []);
});

test('unavailable organization quota is omitted and a valid zero personal quota remains visible alone', async () => {
  const result = await fetchCredits(httpFor({ userQuota: { ...personal, used: 0, remaining: 0, total: 0 }, orgResourcePackage: { ...organization, available: false } }), {});
  assert.deepEqual(result.buckets, [{ id: 'personal', label: '个人额度', used: 0, remaining: 0, total: 0 }]);
});

test('HTTP, transport, and invalid JSON failures return a safe Chinese 502 error', async () => {
  const secret = 'test-secret-never-return';
  const responses = [
    async () => ({ ok: false, status: 401, text: async () => { assert.fail('must not read error body'); }, json: async () => { assert.fail('must not parse error body'); } }),
    async () => { throw new Error(`Authorization: Bearer ${secret}`); },
    async () => ({ ok: true, json: async () => { throw new SyntaxError(secret); } }),
  ];
  for (const signedGet of responses) {
    await assert.rejects(fetchCredits({ ...httpFor(null), signedGet }, { accessToken: secret }), error => {
      assert.equal(error.status, 502);
      assert.equal(error.message, 'Credits 用量获取失败，请稍后重试');
      assert.equal(`${error.stack}${JSON.stringify(error)}`.includes(secret), false);
      return true;
    });
  }
});

test('Credits history isolates accounts, survives restart and retains bounded hourly snapshots including resets', async () => {
  const { CreditsHistory } = await import('../proxy/qoder/quota.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(`${tmpdir()}/credits-test-`), file = `${dir}/history.json`;
  try {
    const store = new CreditsHistory(file);
    const snapshot = (hour, used) => ({ updatedAt: new Date(Date.UTC(2026,8,1,hour)).toISOString(), buckets: [{ id:'personal',used,remaining:100-used,total:100 }] });
    await store.record('a',snapshot(0,20));
    assert.equal((await store.record('a',snapshot(0,21))).history.length,1);
    assert.equal((await store.record('b',snapshot(1,30))).history.length,1);
    const reset = await new CreditsHistory(file).record('a',snapshot(1,0));
    assert.deepEqual(reset.history.map(row=>row.buckets[0].used),[21,0]);
    const retained = await store.record('a',snapshot(24*31,5));
    assert.equal(retained.history.length,1);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
