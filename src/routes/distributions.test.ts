import { createDistributionHandlers } from './distributions';

class MockEngine {
  lastArgs: any = null;
  async distribute(offeringId: string, period: any, revenueAmount: number) {
    this.lastArgs = { offeringId, period, revenueAmount };
    return { distributionRun: { id: 'run-1', offering_id: offeringId }, payouts: [{ investor_id: 'i1', amount: '50.00' }] };
  }
}

class MockOfferingRepo {
  constructor(private rows: any) {}
  async getById(id: string) { return this.rows[id] ?? null; }
}

function makeReq(user: any, params: any = {}, body: any = {}) { return { user, params, body } as any; }
function makeRes() { let statusCode = 200; let jsonData: any = null; return { status(code: number) { statusCode = code; return this; }, json(obj: any) { jsonData = obj; return this; }, _get() { return { statusCode, jsonData }; } } as any; }

describe('Distributions Route Handlers', () => {
  const engine = new MockEngine();
  const offeringRows: any = { off1: { id: 'off1', issuer_id: 's1' } };
  const repo = new MockOfferingRepo(offeringRows);
  const handlers = createDistributionHandlers(engine as any, repo as any);

  it('allows admin to trigger distribution', async () => {
    const req = makeReq({ id: 'admin1', role: 'admin' }, { id: 'off1' }, { revenue_amount: 100, period: { start: new Date().toISOString(), end: new Date().toISOString() } });
    const res = makeRes();
    await handlers.triggerDistribution(req, res, (e: any) => { throw e; });
    const out = res._get();
    expect(out.statusCode).toBe(200);
    expect(out.jsonData.run_id).toBe('run-1');
  });

  it('allows startup owner to trigger distribution', async () => {
    const req = makeReq({ id: 's1', role: 'startup' }, { id: 'off1' }, { revenue_amount: 200, period: { start: new Date().toISOString(), end: new Date().toISOString() } });
    const res = makeRes();
    await handlers.triggerDistribution(req, res, (e: any) => { throw e; });
    const out = res._get();
    expect(out.statusCode).toBe(200);
  });

  it('forbids startup that is not the owner', async () => {
    const req = makeReq({ id: 's2', role: 'startup' }, { id: 'off1' }, { revenue_amount: 50, period: { start: new Date().toISOString(), end: new Date().toISOString() } });
    const res = makeRes();
    await handlers.triggerDistribution(req, res, (e: any) => { throw e; });
    const out = res._get();
    expect(out.statusCode).toBe(403);
  });

  it('returns 401 for unauthenticated request', async () => {
    const req = makeReq(null, { id: 'off1' }, { revenue_amount: 10, period: { start: new Date().toISOString(), end: new Date().toISOString() } });
    const res = makeRes();
    await handlers.triggerDistribution(req, res, (e: any) => { throw e; });
    const out = res._get();
    expect(out.statusCode).toBe(401);
  });

  it('returns 400 for bad input', async () => {
    const req = makeReq({ id: 'admin1', role: 'admin' }, { id: 'off1' }, { period: { start: new Date().toISOString() } });
    const res = makeRes();
    await handlers.triggerDistribution(req, res, (e: any) => { throw e; });
    const out = res._get();
    expect(out.statusCode).toBe(400);
  });
});
