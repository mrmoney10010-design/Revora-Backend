import DistributionEngine from './distributionEngine';

// Mock distributionRepo that records created runs and payouts
class MockDistributionRepo {
  runs: any[] = [];
  payouts: any[] = [];
  async createDistributionRun(input: any) {
    const run = { id: `run-${this.runs.length + 1}`, ...input };
    this.runs.push(run);
    return run;
  }
  async createPayout(input: any) {
    const p = { id: `p-${this.payouts.length + 1}`, ...input };
    this.payouts.push(p);
    return p;
  }
}

// Mock balance provider
class MockBalanceProvider {
  constructor(private rows: any[]) {}
  async getBalances(_offeringId: string, _period: any) {
    return this.rows;
  }
}

describe('DistributionEngine', () => {
  it('performs simple proration correctly', async () => {
    const distRepo = new MockDistributionRepo();
    const balances = [
      { investor_id: 'i1', balance: 70 },
      { investor_id: 'i2', balance: 30 },
    ];
    const engine = new DistributionEngine(null as any, distRepo as any, new MockBalanceProvider(balances) as any);
    const res = await engine.distribute('off-1', { start: new Date(), end: new Date() }, 100);
    
    expect(res.payouts).toHaveLength(2);
    const a1 = res.payouts.find((p) => p.investor_id === 'i1')!;
    const a2 = res.payouts.find((p) => p.investor_id === 'i2')!;
    expect(a1.amount).toBe('70.00');
    expect(a2.amount).toBe('30.00');
  });

  it('handles rounding and ensures total distributed matches revenue', async () => {
    const distRepo = new MockDistributionRepo();
    const balances = [{ investor_id: 'i1', balance: 1 }, { investor_id: 'i2', balance: 1 }, { investor_id: 'i3', balance: 1 }];
    const engine = new DistributionEngine(null as any, distRepo as any, new MockBalanceProvider(balances) as any);
    const res = await engine.distribute('off-2', { start: new Date(), end: new Date() }, 100);
    
    const sum = res.payouts.reduce((s, p) => s + Number(p.amount), 0);
    expect(Math.abs(sum - 100)).toBeLessThan(0.01);
  });

  it('throws error when total balance is zero', async () => {
    const distRepo = new MockDistributionRepo();
    const engine = new DistributionEngine(null as any, distRepo as any, new MockBalanceProvider([{ investor_id: 'i1', balance: 0 }]) as any);
    
    await expect(engine.distribute('off-3', { start: new Date(), end: new Date() }, 50))
      .rejects.toThrow();
  });
});
