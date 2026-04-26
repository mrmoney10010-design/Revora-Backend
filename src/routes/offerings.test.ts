import { createOfferingHandlers } from './offerings';

class MockOfferingRepo {
  private rows: any[];
  constructor(rows: any[], private total?: number) { this.rows = rows; }
  async listByIssuer(issuerId: string, opts?: any) {
    // naive filter by status if provided
    let out = this.rows.filter(r => r.issuer_id === issuerId);
    if (opts && opts.status) out = out.filter(r => r.status === opts.status);
    if (opts && typeof opts.offset === 'number') out = out.slice(opts.offset);
    if (opts && typeof opts.limit === 'number') out = out.slice(0, opts.limit);
    return out;
  }
  async countByIssuer(issuerId: string, opts?: any) {
    if (typeof this.total === 'number') return this.total;
    const list = await this.listByIssuer(issuerId, opts);
    return list.length;
  }
  async getById(id: string) {
    return this.rows.find(r => r.id === id) ?? null;
  }
}

function makeReq(user: any, query: any = {}) { return { user, query } as any; }
function makeRes() {
  let statusCode = 200; let jsonData: any = null;
  return {
    status(code: number) { statusCode = code; return this; },
    json(obj: any) { jsonData = obj; return this; },
    _get() { return { statusCode, jsonData }; }
  } as any;
}

describe('Offerings Route Handlers', () => {
  const offers = [
    { id: 'o1', issuer_id: 's1', title: 'A', status: 'draft', amount: '100.00', created_at: new Date() },
    { id: 'o2', issuer_id: 's1', title: 'B', status: 'live', amount: '200.00', created_at: new Date() },
    { id: 'o3', issuer_id: 's2', title: 'C', status: 'live', amount: '300.00', created_at: new Date() },
  ];

  const repo = new MockOfferingRepo(offers);
  const handlers = createOfferingHandlers(repo as any);

  it('lists holdings for authenticated startup', async () => {
    const req = makeReq({ id: 's1', role: 'startup' }, {});
    const res = makeRes();
    await handlers.listOfferings(req, res, (e:any)=>{ throw e; });
    const out = res._get();
    expect(out.statusCode).toBe(200);
    expect(out.jsonData.offerings).toHaveLength(2);
  });

  it('filters list by status', async () => {
    const req = makeReq({ id: 's1', role: 'startup' }, { status: 'live' });
    const res = makeRes();
    await handlers.listOfferings(req, res, (e:any)=>{ throw e; });
    const out = res._get();
    expect(out.jsonData.offerings).toHaveLength(1);
    expect(out.jsonData.offerings[0].id).toBe('o2');
  });

  it('handles pagination limit/offset', async () => {
    const req = makeReq({ id: 's1', role: 'startup' }, { limit: '1', offset: '1' });
    const res = makeRes();
    await handlers.listOfferings(req, res, (e:any)=>{ throw e; });
    const out = res._get();
    expect(out.jsonData.offerings).toHaveLength(1);
  });

  it('returns 401 for unauthorized user', async () => {
    const req = makeReq(null, {});
    const res = makeRes();
    await handlers.listOfferings(req, res, (e:any)=>{ throw e; });
    const out = res._get();
    expect(out.statusCode).toBe(401);
  });

  it('returns 403 for user with wrong role', async () => {
    const req = makeReq({ id: 's1', role: 'investor' }, {});
    const res = makeRes();
    await handlers.listOfferings(req, res, (e:any)=>{ throw e; });
    const out = res._get();
    expect(out.statusCode).toBe(403);
  });
});
