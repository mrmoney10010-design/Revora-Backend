# Vesting Event Schema Versioning

## Overview
This document defines the schema versioning for vesting-related events in the Revora Contracts.

## Current Schema Version
**Version: 1.0**

This version matches the current `VestingCreatedEvent` and `PartialClaimEvent` payloads in `src/vesting.rs`.
Ledger-only changes such as claim cursor hardening do not require a schema bump because they do not alter the emitted event fields or their serialized shape.

## Event Types

### VestingCreated
- **Version:** 1.0
- **Fields:**
  - beneficiary: Address
  - total_amount: i128
  - start_time: u64
  - cliff_time: u64
  - end_time: u64
  - timestamp: u64

### PartialClaim
- **Version:** 1.0
- **Fields:**
  - beneficiary: Address
  - amount: i128
  - timestamp: u64
  - total_claimed: i128

## Version History
- **1.0:** Initial schema for vesting events and partial claims. Still current after partial-claim ledger hardening because the event payloads are unchanged.
