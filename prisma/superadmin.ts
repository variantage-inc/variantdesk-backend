/* Creates the Variantage staff sign in for the superadmin panel at /admin.

   Every user row needs a business, so staff get one of their own, by a fixed
   id, holding nothing. It is never a customer's business: promoting somebody
   inside a real customer account would give that account's owner a colleague
   who can read every other business.

   Safe to run again. The password is only set when the user is created, so a
   rerun never undoes a change made afterwards in Settings, Security. Pass
   --reset-password to put it back to the demo password.

   The demo password is in the repo, like the seed's. Change it in Settings,
   Security on first sign in.

   Run: npm run db:superadmin */
import { prisma } from '../src/lib/prisma.js';
import { hashPassword } from '../src/lib/password.js';
import { defaultCategories } from '../src/lib/defaults.js';
import { trialCreateData } from '../src/modules/billing/billing.service.js';

const BUSINESS_ID = 'variantage-staff';
const EMAIL = 'support@variantage.com';
const DEMO_PASSWORD = 'VariantageAdmin2026!';

async function main() {
  const reset = process.argv.includes('--reset-password');

  await prisma.business.upsert({
    where: { id: BUSINESS_ID },
    update: {},
    create: {
      id: BUSINESS_ID,
      name: 'Variantage Staff',
      legalName: 'Variantage Inc.',
      province: 'ON',
      subscription: { create: trialCreateData() },
      categories: { create: defaultCategories() },
    },
  });

  const existing = await prisma.user.findUnique({ where: { email: EMAIL } });

  if (!existing) {
    await prisma.user.create({
      data: {
        businessId: BUSINESS_ID,
        email: EMAIL,
        passwordHash: await hashPassword(DEMO_PASSWORD),
        firstName: 'Variantage',
        lastName: 'Support',
        role: 'OWNER',
        platformRole: 'SUPERADMIN',
        emailVerifiedAt: new Date(),
      },
    });
    console.log(`Created ${EMAIL} as SUPERADMIN with the demo password.`);
  } else {
    await prisma.user.update({
      where: { id: existing.id },
      data: {
        platformRole: 'SUPERADMIN',
        deletedAt: null,
        ...(reset ? { passwordHash: await hashPassword(DEMO_PASSWORD) } : {}),
      },
    });
    /* A role lives in the access token, so a session issued before the
       promotion would carry on as a customer until it refreshed. End them. */
    await prisma.session.updateMany({
      where: { userId: existing.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    console.log(
      `${EMAIL} already existed: promoted to SUPERADMIN` +
        (reset ? ' and password reset to the demo password.' : ', password unchanged.'),
    );
    if (existing.businessId !== BUSINESS_ID) {
      console.log(`Note: it stays in its own business (${existing.businessId}).`);
    }
  }

  console.log('Sign in, then open /admin. Change the password in Settings, Security.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
