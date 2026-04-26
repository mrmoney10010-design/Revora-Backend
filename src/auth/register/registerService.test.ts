import { createHash } from 'node:crypto';
import { RegisterService, DuplicateEmailError } from './registerService';
import { IUserRepository, RegisteredUser } from './types';

class FakeUserRepository implements IUserRepository {
  private users: Map<string, RegisteredUser & { password_hash: string }> = new Map();

  async findByEmail(email: string) {
    return this.users.get(email) ?? null;
  }

  async createUser(input: { email: string; password_hash: string; role: 'investor' }): Promise<RegisteredUser> {
    const user: RegisteredUser & { password_hash: string } = {
      id: `user-${this.users.size + 1}`,
      email: input.email,
      role: input.role,
      password_hash: input.password_hash,
      created_at: new Date(),
    };
    this.users.set(input.email, user);
    return user;
  }

  getStoredHash(email: string): string | undefined {
    return this.users.get(email)?.password_hash;
  }
}

describe('RegisterService', () => {
  it('creates investor with hashed password and normalized email', async () => {
    const repo = new FakeUserRepository();
    const svc = new RegisterService(repo);
    const user = await svc.register('Alice@Example.COM', 'secret123');

    expect(user.id).toBeDefined();
    expect(user.email).toBe('alice@example.com');
    expect(user.role).toBe('investor');

    const expectedHash = createHash('sha256').update('secret123').digest('hex');
    expect(repo.getStoredHash('alice@example.com')).toBe(expectedHash);
  });

  it('normalizes email by trimming whitespace', async () => {
    const repo = new FakeUserRepository();
    const svc = new RegisterService(repo);
    const user = await svc.register('  bob@example.com  ', 'password1');
    expect(user.email).toBe('bob@example.com');
  });

  it('throws DuplicateEmailError when email is already registered', async () => {
    const repo = new FakeUserRepository();
    const svc = new RegisterService(repo);
    await svc.register('carol@example.com', 'password1');

    await expect(svc.register('carol@example.com', 'different-password'))
      .rejects.toThrow(DuplicateEmailError);
  });

  it('handles case-insensitive duplicate emails', async () => {
    const repo = new FakeUserRepository();
    const svc = new RegisterService(repo);
    await svc.register('Dave@Example.com', 'password1');

    await expect(svc.register('dave@example.com', 'password2'))
      .rejects.toThrow(DuplicateEmailError);
  });

  it('allows different users to register independently', async () => {
    const repo = new FakeUserRepository();
    const svc = new RegisterService(repo);
    const u1 = await svc.register('eve@example.com', 'password-eve');
    const u2 = await svc.register('frank@example.com', 'password-frank');

    expect(u1.id).not.toBe(u2.id);
    expect(u1.role).toBe('investor');
    expect(u2.role).toBe('investor');
  });

  it('propagates repository errors', async () => {
    const failRepo: IUserRepository = {
      async findByEmail() { return null; },
      async createUser() { throw new Error('DB connection lost'); },
    };
    const svc = new RegisterService(failRepo);
    await expect(svc.register('grace@example.com', 'password1'))
      .rejects.toThrow('DB connection lost');
  });
});
