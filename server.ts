import express, { type Request, type Response, type NextFunction } from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import apiApp from "./artifacts/api-server/src/app";

if (!process.env.SESSION_SECRET) {
  process.env.SESSION_SECRET = "cleanflow-hawiat-secret-key-development-2026";
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Mount the API application (serves /api/*, /uploads/*)
  app.use(apiApp);

  // Vite in dev or static files in production
  const frontendDist = path.resolve(process.cwd(), "artifacts/sabaik-almasa/dist/public");

  if (process.env.NODE_ENV === "production" && fs.existsSync(path.join(frontendDist, "index.html"))) {
    app.use(express.static(frontendDist));
    app.get("*", (req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith("/api") || req.path.startsWith("/uploads")) return next();
      res.sendFile(path.join(frontendDist, "index.html"));
    });
  } else {
    const vite = await createViteServer({
      configFile: path.resolve(process.cwd(), "artifacts/sabaik-almasa/vite.config.ts"),
      server: {
        middlewareMode: true,
        host: "0.0.0.0",
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[CleanFlow] Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("[CleanFlow] Fatal error starting server:", err);
  process.exit(1);
});
