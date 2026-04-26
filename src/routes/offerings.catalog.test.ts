import { createPublicHandlers } from './offerings';

class MockOfferingRepo {
  private rows: any[];
  private total?: number;
  constructor(rows: any[], total?: number) { this.rows = rows; this.total = total; }
  async listPublic(opts: any) {
    let out = this.rows.slice();
    if (opts && opts.status) out = out.filter(r => r.status === opts.status);
    if (opts && typeof opts.sort === 'string') {
      if (opts.sort === 'created_at') out = out.sort((a,b)=> new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      if (opts.sort === 'revenue_share_bps') out = out.sort((a,b)=> (b.revenue_share_bps||0) - (a.revenue_share_bps||0));
    }
    if (typeof opts.offset === 'number') out = out.slice(opts.offset);
    if (typeof opts.limit === 'number') out = out.slice(0, opts.limit);
    // Return only public/safe fields
    return out.map(r => ({ id: r.id, title: r.title, status: r.status, amount: r.amount, created_at: r.created_at }));
  }
  async countPublic(opts: any) { return typeof this.total === 'number' ? this.total : (await this.listPublic(opts)).length; }
  async getById(id: string) {
    return this.rows.find(r => r.id === id) ?? null;
  }
}

function makeReq(query: any = {}, params: any = {}, user: any = undefined) { return { query, params, user } as any; }
function makeRes() { let statusCode=200; let jsonData:any=null; return { status(code:number){statusCode=code;return this}, json(obj:any){jsonData=obj;return this}, _get(){return {statusCode,jsonData}} } as any; }

describe('Offerings Catalog Route Handlers', () => {
  const rows = [
    { id:'11111111-1111-4111-8111-111111111111', title:'A', issuer_id:'s1', status:'active', amount:'100.00', created_at:new Date(), revenue_share_bps:500, private_note: 'issuer-only' },
    { id:'22222222-2222-4222-8222-222222222222', title:'B', issuer_id:'s2', status:'draft', amount:'200.00', created_at:new Date(Date.now()-10000), revenue_share_bps:300 },
    { id:'33333333-3333-4333-8333-333333333333', title:'C', issuer_id:'s3', status:'active', amount:'300.00', created_at:new Date(Date.now()-20000), revenue_share_bps:700 },
  ];

  const repo = new MockOfferingRepo(rows);
  const handlers = createPublicHandlers(repo as any);

  it('lists active offerings', async () => {
    const req = makeReq({ status: 'active' });
    const res = makeRes();
    await handlers.listCatalog(req, res, (e:any)=>{ throw e });
    const out = res._get();
    expect(out.statusCode).toBe(200);
    expect(out.jsonData.offerings).toHaveLength(2);
  });

  it('handles pagination and sorting', async () => {
    const req = makeReq({ status: 'active', limit: '1', offset: '0', sort: 'revenue_share_bps' });
    const res = makeRes();
    await handlers.listCatalog(req, res, (e:any)=>{ throw e });
    const out = res._get();
    expect(out.jsonData.offerings).toHaveLength(1);
    // Ensure fields are public only
    expect(out.jsonData.offerings[0]).not.toHaveProperty('issuer_id');
  });

  it('getById returns public shape for investor/public', async () => {
    const req = makeReq({}, { id: '11111111-1111-4111-8111-111111111111' });
    const res = makeRes();
    await handlers.getOfferingById(req, res, (e:any)=>{ throw e });
    const out = res._get();
    expect(out.statusCode).toBe(200);
    expect(out.jsonData.id).toBe('11111111-1111-4111-8111-111111111111');
    expect(out.jsonData).not.toHaveProperty('issuer_id');
    expect(out.jsonData).not.toHaveProperty('private_note');
  });

  it('getById returns full detail for issuer', async () => {
    const req = makeReq({}, { id: '11111111-1111-4111-8111-111111111111' }, { id: 's1', role: 'issuer' });
    const res = makeRes();
    await handlers.getOfferingById(req, res, (e:any)=>{ throw e });
    const out = res._get();
    expect(out.statusCode).toBe(200);
    expect(out.jsonData.issuer_id).toBe('s1');
    expect(out.jsonData.private_note).toBe('issuer-only');
  });

  it('returns 404 for missing offering', async () => {
    const req = makeReq({}, { id: '44444444-4444-4444-8444-444444444444' });
    const res = makeRes();
    await handlers.getOfferingById(req, res, (e:any)=>{ throw e });
    const out = res._get();
    expect(out.statusCode).toBe(404);
  });

  it('returns 400 for invalid id format', async () => {
    const req = makeReq({}, { id: 'not-a-uuid' });
    const res = makeRes();
    await handlers.getOfferingById(req, res, (e:any)=>{ throw e });
    const out = res._get();
    expect(out.statusCode).toBe(400);
  });
});
