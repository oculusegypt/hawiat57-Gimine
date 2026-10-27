/**
 * adminAuth.ts — Global middleware for /api/admin/* routes
 * Verifies HMAC-signed Bearer token and attaches admin context.
 */
import { type Request, type Response, type NextFunction } from "express";
import { getRequestToken, verifyToken } from "../routes/auth";
import { db } from "@workspace/db";
import { adminsTable, resolvePermissions, type AdminSection, ALL_SECTIONS } from "@workspace/db";
import { eq } from "drizzle-orm";

export interface AdminRequest extends Request {
  adminId: number;
  adminRole: string;
  adminPermissions: AdminSection[];
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const token = getRequestToken(req);
  let adminRow = null;
  let adminId = 0;

  if (token) {
    const payload = verifyToken(token);
    if (payload) {
      adminId = payload.adminId;
      adminRow = db.select().from(adminsTable).where(eq(adminsTable.id, adminId)).get();
    }
  }

  // In development and preview environments, if session cookies or tokens are
  // partitioned/blocked in iframes, fallback to the default system administrator
  if (!adminRow && process.env.NODE_ENV !== "production") {
    adminRow = db.select().from(adminsTable).where(eq(adminsTable.role, "admin")).get();
    if (adminRow) {
      adminId = adminRow.id;
    }
  }

  if (!adminRow || adminRow.isActive === 0) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const r = req as AdminRequest;
  r.adminId = adminId;
  r.adminRole = adminRow.role;
  r.adminPermissions = resolvePermissions(adminRow.role, adminRow.permissions ?? null);
  next();
}

/** Block driver accounts from the administrative management namespace. */
export function requireNonDriver(req: Request, res: Response, next: NextFunction): void {
  const r = req as AdminRequest;
  if (r.adminRole === "driver") {
    res.status(403).json({ error: "مسار الإدارة غير متاح لحساب السائق" });
    return;
  }
  next();
}

/** Use this to restrict a route to admin + manager only */
export function requireManagerOrAdmin(req: Request, res: Response, next: NextFunction): void {
  const r = req as AdminRequest;
  if (r.adminRole !== "admin" && r.adminRole !== "manager") {
    res.status(403).json({ error: "ليس لديك صلاحية للوصول إلى هذا المورد" });
    return;
  }
  next();
}

/** Use this for request operations that may assign work to a driver. */
export function requireRequestAssignment(req: Request, res: Response, next: NextFunction): void {
  const r = req as AdminRequest;
  if (r.adminRole !== "admin" && r.adminRole !== "manager" && r.adminRole !== "requests_officer") {
    res.status(403).json({ error: "ليس لديك صلاحية لإسناد الطلبات" });
    return;
  }
  next();
}

/** Use this to restrict a route to admin only */
export function requireAdminOnly(req: Request, res: Response, next: NextFunction): void {
  const r = req as AdminRequest;
  if (r.adminRole !== "admin") {
    res.status(403).json({ error: "هذه الصلاحية للمدير الرئيسي فقط" });
    return;
  }
  next();
}

/** Use this to restrict a route to driver accounts only. */
export function requireDriver(req: Request, res: Response, next: NextFunction): void {
  const r = req as AdminRequest;
  if (r.adminRole !== "driver") {
    res.status(403).json({ error: "هذا المورد مخصص للسائقين فقط" });
    return;
  }
  next();
}

/** Enforce the same section permissions used by the admin navigation at the API boundary. */
export function requireSectionPermission(section: AdminSection, options?: { adminOnly?: boolean }) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const r = req as AdminRequest;
    if (options?.adminOnly && r.adminRole !== "admin") {
      res.status(403).json({ error: "هذه العملية متاحة لمدير النظام فقط" });
      return;
    }
    if (r.adminRole !== "admin" && !r.adminPermissions.includes(section)) {
      res.status(403).json({ error: "ليس لديك صلاحية للوصول إلى هذا القسم" });
      return;
    }
    next();
  };
}

export function requireAnySectionPermission(...sections: AdminSection[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const r = req as AdminRequest;
    if (r.adminRole !== "admin" && !sections.some(section => r.adminPermissions.includes(section))) {
      res.status(403).json({ error: "ليس لديك صلاحية للوصول إلى هذا القسم" });
      return;
    }
    next();
  };
}
