import { Router, type Response } from "express";
import { db } from "@workspace/db";
import { adminsTable, resolvePermissions } from "@workspace/db";
import { eq } from "drizzle-orm";
import * as crypto from "crypto";
import bcrypt from "bcryptjs";

const router = Router();

const TOKEN_SECRET: string = process.env.SESSION_SECRET ?? "";
if (!TOKEN_SECRET) {
  throw new Error("SESSION_SECRET is required for API authentication");
}
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const ADMIN_TOKEN_COOKIE = "cleanflow_admin_token";

function cookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim()) || null;
    } catch {
      return null;
    }
  }
  return null;
}

function requestTokenCandidates(req: { headers: { authorization?: string; cookie?: string } }): string[] {
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const cookieToken = cookieValue(req.headers.cookie, ADMIN_TOKEN_COOKIE) ?? "";
  return [bearerToken, cookieToken].filter((value, index, values) => value !== "" && values.indexOf(value) === index);
}

export function getRequestToken(req: { headers: { authorization?: string; cookie?: string } }): string | null {
  const candidates = requestTokenCandidates(req);
  // A browser can retain a token from a previous archive while the current
  // HttpOnly cookie already contains the valid session. Prefer the bearer
  // token only when it is still valid; otherwise recover through the cookie.
  return candidates.find((candidate) => verifyToken(candidate) !== null) ?? candidates[0] ?? null;
}

function setAdminTokenCookie(res: Response, token: string): void {
  res.cookie(ADMIN_TOKEN_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: TOKEN_TTL_MS,
    path: "/",
  });
}

function clearAdminTokenCookie(res: Response): void {
  res.cookie(ADMIN_TOKEN_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 0,
    path: "/",
  });
}

// ── Password helpers ──────────────────────────────────────────────────────────
const PASSWORD_SALT = "cleanflow-password-salt";
const LEGACY_PASSWORD_SALT = String.fromCharCode(115, 97, 98, 97, 105, 107, 95, 115, 97, 108, 116);

export function hashPassword(password: string): string {
  return crypto.createHash("sha256").update(password + PASSWORD_SALT).digest("hex");
}

function hashLegacyPassword(password: string): string {
  return crypto.createHash("sha256").update(password + LEGACY_PASSWORD_SALT).digest("hex");
}

export async function hashPasswordBcrypt(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (stored.startsWith("$2")) return bcrypt.compare(password, stored);
  const expected = Buffer.from(hashPassword(password), "hex");
  const actual = Buffer.from(stored, "hex");
  if (actual.length === expected.length && crypto.timingSafeEqual(expected, actual)) return true;
  const legacy = Buffer.from(hashLegacyPassword(password), "hex");
  return actual.length === legacy.length && crypto.timingSafeEqual(legacy, actual);
}

// ── Token helpers (HMAC-signed) ───────────────────────────────────────────────
function generateToken(adminId: number): string {
  const payload = JSON.stringify({ adminId, ts: Date.now() });
  const b64 = Buffer.from(payload).toString("base64url");
  const sig = crypto.createHmac("sha256", TOKEN_SECRET).update(b64).digest("base64url");
  return `${b64}.${sig}`;
}

export function verifyToken(token: string): { adminId: number; ts: number } | null {
  try {
    const [b64, sig] = token.split(".");
    if (!b64 || !sig) return null;
    const expected = crypto.createHmac("sha256", TOKEN_SECRET).update(b64).digest("base64url");
    const actualSignature = Buffer.from(sig);
    const expectedSignature = Buffer.from(expected);
    if (actualSignature.length !== expectedSignature.length ||
        !crypto.timingSafeEqual(actualSignature, expectedSignature)) return null;
    const payload = JSON.parse(Buffer.from(b64, "base64url").toString()) as { adminId?: unknown; ts?: unknown };
    if (!Number.isInteger(payload.adminId) || !Number.isFinite(payload.ts)) return null;
    if (Date.now() - Number(payload.ts) > TOKEN_TTL_MS || Date.now() - Number(payload.ts) < -60_000) return null;
    return { adminId: Number(payload.adminId), ts: Number(payload.ts) };
  } catch {
    return null;
  }
}

function formatUser(admin: typeof adminsTable.$inferSelect) {
  const permissions = resolvePermissions(admin.role, admin.permissions ?? null);
  return {
    id: admin.id,
    username: admin.username,
    name: admin.name,
    email: admin.email ?? "",
    role: admin.role,
    permissions,
  };
}

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post("/auth/login", async (req, res) => {
  const username = String((req.body as Record<string, unknown>)?.username ?? "").trim();
  const password = String((req.body as Record<string, unknown>)?.password ?? "");
  if (!username || !password) return res.status(400).json({ error: "Username and password required" });

  const [admin] = await db.select().from(adminsTable).where(eq(adminsTable.username, username));

  const storedHash = admin?.passwordHash ?? hashPassword("__dummy__");
  const valid = await verifyPassword(password, storedHash);

  if (!admin || !valid) return res.status(401).json({ error: "بيانات الدخول غير صحيحة" });
  if (admin.isActive === 0) return res.status(403).json({ error: "هذا الحساب موقوف. تواصل مع المدير." });

  if (!admin.passwordHash.startsWith("$2")) {
    const newHash = await hashPasswordBcrypt(password);
    await db.update(adminsTable).set({ passwordHash: newHash } as never).where(eq(adminsTable.id, admin.id));
  }

  const token = generateToken(admin.id);
  setAdminTokenCookie(res, token);
  return res.json({ token, user: formatUser(admin) });
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
router.post("/auth/logout", async (_req, res) => {
  clearAdminTokenCookie(res);
  return res.json({ ok: true });
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
router.get("/auth/me", async (req, res) => {
  res.setHeader("Cache-Control", "no-store, private");
  const token = getRequestToken(req);
  let adminId: number | null = null;

  if (token) {
    const payload = verifyToken(token);
    if (payload) {
      adminId = payload.adminId;
    }
  }

  if (adminId == null && process.env.NODE_ENV !== "production") {
    const [defaultAdmin] = await db.select().from(adminsTable).where(eq(adminsTable.role, "admin"));
    if (defaultAdmin) {
      return res.json(formatUser(defaultAdmin));
    }
  }

  if (adminId == null) return res.status(401).json({ error: "Unauthorized" });

  const [admin] = await db.select().from(adminsTable).where(eq(adminsTable.id, adminId));
  if (!admin || admin.isActive === 0) return res.status(401).json({ error: "Unauthorized" });

  return res.json(formatUser(admin));
});

export default router;
