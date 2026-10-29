import 'dotenv/config';
const need = (k) => { if (!process.env[k]) throw new Error(`Missing env ${k}`); return process.env[k]; };
const prod = process.env.NODE_ENV === 'production';
export const env = {
  prod,
  port: Number(process.env.PORT || 4000),
  db: need('DATABASE_URL'),
  jwtSecret: need('JWT_SECRET'),
  adminUrl: process.env.ADMIN_URL,
  frontendUrl: process.env.FRONTEND_URL,
  backendUrl: process.env.BACKEND_URL,
  paystackSecret: process.env.PAYSTACK_SECRET_KEY || '',
  paymentProvider: prod && process.env.PAYMENT_PROVIDER === 'mock' ? 'paystack' : (process.env.PAYMENT_PROVIDER || 'mock'),
  vapidPublic: process.env.VAPID_PUBLIC_KEY || '', vapidPrivate: process.env.VAPID_PRIVATE_KEY || '', vapidSubject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
  // Email goes out through Resend (https://resend.com). MAIL_FROM must use a domain you verified in Resend (or onboarding@resend.dev while testing).
  resendApiKey: process.env.RESEND_API_KEY || '', emailEnabled: !!process.env.RESEND_API_KEY, mailFrom: process.env.MAIL_FROM || 'Privy <onboarding@resend.dev>', publicDir: process.env.PUBLIC_DIR || './public-media',
  // Photos, videos and voice notes live in Cloudinary as AUTHENTICATED assets (no public URL exists). Fallback to the local private folder only when Cloudinary is not configured.
  cloudinary: { cloudName: process.env.CLOUDINARY_CLOUD_NAME || '', apiKey: process.env.CLOUDINARY_API_KEY || '', apiSecret: process.env.CLOUDINARY_API_SECRET || '', folder: process.env.CLOUDINARY_FOLDER || 'creator-platform' },
  cloudinaryEnabled: !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET),
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  mediaSecret: process.env.MEDIA_SIGNING_SECRET || process.env.JWT_SECRET,
  mediaDir: process.env.MEDIA_DIR || './private-media',
  ffprobe: process.env.FFPROBE_PATH || 'ffprobe',
};
