// ONE-TIME migration for databases that already have users from before email verification existed.
// Without it, those accounts are locked out until they request a verification email. Review before running!
//   node scripts/grandfather-email-verified.js --confirm      (marks ONLY accounts that lack the field)
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { User } from '../src/models/User.js';
if (!process.argv.includes('--confirm')) { console.log('Dry run. Re-run with --confirm to mark pre-existing accounts as verified.'); process.exit(0); }
await mongoose.connect(env.db);
const r = await User.collection.updateMany({ emailVerified: { $exists: false } }, { $set: { emailVerified: true } });
console.log(`Marked ${r.modifiedCount} pre-existing accounts as verified.`); await mongoose.disconnect();
