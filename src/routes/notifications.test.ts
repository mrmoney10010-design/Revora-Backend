import { createNotificationHandlers } from './notifications';

class MockNotificationRepo {
  notifications: any[] = [];
  marked: string[] = [];
  constructor(rows: any[]) {
    this.notifications = rows;
  }
  async listByUser(userId: string) {
    return this.notifications.filter((n) => n.user_id === userId);
  }
  async markRead(id: string, userId: string) {
    const idx = this.notifications.findIndex((n) => n.id === id && n.user_id === userId);
    if (idx === -1) return false;
    this.notifications[idx].read = true;
    this.marked.push(id);
    return true;
  }
  async markReadBulk(ids: string[], userId: string) {
    let count = 0;
    for (const id of ids) {
      const ok = await this.markRead(id, userId);
      if (ok) count++;
    }
    return count;
  }
}

function makeReq(user: any, params: any = {}, body: any = {}) {
  return { params, body, user } as any;
}

function makeRes() {
  let statusCode = 200;
  let jsonData: any = null;
  return {
    status(code: number) { statusCode = code; return this; },
    json(obj: any) { jsonData = obj; return this; },
    _get() { return { statusCode, jsonData }; }
  } as any;
}

describe('Notifications Route Handlers', () => {
  const rows = [
    { id: 'n1', user_id: 'u1', message: 'm1', read: false, type: 'info', created_at: new Date() },
    { id: 'n2', user_id: 'u1', message: 'm2', read: false, type: 'alert', created_at: new Date() },
    { id: 'n3', user_id: 'u2', message: 'm3', read: false, type: 'info', created_at: new Date() },
  ];

  let repo: MockNotificationRepo;
  let handlers: any;

  beforeEach(() => {
    repo = new MockNotificationRepo(JSON.parse(JSON.stringify(rows)));
    handlers = createNotificationHandlers(repo as any);
  });

  it('lists notifications for user', async () => {
    const req = makeReq({ id: 'u1' });
    const res = makeRes();
    await handlers.getNotifications(req, res, (e: any) => { throw e; });
    const out = res._get();
    expect(out.statusCode).toBe(200);
    expect(out.jsonData.notifications).toHaveLength(2);
  });

  it('marks a single notification as read', async () => {
    const req = makeReq({ id: 'u1' }, { id: 'n1' }, {});
    const res = makeRes();
    await handlers.markRead(req, res, (e: any) => { throw e; });
    const out = res._get();
    expect(out.statusCode).toBe(200);
    expect(out.jsonData.marked).toBe(1);
    expect(repo.notifications.find((n) => n.id === 'n1')!.read).toBe(true);
  });

  it('marks notifications in bulk as read', async () => {
    const req = makeReq({ id: 'u1' }, {}, { ids: ['n2'] });
    const res = makeRes();
    await handlers.markRead(req, res, (e: any) => { throw e; });
    const out = res._get();
    expect(out.statusCode).toBe(200);
    expect(out.jsonData.marked).toBe(1);
  });

  it('returns 401 if unauthenticated', async () => {
    const req = makeReq(null);
    const res = makeRes();
    await handlers.getNotifications(req, res, (e: any) => { throw e; });
    const out = res._get();
    expect(out.statusCode).toBe(401);
  });
});
