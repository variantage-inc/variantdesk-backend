/* Seed for local development. Mirrors the sample business the mockups use, so
   a screen built against the API shows the same figures the client already
   reviewed: Maple Ridge Consulting, Toronto, Ontario, HST 13%. */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '../src/generated/prisma/client.js';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

async function main() {
  const business = await prisma.business.upsert({
    where: { id: 'seed-maple-ridge' },
    update: {},
    create: {
      id: 'seed-maple-ridge',
      name: 'Maple Ridge Consulting',
      legalName: 'Maple Ridge Consulting',
      businessType: 'SOLE_PROPRIETOR',
      gstHstNumber: '123456789 RT0001',
      gstRegistered: true,
      addressLine1: '118 Simcoe Street, Suite 400',
      city: 'Toronto',
      province: 'ON',
      postalCode: 'M5H 3G4',
      email: 'sarah@mapleridgeconsulting.ca',
      phone: '416 555 0148',
      invoicePrefix: 'INV-',
      nextInvoiceNumber: 48,
      invoiceTerms: 'Payment due within 30 days of the invoice date.',
      invoiceFooter:
        'Thank you for your business. Interest of 2% per month is charged on overdue accounts.',
    },
  });

  const user = await prisma.user.upsert({
    where: { email: 'sarah@mapleridgeconsulting.ca' },
    update: {},
    create: {
      businessId: business.id,
      email: 'sarah@mapleridgeconsulting.ca',
      passwordHash: await bcrypt.hash('Variantage2026!', 12),
      firstName: 'Sarah',
      lastName: 'Whitfield',
      role: 'OWNER',
      emailVerifiedAt: new Date(),
    },
  });

  console.log(`Seeded ${business.name} with owner ${user.email}`);
  console.log('Development password: Variantage2026!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
