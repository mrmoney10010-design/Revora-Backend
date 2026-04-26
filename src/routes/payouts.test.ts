import { createPayoutsHandlers, Payout } from './payouts';

class MockPayoutRepo {
  constructor(private rows: Payout[]) {}
  async listPayoutsByInvestor(investorId: string): Promise<Payout[]> {
    return this.rows.filter((p) => p.investor_id === investorId);
  }
}

function makeReq(user: any, query: any = {}) { return { user, query } as any; }
function makeRes() {
  let statusCode = 200; let jsonData: any = null;
  return {
    status(code: number) { statusCode = code; return this; },
    json(obj: any) { jsonData = obj; return this; },
    _get() { return { statusCode, jsonData }; },
  } as any;
}

function makePayout(overrides: Partial<Payout> = {}): Payout {
  return {
    id: 'pay-1',
    distribution_run_id: 'run-1',
    investor_id: 'inv-1',
    amount: '50.00',
    status: 'processed',
    transaction_hash: '0xabc',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe('Payouts Route Handlers', () => {
  it('lists payouts for authenticated investor', async () => {
    const payouts = [makePayout({ id: 'p1', investor_id: 'inv-1' }), makePayout({ id: 'p2', investor_id: 'inv-2' })];
    const handlers = createPayoutsHandlers(new MockPayoutRepo(payouts) as any);
    const res = makeRes();
    await handlers.listPayouts(makeReq({ id: 'inv-1', role: 'investor' }), res, (e:any)=>{throw e;});
    
    expect(res._get().statusCode).toBe(200);
    expect(res._get().jsonData.payouts).toHaveLength(1);
    expect(res._get().jsonData.payouts[0].id).toBe('p1');
  });

  it('rejects non-investor roles with 403', async () => {
    const handlers = createPayoutsHandlers(new MockPayoutRepo([]) as any);
    const res = makeRes();
    await handlers.listPayouts(makeReq({ id: 's1', role: 'startup' }), res, (e:any)=>{throw e;});
    expect(res._get().statusCode).toBe(403);
  });

  it('rejects unauthenticated requests with 401', async () => {
    const handlers = createPayoutsHandlers(new MockPayoutRepo([]) as any);
    const res = makeRes();
    await handlers.listPayouts(makeReq(null), res, (e:any)=>{throw e;});
    expect(res._get().statusCode).toBe(401);
  });
});
