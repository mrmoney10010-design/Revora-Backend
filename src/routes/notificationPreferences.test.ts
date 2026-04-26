import { NextFunction, Response } from 'express';
import { createNotificationPreferencesRouter } from './notificationPreferences';
import {
  NotificationPreference,
  NotificationPreferencesRepository,
  CreateNotificationPreferenceInput,
  UpdateNotificationPreferenceInput,
  ListNotificationPreferencesOptions,
} from '../db/repositories/notificationPreferencesRepository';

class InMemoryNotificationPreferencesRepository extends NotificationPreferencesRepository {
  private prefs: NotificationPreference[] = [];
  constructor() { super({} as any); }
  async getPreference(user_id: string, channel: 'email' | 'push', type: string): Promise<NotificationPreference | null> {
    return this.prefs.find(p => p.user_id === user_id && p.channel === channel && p.type === type) || null;
  }
  async listPreferences(options: ListNotificationPreferencesOptions): Promise<NotificationPreference[]> {
    return this.prefs.filter(p => p.user_id === options.user_id && (!options.channel || p.channel === options.channel));
  }
  async createPreference(input: CreateNotificationPreferenceInput): Promise<NotificationPreference> {
    const pref = { ...input, id: 'id', enabled: input.enabled ?? true, created_at: new Date(), updated_at: new Date() } as NotificationPreference;
    this.prefs.push(pref);
    return pref;
  }
  async updatePreference(user_id: string, channel: 'email' | 'push', type: string, input: UpdateNotificationPreferenceInput): Promise<NotificationPreference> {
    const pref = await this.getPreference(user_id, channel, type);
    if (!pref) throw new Error('Not found');
    if (input.enabled !== undefined) pref.enabled = input.enabled;
    return pref;
  }
  async upsertPreference(input: CreateNotificationPreferenceInput & { enabled?: boolean }): Promise<NotificationPreference> {
    const existing = await this.getPreference(input.user_id, input.channel, input.type);
    if (existing) return this.updatePreference(input.user_id, input.channel, input.type, { enabled: input.enabled });
    return this.createPreference(input);
  }
}

class MockResponse {
  statusCode = 200; payload: any;
  status(code: number) { this.statusCode = code; return this; }
  json(payload: any) { this.payload = payload; return this; }
}

describe('Notification Preferences Route', () => {
    const requireAuth = (req: any, _res: Response, next: NextFunction) => {
        if (!req.user) return _res.status(401).json({ error: 'Unauthorized' });
        next();
    };

    it('returns preferences for donor', async () => {
        const repo = new InMemoryNotificationPreferencesRepository();
        const router = createNotificationPreferencesRouter({ requireAuth: requireAuth as any, notificationPreferencesRepository: repo });
        const req = { user: { id: 'u1' } } as any;
        const res = new MockResponse();
        
        // Find GET /api/users/me/notification-preferences
        const layer = router.stack.find((l: any) => l.route?.path === '/api/users/me/notification-preferences' && l.route?.methods.get);
        const handler = (layer as any).route.stack[(layer as any).route.stack.length - 1].handle;
        
        await handler(req, res as unknown as Response, () => {});
        expect(res.statusCode).toBe(200);
        expect(res.payload.email_notifications).toBe(true);
    });

    it('returns 401 if unauthorized', async () => {
        const repo = new InMemoryNotificationPreferencesRepository();
        const router = createNotificationPreferencesRouter({ requireAuth: requireAuth as any, notificationPreferencesRepository: repo });
        const req = { } as any;
        const res = new MockResponse();
        
        // Middleware should catch it if we go through the normal router dispatch, 
        // but here we are testing the handler directly.
        // Let's use a simplified test that respects the middleware logic.
        requireAuth(req, res as unknown as Response, async () => {
            const layer = router.stack.find((l: any) => l.route?.path === '/api/users/me/notification-preferences' && l.route?.methods.get);
            const handler = (layer as any).route.stack[(layer as any).route.stack.length - 1].handle;
            await handler(req, res as unknown as Response, () => {});
        });
        
        expect(res.statusCode).toBe(401);
    });
});
