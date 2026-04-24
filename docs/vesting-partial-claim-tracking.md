# Vesting Partial Claim Tracking

## Overview
This document describes the mechanism for tracking partial claims in the vesting contract to ensure consistency and prevent math breakage.

## Partial Claim Ledger
Each beneficiary has an append-only ledger of partial claims stored as a vector of `PartialClaim` structs.

The ledger is not the source of truth by itself. It is an audit trail that mirrors the authoritative cursor stored on the vesting schedule, so future claims can be checked against both the current state and the recorded history.

### PartialClaim Struct
- amount: i128 - The amount claimed in this partial claim
- timestamp: u64 - The timestamp of the claim
- total_claimed: i128 - The cumulative cursor after this claim is applied

### Cursor / Ledger Relationship
- `VestingSchedule.claimed` is the authoritative cursor for how much has already been released.
- The `PartialClaim` vector is the audit ledger for the same beneficiary.
- Each new ledger entry stores the claim amount and the post-claim cursor in `total_claimed`.
- Before appending a new claim, the contract reconciles the last ledger entry against `VestingSchedule.claimed`.
- If the cursor and ledger disagree, the claim fails explicitly instead of silently mutating balances.
- The claim path also rejects invalid schedule cursors and arithmetic overflow before state is updated, so partial draws cannot create hidden drift.

## Invariants
- `0 <= claimed <= total_amount`
- `sum(ledger.amount) == VestingSchedule.claimed`
- `ledger.last().total_claimed == VestingSchedule.claimed`
- Claims only increase the cursor
- Claims before the cliff or above the vested amount fail explicitly
- Zero or negative claim amounts fail explicitly
- A zero-duration vesting schedule is safe and cannot divide by zero
- Linear vesting math uses checked multiplication, so oversized schedules fail loudly instead of wrapping.

## Security Notes
- Partial claims reduce settlement risk, but the contract still enforces the same invariant as a full claim: no claim can exceed vested balance.
- The cursor/ledger check prevents "dust loss" style accounting drift and makes mismatches fail loudly.
- Invalid cursor bounds and vesting arithmetic overflow are treated as hard failures, which is safer for investor-facing accounting than trying to recover silently.
- Vesting schedule creation is admin-gated; claims are beneficiary-gated.
- Claims are authorized by the beneficiary before state changes are accepted.
- Event payloads remain on schema version 1.0 and are documented in `vesting-event-schema-versioning.md`.
- Ledger changes do not change the event schema, so no version bump is required unless the event fields themselves change.
