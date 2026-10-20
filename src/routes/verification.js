import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { VerificationRecord, BvnClaim } from "../models/Extra.js";
import { AuditLog } from "../models/Finance.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireCreator } from "../middleware/authorize.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { getSetting } from "../services/settings.js";
import { notify } from "../services/notify.js";
import { resolveDojahConfig } from "../services/dojahConfig.js";
import {
  validateBvn,
  evaluateBvnValidation,
  DojahError,
} from "../services/dojah.js";
import { bvnFingerprint } from "../services/verification.js";

const r = Router();
r.use(authenticate, requireCreator);
const MAX_FAILED_PER_DAY = 5;
const name = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[\p{L}][\p{L} '’-]*$/u, "Use letters only");
const body = z.object({
  bvn: z.string().regex(/^\d{11}$/, "A BVN has exactly 11 digits"),
  firstName: name,
  lastName: name,
  dob: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD")
    .refine((d) => {
      const t = Date.parse(d);
      const age = (Date.now() - t) / 31557600000;
      return Number.isFinite(t) && age >= 18 && age < 120;
    }, "Enter a valid date of birth (18+)"),
});
// 5 submissions per hour per account.
const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,

  keyGenerator: (req) => `bvn:${req.user.id}`,

  handler: (_req, res) =>
    res.status(429).json({
      error: 'Too many verification attempts. Please try again in an hour.',
      code: 'RATE_LIMITED',
    }),
});

r.get(
  "/",
  asyncHandler(async (req, res) => {
    const cfg = resolveDojahConfig();
    const v = await VerificationRecord.findOne({ userId: req.user._id })
      .sort("-createdAt")
      .select("status providerEnv createdAt");
    const since = new Date(Date.now() - 864e5);
    const failed = await VerificationRecord.countDocuments({
      userId: req.user._id,
      status: "FAILED",
      createdAt: { $gte: since },
    });
    res.json({
      status: v?.status === "PENDING" ? "PENDING" : v?.status || "NOT_STARTED",
      providerConfigured: cfg.ok,
      environment: cfg.environment || null,
      attemptsLeft: Math.max(0, MAX_FAILED_PER_DAY - failed),
    });
  }),
);

r.post(
  "/start",
  limiter,
  asyncHandler(async (req, res) => {
    const b = body.parse(req.body);
    const cfg = resolveDojahConfig();
    if (!cfg.ok) {
      console.error(`[verification] provider unavailable: ${cfg.reason}`);
      throw new ApiError(
        503,
        "Identity verification is temporarily unavailable. Please try again later.",
        "PROVIDER_NOT_CONFIGURED",
      );
    }
    const fingerprint = bvnFingerprint(b.bvn);
    if (!fingerprint) {
      console.error("[verification] BVN_HASH_PEPPER is not set");
      throw new ApiError(
        503,
        "Identity verification is temporarily unavailable. Please try again later.",
        "PROVIDER_NOT_CONFIGURED",
      );
    }

    const latest = await VerificationRecord.findOne({
      userId: req.user._id,
      status: { $in: ["VERIFIED", "REQUIRES_REVIEW"] },
    });
    if (latest) return res.json({ status: latest.status }); // already done: never pay for a repeat check
    const failed = await VerificationRecord.countDocuments({
      userId: req.user._id,
      status: "FAILED",
      createdAt: { $gte: new Date(Date.now() - 864e5) },
    });
    if (failed >= MAX_FAILED_PER_DAY)
      throw new ApiError(
        429,
        "Too many unsuccessful attempts today. Please try again tomorrow or contact support.",
        "TOO_MANY_FAILURES",
      );
    if (
      await BvnClaim.exists({
        bvnHash: fingerprint,
        userId: { $ne: req.user._id },
      })
    )
      throw new ApiError(
        409,
        "This BVN cannot be used for verification on this account.",
        "BVN_IN_USE",
      );

    // In-flight lock (unique partial index): a second concurrent request cannot start another paid call.
    await VerificationRecord.updateMany(
      {
        userId: req.user._id,
        status: "PENDING",
        createdAt: { $lt: new Date(Date.now() - 2 * 60e3) },
      },
      { status: "EXPIRED", failReason: "STALE" },
    );
    const rec = await VerificationRecord.create({
      userId: req.user._id,
      provider: "dojah",
      providerEnv: cfg.environment,
      status: "PENDING",
      feeKobo: 0,
    }).catch((e) => {
      if (e.code === 11000)
        throw new ApiError(
          409,
          "A verification is already in progress.",
          "IN_PROGRESS",
        );
      throw e;
    });
    const close = (status, failReason, extra = {}) =>
      VerificationRecord.updateOne(
        { _id: rec._id },
        { status, failReason, ...extra },
      );
    const attemptsLeft = () => Math.max(0, MAX_FAILED_PER_DAY - failed - 1);

    let result;
    try {
      result = await validateBvn(cfg, b);
    } catch (e) {
      const kind = e instanceof DojahError ? e.kind : "UNKNOWN";
      if (kind === "NOT_FOUND") {
        await close("FAILED", "BVN_NOT_FOUND");
        throw Object.assign(
          new ApiError(
            422,
            "We could not find that BVN. Check the number and try again.",
            "BVN_NOT_FOUND",
          ),
          { attemptsLeft: attemptsLeft() },
        );
      }
      await close("EXPIRED", kind); // provider problems never count against the user and never produce a verified state
      if (kind === "BAD_REQUEST")
        throw new ApiError(
          400,
          "The verification provider rejected these details. Check them and try again.",
          "INVALID_INPUT",
        );
      if (kind === "TIMEOUT")
        throw new ApiError(
          504,
          "Verification timed out. No attempt was counted; please try again.",
          "PROVIDER_TIMEOUT",
        );
      if (kind === "UNAUTHORIZED" || kind === "INSUFFICIENT_FUNDS")
        console.error(
          `[verification] OPERATOR ACTION NEEDED: provider returned ${kind}`,
        );
      throw new ApiError(
        503,
        "Verification is temporarily unavailable. No attempt was counted; please try again shortly.",
        "PROVIDER_UNAVAILABLE",
      );
    }

    const verdict = evaluateBvnValidation(result, {
      minConfidence: Number(process.env.BVN_MIN_NAME_CONFIDENCE) || 90,
    });
    if (!verdict.verified) {
      await close("FAILED", verdict.reason);
      throw Object.assign(
        new ApiError(
          422,
          "The details did not match this BVN record. Check them and try again.",
          "BVN_MISMATCH",
        ),
        { attemptsLeft: attemptsLeft() },
      );
    }
    try {
      await BvnClaim.create({ bvnHash: fingerprint, userId: req.user._id });
    } catch (e) {
      if (e.code === 11000) {
        const mine = await BvnClaim.exists({
          bvnHash: fingerprint,
          userId: req.user._id,
        });
        if (!mine) {
          await close("FAILED", "BVN_IN_USE");
          throw new ApiError(
            409,
            "This BVN cannot be used for verification on this account.",
            "BVN_IN_USE",
          );
        }
      } else throw e;
    }

    await close("VERIFIED", undefined, {
      confidence: verdict.scores,
      feeKobo: await getSetting("verificationFeeKobo"),
    });
    await AuditLog.create({
      actorId: req.user._id,
      action: "IDENTITY_VERIFIED",
      target: rec.id,
      meta: { provider: "dojah", environment: cfg.environment },
    }); // no BVN, names or DOB
    await notify(
      req.user._id,
      "VERIFICATION",
      "Your identity verification was approved",
      "/studio",
    );
    res.json({ status: "VERIFIED" });
  }),
);
export default r;
