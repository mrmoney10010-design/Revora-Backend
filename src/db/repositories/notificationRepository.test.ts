import { NotificationRepository } from './notificationRepository';

class MockPool {
  constructor(private rows: any[] = [], private rowCount = 1) {}
  async query(_text: string, _values?: any[]) {
    return { rows: this.rows, rowCount: this.rowCount };
  }
}

describe('NotificationRepository', () => {
  const sampleNotification = {
    id: 'n1',
    user_id: 'u1',
    type: 'info',
    title: 'Test Notification',
    body: 'This is a test notification',
    read_at: null,
    created_at: new Date(),
  };

  it('creates a notification', async () => {
    const createRepo = new NotificationRepository(new MockPool([sampleNotification]) as any);
    const created = await createRepo.create({
      user_id: 'u1',
      type: 'info',
      title: 'Test Notification',
      body: 'This is a test notification',
    });
    expect(created.title).toBe('Test Notification');
    expect(created.user_id).toBe('u1');
  });

  it('lists notifications by user', async () => {
    const listRepo = new NotificationRepository(new MockPool([sampleNotification, { ...sampleNotification, id: 'n2' }]) as any);
    const notifications = await listRepo.listByUser('u1');
    expect(notifications).toHaveLength(2);
    expect(notifications[0].user_id).toBe('u1');
  });

  it('marks a notification as read', async () => {
    const readNotification = { ...sampleNotification, read_at: new Date() };
    const markReadRepo = new NotificationRepository(new MockPool([readNotification]) as any);
    const marked = await markReadRepo.markRead('n1');
    expect(marked.read_at).not.toBeNull();
    expect(marked.id).toBe('n1');
  });
});
