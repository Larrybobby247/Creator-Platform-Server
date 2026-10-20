// Secure provisioning of the first (or any) administrator. There is no public admin sign-up.
//   ADMIN_PASSWORD='a-long-passphrase' node scripts/create-admin.js you@company.com [SUPER_ADMIN|FINANCE|MODERATOR|SUPPORT|VERIFICATION]
// The password comes from the environment so it never appears in shell history or process lists.
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { User } from '../src/models/User.js';
import { Wallet } from '../src/models/Finance.js';
const [email, role = 'SUPER_ADMIN'] = process.argv.slice(2); const pw = process.env.ADMIN_PASSWORD;
if (!email || !['SUPER_ADMIN', 'FINANCE', 'MODERATOR', 'SUPPORT', 'VERIFICATION'].includes(role)) { console.error('Usage: ADMIN_PASSWORD=... node scripts/create-admin.js <email> [role]'); process.exit(1); }
await mongoose.connect(env.db); let u = await User.findOne({ email: email.toLowerCase() });
if (!u) { if (!pw || pw.length < 10) { console.error('Set ADMIN_PASSWORD (10+ characters) to create a new account.'); process.exit(1); }
  u = await User.create({ email: email.toLowerCase(), username: `admin_${Math.random().toString(36).slice(2, 8)}`, displayName: 'Administrator', passwordHash: await bcrypt.hash(pw, 12), emailVerified: true, termsAcceptedAt: new Date() }); await Wallet.create({ userId: u._id }); }
else if (pw) { if (pw.length < 10) { console.error('ADMIN_PASSWORD must be 10+ characters'); process.exit(1); } u.passwordHash = await bcrypt.hash(pw, 12); }
u.role = 'ADMIN'; u.adminRole = role; u.emailVerified = true; u.accountStatus = 'ACTIVE'; await u.save(); console.log(`${u.email} is now ${role}. Sign in at the admin dashboard.`); await mongoose.disconnect();
