import 'dotenv/config';
const need = (k) => { if (!process.env[k]) throw new Error(`Missing env ${k}`); return process.env[k]; };
const prod = process.env.NODE_ENV === 'production';
export const env = {
  prod,
  port: Number(process.env.PORT || 4000),
  db: need('DATABASE_URL'),
  jwtSecret: need('JWT_SECRET'),
  adminUrl: process.env.ADMIN_URL || 'http://localhost:5174',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  backendUrl: process.env.BACKEND_URL || 'http://localhost:4000',
  paystackSecret: process.env.PAYSTACK_SECRET_KEY || '',
  paymentProvider: prod && process.env.PAYMENT_PROVIDER === 'mock' ? 'paystack' : (process.env.PAYMENT_PROVIDER || 'mock'),
  vapidPublic: process.env.VAPID_PUBLIC_KEY || '', vapidPrivate: process.env.VAPID_PRIVATE_KEY || '', vapidSubject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
  smtpUrl: process.env.SMTP_URL || '', mailFrom: process.env.MAIL_FROM || 'Creator <no-reply@example.com>', publicDir: process.env.PUBLIC_DIR || './public-media',
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  mediaSecret: process.env.MEDIA_SIGNING_SECRET || process.env.JWT_SECRET,
  mediaDir: process.env.MEDIA_DIR || './private-media',
  ffprobe: process.env.FFPROBE_PATH || 'ffprobe',
};
