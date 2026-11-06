/**
 * seed/seed.ts
 *
 * Idempotent seed script for development data.
 * Uses upsert / findOneOrCreate patterns — safe to run repeatedly.
 *
 * Credentials are read from environment variables.
 * NEVER hardcode real passwords in source files.
 *
 * Run: npm run seed --workspace=server
 *      (requires server/.env to be configured)
 *
 * Demo RFQ data matches the client-provided sample exactly.
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { User } from '../models/User';
import { RFQ } from '../models/RFQ';
import { Part } from '../models/Part';
import { MaterialRate } from '../models/MaterialRate';
import { MachineRate } from '../models/MachineRate';
import { RateSetting } from '../models/RateSetting';

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('[seed] MONGODB_URI is not set. Copy server/.env.example to server/.env.');
  process.exit(1);
}

const ESTIMATOR_PASSWORD = process.env.SEED_ESTIMATOR_PASSWORD;
const SALES_PASSWORD = process.env.SEED_SALES_PASSWORD;
if (!ESTIMATOR_PASSWORD || !SALES_PASSWORD) {
  console.error('[seed] SEED_ESTIMATOR_PASSWORD and SEED_SALES_PASSWORD must be set in server/.env');
  process.exit(1);
}

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS ?? '12', 10);

// ---------------------------------------------------------------------------
// Reference date — seed data relative to "today" so overdue is always visible
// ---------------------------------------------------------------------------
const today = new Date();
const daysAgo = (n: number) => new Date(today.getTime() - n * 86_400_000);
const daysFromNow = (n: number) => new Date(today.getTime() + n * 86_400_000);

async function upsertUser(email: string, name: string, role: 'ESTIMATOR' | 'SALES_HEAD', password: string) {
  const existing = await User.findOne({ email });
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  if (existing) {
    // Keep the demo password in sync with the env value (no duplicate user created)
    if (!(await existing.comparePassword(password))) {
      existing.passwordHash = hash;
      await existing.save();
      console.log(`[seed] User exists, password hash re-synced from env: ${email}`);
    } else {
      console.log(`[seed] User already exists: ${email}`);
    }
    return existing;
  }
  const user = await User.create({ name, email, passwordHash: hash, role, active: true });
  console.log(`[seed] Created user: ${email} (${role})`);
  return user;
}

async function upsertRFQ(rfqNo: string, data: Partial<typeof RFQ.prototype>) {
  const existing = await RFQ.findOne({ rfqNo });
  if (existing) {
    console.log(`[seed] RFQ already exists: ${rfqNo}`);
    return existing;
  }
  const rfq = await RFQ.create({ rfqNo, ...data });
  console.log(`[seed] Created RFQ: ${rfqNo}`);
  return rfq;
}

async function upsertPart(rfqId: mongoose.Types.ObjectId, partName: string, data: object) {
  const existing = await Part.findOne({ rfqId, partName });
  if (existing) return existing;
  return Part.create({ rfqId, partName, ...data });
}

async function upsertMaterialRate(material: string, ratePerKg: string, effectiveFrom: Date) {
  const existing = await MaterialRate.findOne({ material, effectiveFrom });
  if (existing) return existing;
  return MaterialRate.create({
    material,
    ratePerKg: mongoose.Types.Decimal128.fromString(ratePerKg),
    effectiveFrom,
  });
}

async function upsertMachineRate(machine: string, hourRate: string, effectiveFrom: Date) {
  const existing = await MachineRate.findOne({ machine, effectiveFrom });
  if (existing) return existing;
  return MachineRate.create({
    machine,
    hourRate: mongoose.Types.Decimal128.fromString(hourRate),
    effectiveFrom,
  });
}

async function upsertRateSetting(effectiveFrom: Date, data: object) {
  const existing = await RateSetting.findOne({ effectiveFrom });
  if (existing) return existing;
  return RateSetting.create({ effectiveFrom, ...data });
}

async function seed() {
  await mongoose.connect(MONGODB_URI!);
  console.log('[seed] Connected to MongoDB\n');

  // =========================================================================
  // USERS
  // =========================================================================
  const estimator = await upsertUser(
    'estimator@demo.com',
    'Demo Estimator',
    'ESTIMATOR',
    ESTIMATOR_PASSWORD!
  );

  const salesHead = await upsertUser(
    'sales@demo.com',
    'Demo Sales Head',
    'SALES_HEAD',
    SALES_PASSWORD!
  );

  // =========================================================================
  // MATERIAL RATES (illustrative — editable via rate master screens)
  // Rates are versioned: insert new record when rate changes.
  // =========================================================================
  await upsertMaterialRate('EN8',         '52.00',  new Date('2024-01-01'));
  await upsertMaterialRate('40Cr4',       '78.00',  new Date('2024-01-01'));
  await upsertMaterialRate('20MnCr5',     '82.00',  new Date('2024-01-01'));
  await upsertMaterialRate('EN8',         '55.00',  new Date('2024-07-01')); // revised
  console.log('[seed] Material rates seeded');

  // =========================================================================
  // MACHINE RATES (illustrative — editable via rate master screens)
  // =========================================================================
  await upsertMachineRate('Standard CNC Turning',  '850.00',  new Date('2024-01-01'));
  await upsertMachineRate('Heavy CNC Machining',   '1450.00', new Date('2024-01-01'));
  await upsertMachineRate('VMC Milling',           '950.00',  new Date('2024-01-01'));
  await upsertMachineRate('Grinding',              '750.00',  new Date('2024-01-01'));
  console.log('[seed] Machine rates seeded');

  // =========================================================================
  // RATE SETTINGS — global costing assumptions (illustrative, editable)
  // =========================================================================
  await upsertRateSetting(new Date('2024-01-01'), {
    scrapPct: 5,
    overheadPct: 150,
    packingFreight: mongoose.Types.Decimal128.fromString('2.50'),
    defaultMarginPct: 15,
    gstPct: 18,
    setupCostPerPart: mongoose.Types.Decimal128.fromString('0.50'),
  });
  console.log('[seed] Rate settings seeded');

  // =========================================================================
  // RFQs & PARTS — exact client-provided sample data
  // =========================================================================

  // --- RFQ 1: RFQ-2611-014 ---
  const rfq1 = await upsertRFQ('RFQ-2611-014', {
    customer: 'Company B',
    receivedDate: daysAgo(21),
    dueDate: daysAgo(7),   // intentionally overdue
    ownerId: estimator._id,
    status: 'ESTIMATING',
  });
  await upsertPart(rfq1._id, 'Rear wheel spindle', {
    material: 'EN8',
    grossWeightKg: 0.61,
    annualVolume: 180000,
    cycleTimeMinutes: 3.2,
    machineHourRateRef: mongoose.Types.Decimal128.fromString('850'),
  });

  // --- RFQ 2: RFQ-2611-019 ---
  const rfq2 = await upsertRFQ('RFQ-2611-019', {
    customer: 'Company C',
    receivedDate: daysAgo(10),
    dueDate: daysFromNow(5),
    ownerId: estimator._id,
    status: 'ESTIMATING',
  });
  await upsertPart(rfq2._id, 'Hydraulic lift arm', {
    material: '40Cr4 forging',
    grossWeightKg: 4.60,
    annualVolume: 24000,
    cycleTimeMinutes: 11.5,
    machineHourRateRef: mongoose.Types.Decimal128.fromString('1450'),
  });

  // --- RFQ 3: RFQ-2611-023 ---
  const rfq3 = await upsertRFQ('RFQ-2611-023', {
    customer: 'Company D',
    receivedDate: daysAgo(5),
    dueDate: daysFromNow(14),
    ownerId: estimator._id,
    status: 'ESTIMATING',
  });
  await upsertPart(rfq3._id, 'Gear blank', {
    material: '20MnCr5',
    grossWeightKg: 1.48,
    annualVolume: 60000,
    cycleTimeMinutes: 4.8,
    machineHourRateRef: mongoose.Types.Decimal128.fromString('950'),
  });

  console.log('[seed] RFQs and parts seeded\n');
  console.log('='.repeat(60));
  console.log('Seed completed successfully.');
  console.log('='.repeat(60));
  console.log('Demo login credentials:');
  console.log(`  Estimator : estimator@demo.com  / (from SEED_ESTIMATOR_PASSWORD)`);
  console.log(`  Sales Head: sales@demo.com       / (from SEED_SALES_PASSWORD)`);
  console.log('='.repeat(60));

  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error('[seed] Error:', err);
  process.exit(1);
});

