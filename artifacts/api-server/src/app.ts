import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import fs from "fs";
import rateLimit from "express-rate-limit";
import router from "./routes";
import { logger } from "./lib/logger";
import { requireAdmin, requireNonDriver } from "./middleware/adminAuth";
import { normalizePublicUploadUrls } from "./lib/publicUploadPath";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app: Express = express();
// The deployed app runs behind a reverse proxy. Trust its hop so rate limiting
// and request IP detection use the forwarded client address without warnings.
app.set("trust proxy", 1);

// ── Security headers ──────────────────────────────────────────────────────────
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // The public chat can explicitly request a location and open the device
  // camera through the browser's file picker. Keep microphone disabled.
  res.setHeader("Permissions-Policy", "geolocation=(self), camera=(self), microphone=()");
  next();
});

// ── CORS — exact origin allowlist ────────────────────────────────────────────
// Production requests are same-origin. Preview and local development origins
// are allowed only when their complete origin matches these anchored rules.
function isAllowedOrigin(origin: string): boolean {
  if (origin === "https://sabaik.net" || origin === "https://www.sabaik.net") return true;
  try {
    const url = new URL(origin);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      return false;
    }
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0") return true;
    return host.endsWith(".run.app") || host.endsWith(".google.com") || host.endsWith(".aistudio.google.com") || host.endsWith(".replit.dev") || host.endsWith(".replit.app");
  } catch {
    return false;
  }
}
app.use(
  cors({
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "X-Requested-With", "X-HTTP-Method-Override", "X-Visitor-Session"],
    origin(origin, callback) {
      if (!origin) return callback(null, true); // same-origin / curl
      if (isAllowedOrigin(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  }),
);

// ── Request parsing ───────────────────────────────────────────────────────────
app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// Keep legacy database values readable while making every JSON response use
// the Hostinger public filesystem path. POST /api/uploads remains an API
// action; only the returned/public file URL is normalized.
app.use((_req: Request, res: Response, next: NextFunction) => {
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => originalJson(normalizePublicUploadUrls(body))) as typeof res.json;
  next();
});

// ── Rate limiting ─────────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { error: "Too many login attempts. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/auth/login", loginLimiter);

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api", apiLimiter);

// ── Serve public assets from the web root ────────────────────────────────────
// Customer/driver evidence is written to a separate private directory by the
// upload routes below and is never mounted as static content here.
const uploadHeaders = (res: Response) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
};
for (const uploadRoot of [
  path.join(process.cwd(), "uploads"),
  path.join(process.cwd(), "artifacts/api-server/uploads"),
  path.join(process.cwd(), "build_php/uploads"),
  path.join(process.cwd(), "attached_assets"),
]) {
  app.use("/uploads", express.static(uploadRoot, { dotfiles: "deny", fallthrough: true, setHeaders: uploadHeaders }));
}

// Cached legacy links should converge on the real public path instead of
// reaching the API router and producing a misleading 500/404 response.
app.get("/api/uploads/:filename", (req, res) => {
  const filename = String(req.params.filename ?? "");
  if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
    return res.status(400).json({ error: "Invalid upload filename" });
  }
  return res.redirect(301, `/uploads/${filename}`);
});

// ── Admin routes — require valid token globally ───────────────────────────────
app.use("/api/admin", requireAdmin, requireNonDriver);

// ── All routes ────────────────────────────────────────────────────────────────
app.use("/api", router);

// ── Serve frontend SPA ────────────────────────────────────────────────────────
// The workflow may start this package with either the workspace root or the
// package directory as cwd. Resolve the frontend from the bundled server's
// location first, then keep the cwd-based path as a local-dev fallback.
const frontendDistCandidates = [
  path.resolve(__dirname, "../../../artifacts/sabaik-almasa/dist/public"),
  path.resolve(process.cwd(), "artifacts/sabaik-almasa/dist/public"),
];
const frontendDistPath =
  frontendDistCandidates.find((candidate) => fs.existsSync(path.join(candidate, "index.html"))) ??
  frontendDistCandidates[0];
app.use(express.static(frontendDistPath));
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method === "GET" && !req.path.startsWith("/api")) {
    return res.sendFile(path.join(frontendDistPath, "index.html"));
  }
  next();
});

// Never let Express serialize an exception (and its stack) into an HTTP
// response. CORS rejections are an expected client error; all other failures
// are logged with their details but receive a stable generic response.
app.use((error: unknown, req: Request, res: Response, _next: NextFunction): void => {
  const isCorsRejection = error instanceof Error && error.message === "Not allowed by CORS";
  logger.error({ err: error, method: req.method, path: req.originalUrl }, "HTTP request failed");
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(isCorsRejection ? 403 : 500).json({
    error: isCorsRejection ? "Origin not allowed" : "Internal server error",
  });
});

export default app;
