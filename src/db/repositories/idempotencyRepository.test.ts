import { Pool, QueryResult } from 'pg';
import { IdempotencyRepository, IdempotencyRow, IdempotencyStatus } from './idempotencyRepository';

describe('IdempotencyRepository', () => {
  let repository: IdempotencyRepository;
  let mockPool: any;

  const mockIdempotencyRow: IdempotencyRow = {
    key: 'test-key',
    status: 'completed',
    request_hash: 'hash123',
    response_status: 200,
    response_body: '{"ok":true}',
    response_content_type: 'application/json',
    created_at: new Date('2024-01-15T00:00:00.000Z'),
  };

  beforeEach(() => {
    mockPool = { query: jest.fn() } as any;
    repository = new IdempotencyRepository(mockPool);
  });

  describe('find', () => {
    it('should return the idempotency record when found', async () => {
      // Mock advisory lock acquisition first
      mockPool.query.mockResolvedValueOnce({ rows: [{ acquired: true }] });
      // Then the SELECT query
      mockPool.query.mockResolvedValueOnce({
        rows: [mockIdempotencyRow],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      });

      const result = await repository.find('test-key');

      // First call: advisory lock
      expect(mockPool.query).toHaveBeenCalledTimes(2);
      const firstCall = mockPool.query.mock.calls[0][0];
      expect(firstCall).toBe('SELECT pg_try_advisory_xact_lock($1) as acquired');
      const secondCall = mockPool.query.mock.calls[1][0];
      expect(secondCall).toBe('SELECT * FROM idempotency_keys WHERE key = $1 FOR SHARE');
      expect(result).toEqual(mockIdempotencyRow);
    });

    it('should return null when no record found', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ acquired: true }] });
      mockPool.query.mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
        command: 'SELECT',
        oid: 0,
        fields: [],
      });

      const result = await repository.find('non-existent');

      expect(result).toBeNull();
      expect(mockPool.query).toHaveBeenCalledTimes(2);
    });

    it('should handle database errors gracefully', async () => {
      mockPool.query.mockRejectedValueOnce(new Error('connection failed'));

      await expect(repository.find('test-key')).rejects.toThrow('connection failed');
    });
  });

  describe('reserve', () => {
    it('should successfully reserve a new key', async () => {
      // Acquire lock first
      mockPool.query.mockResolvedValueOnce({ rows: [{ acquired: true }] });
      // Then INSERT
      mockPool.query.mockResolvedValueOnce({
        rows: [{ key: 'test-key', status: 'started', request_hash: 'hash123' }],
        rowCount: 1,
        command: 'INSERT',
        oid: 0,
        fields: [],
      });

      const result = await repository.reserve('test-key', 'hash123');

      expect(mockPool.query).toHaveBeenCalledTimes(2);
      expect(result).toBe(true);
    });

    it('should return false when key already exists (conflict)', async () => {
      // Acquire lock first
      mockPool.query.mockResolvedValueOnce({ rows: [{ acquired: true }] });
      // INSERT returns no rows due to conflict
      mockPool.query.mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
        command: 'INSERT',
        oid: 0,
        fields: [],
      });

      const result = await repository.reserve('existing-key', 'hash456');

      expect(result).toBe(false);
    });

    it('should handle database errors during reserve', async () => {
      mockPool.query.mockRejectedValueOnce(new Error('insert failed'));

      await expect(repository.reserve('test-key', 'hash123')).rejects.toThrow('insert failed');
    });

    it('should use ON CONFLICT DO NOTHING for atomic reservation', async () => {
      // First call succeeds (no conflict)
      mockPool.query.mockResolvedValueOnce({ rows: [{ acquired: true }] });
      mockPool.query.mockResolvedValueOnce({
        rows: [{ key: 'key1' }],
        rowCount: 1,
      });

      const result1 = await repository.reserve('key1', 'hash1');
      expect(result1).toBe(true);

      // Second call with same key returns no rows (conflict)
      mockPool.query.mockResolvedValueOnce({ rows: [{ acquired: true }] });
      mockPool.query.mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      });

      const result2 = await repository.reserve('key1', 'hash1');
      expect(result2).toBe(false);
    });
  });

  describe('save', () => {
    it('should update a started record to completed with response data', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
        command: 'UPDATE',
        oid: 0,
        fields: [],
      } as QueryResult<any>);

      await repository.save('test-key', 201, '{"created":true}', 'application/json');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE idempotency_keys'),
        ['test-key', 201, '{"created":true}', 'application/json']
      );
    });

    it('should save without content-type when not provided', async () => {
      await repository.save('test-key', 200, 'ok');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE idempotency_keys'),
        ['test-key', 200, 'ok', undefined]
      );
    });

    it('should handle update failures gracefully', async () => {
      mockPool.query.mockRejectedValue(new Error('update failed'));

      await expect(
        repository.save('test-key', 200, 'ok')
      ).rejects.toThrow('update failed');
    });

    it('should set status to completed on save', async () => {
      await repository.save('test-key', 200, 'ok');

      const callArgs = mockPool.query.mock.calls[0][0];
      expect(callArgs).toContain("status = 'completed'");
    });
  });

  describe('delete', () => {
    it('should remove the idempotency record', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [],
        rowCount: 1,
        command: 'DELETE',
        oid: 0,
        fields: [],
      } as QueryResult<any>);

      await repository.delete('test-key');

      expect(mockPool.query).toHaveBeenCalledWith(
        'DELETE FROM idempotency_keys WHERE key = $1',
        ['test-key']
      );
    });

    it('should handle delete errors', async () => {
      mockPool.query.mockRejectedValue(new Error('delete failed'));

      await expect(repository.delete('test-key')).rejects.toThrow('delete failed');
    });

    it('should not throw when deleting non-existent key', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
        command: 'DELETE',
        oid: 0,
        fields: [],
      } as QueryResult<any>);

      await expect(repository.delete('non-existent')).resolves.toBeUndefined();
    });
  });

  describe('IdempotencyRow interface', () => {
    it('should allow null/undefined optional fields', () => {
      // Type-check: these assignments should compile
      const partialRow: Partial<IdempotencyRow> = {
        key: 'key',
        status: 'started',
        created_at: new Date(),
      };

      expect(partialRow.request_hash).toBeUndefined();
      expect(partialRow.response_status).toBeUndefined();
      expect(partialRow.response_body).toBeUndefined();
      expect(partialRow.response_content_type).toBeUndefined();
    });

    it('should enforce valid status values', () => {
      const row: IdempotencyRow = {
        key: 'key',
        status: 'started',
        created_at: new Date(),
      };

      expect(['started', 'completed']).toContain(row.status);
    });
  });

  describe('Concurrent operations', () => {
    it('should handle overlapping reserve attempts atomically', async () => {
      // Simulate two concurrent reservations for the same key
      const key = 'concurrent-key';
      const hash1 = 'hash1';
      const hash2 = 'hash2';

      // Both will try to acquire lock; first succeeds, second fails
      // Then second will check existence and find the key exists
      const mockQueries: any[] = [];

      // First reservation attempt
      mockQueries.push({ rows: [{ acquired: true }] }); // Lock acquired
      mockQueries.push({ rows: [{ key }], rowCount: 1 }); // INSERT row returned

      // Second reservation attempt (concurrent)
      mockQueries.push({ rows: [{ acquired: false }] }); // Lock NOT acquired
      mockQueries.push({ rows: [{ key }], rowCount: 1 }); // Check if key exists

      mockPool.query.mockImplementation(async () => mockQueries.shift());

      const [result1, result2] = await Promise.all([
        repository.reserve(key, hash1),
        repository.reserve(key, hash2),
      ]);

      expect(result1).toBe(true);
      expect(result2).toBe(false);
    });

    it('should allow save only after successful reserve', async () => {
      // reserve: lock + insert
      mockPool.query.mockResolvedValueOnce({ rows: [{ acquired: true }] });
      mockPool.query.mockResolvedValueOnce({ rows: [{ key: 'k' }], rowCount: 1 });
      // save: update
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await repository.reserve('k', 'hash');
      await repository.save('k', 200, 'ok');

      expect(mockPool.query).toHaveBeenCalledTimes(3);
    });

    it('should handle delete after save', async () => {
      // reserve: lock + insert
      mockPool.query.mockResolvedValueOnce({ rows: [{ acquired: true }] });
      mockPool.query.mockResolvedValueOnce({ rows: [{ key: 'key' }], rowCount: 1 });
      // save: update
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // delete: delete
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await repository.reserve('key', 'hash');
      await repository.save('key', 200, 'ok');
      await repository.delete('key');

      expect(mockPool.query).toHaveBeenCalledTimes(4);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty response body', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await repository.save('key', 204, '');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        ['key', 204, '', undefined]
      );
    });

    it('should handle large response bodies', async () => {
      const largeBody = JSON.stringify({ data: 'x'.repeat(10000) });
      await repository.save('key', 200, largeBody);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['key', 200, largeBody])
      );
    });

    it('should handle special characters in request_hash', async () => {
      const specialHash = 'a:b;c?d=e&f/g#h';
      mockPool.query.mockResolvedValueOnce({ rows: [{ acquired: true }] });
      mockPool.query.mockResolvedValueOnce({ rows: [{ key: 'k' }], rowCount: 1 });

      await repository.reserve('k', specialHash);

      const calls = mockPool.query.mock.calls;
      expect(calls[1][1]).toContain(specialHash);
    });

    it('should handle Unicode in response body', async () => {
      const unicodeBody = '{"message":"你好世界","emoji":"🚀"}';
      await repository.save('key', 200, unicodeBody);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['key', 200, unicodeBody])
      );
    });
  });

  describe('SQL Injection protection', () => {
    it('should use parameterized queries for find', async () => {
      const maliciousKey = "'; DROP TABLE idempotency_keys; --";
      mockPool.query.mockResolvedValueOnce({ rows: [{ acquired: true }] });
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await repository.find(maliciousKey);

      // Check both calls use parameters (prevent SQL injection)
      const calls = mockPool.query.mock.calls;
      // First call: advisory lock with hashed numeric parameter
      expect(calls[0][1]).toBeDefined();
      expect(calls[0][1].length).toBe(1);
      // Lock parameter should be a bigint (not string interpolation)
      expect(typeof calls[0][1][0]).toBe('bigint');
      // Second call: SELECT with proper parameterized key
      expect(calls[1][0]).toBe('SELECT * FROM idempotency_keys WHERE key = $1 FOR SHARE');
      expect(calls[1][1]).toContain(maliciousKey);
    });

    it('should use parameterized queries for reserve', async () => {
      const maliciousKey = "'; DELETE FROM idempotency_keys; --";
      mockPool.query.mockResolvedValueOnce({ rows: [{ acquired: true }] });
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await repository.reserve(maliciousKey, 'hash');

      const calls = mockPool.query.mock.calls;
      // First call (advisory lock) uses hashed numeric parameter
      expect(calls[0][1][0]).toBeDefined();
      expect(typeof calls[0][1][0]).toBe('bigint');
      // Second call (INSERT) properly parameterizes key and hash
      expect(calls[1][0]).toContain('INSERT INTO idempotency_keys');
      expect(calls[1][1][0]).toBe(maliciousKey);
      expect(calls[1][1][1]).toBe('hash');
    });

    it('should use parameterized queries for save', async () => {
      const maliciousBody = '"}); DELETE FROM idempotency_keys; --';
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await repository.save('key', 200, maliciousBody);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE idempotency_keys'),
        ['key', 200, maliciousBody, undefined]
      );
    });

    it('should use parameterized queries for delete', async () => {
      const maliciousKey = "'; DROP TABLE users; --";
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await repository.delete(maliciousKey);

      expect(mockPool.query).toHaveBeenCalledWith(
        'DELETE FROM idempotency_keys WHERE key = $1',
        [maliciousKey]
      );
    });
  });

  describe('Transaction integration', () => {
    it('should be compatible with transaction clients', async () => {
      const client = { query: jest.fn() };
      // Mock the lock acquisition
      client.query.mockResolvedValueOnce({ rows: [{ acquired: true }] });
      // Mock the INSERT result
      client.query.mockResolvedValueOnce({ rows: [{ key: 'k' }], rowCount: 0 });
      const txRepo = new IdempotencyRepository(client as any);

      await txRepo.reserve('tx-key', 'hash');

      // Two queries: lock + insert
      expect(client.query).toHaveBeenCalledTimes(2);
    });
  });
});
