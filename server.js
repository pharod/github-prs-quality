import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.join(__dirname, "dist");
const API_BASE = "https://api.github.com";

app.use(express.json({ limit: "1mb" }));

app.use("/api", async (req, res) => {
  const upstreamPath = req.originalUrl.replace(/^\/api/, "");
  const url = new URL(`${API_BASE}${upstreamPath}`);

  const headers = {
    Accept: req.headers["accept"] ?? "application/vnd.github+json",
    Authorization: req.headers["authorization"] ?? "",
    "User-Agent": req.headers["user-agent"] ?? "pr-quality-dashboard",
  };

  const options = {
    method: req.method,
    headers,
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    options.body = JSON.stringify(req.body ?? {});
  }

  try {
    const response = await fetch(url.toString(), options);
    res.status(response.status);

    const contentType = response.headers.get("content-type");
    if (contentType) {
      res.setHeader("content-type", contentType);
    }

    const link = response.headers.get("link");
    if (link) {
      res.setHeader("link", link);
    }

    const body = await response.text();
    res.send(body);
  } catch (error) {
    res.status(502).json({ error: "Upstream GitHub request failed." });
  }
});

app.use(express.static(distPath));

app.get("*", (_req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
