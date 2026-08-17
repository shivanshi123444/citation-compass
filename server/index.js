// server/index.js
require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");

const db = require("./db");
const q = require("./queries");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

// Wrap each async route so DB failures surface as clean JSON errors
// instead of crashing the process or hanging the request.
function handle(fn) {
  return async (req, res) => {
    try {
      const result = await fn(req, res);
      if (result !== undefined) res.json(result);
    } catch (err) {
      console.error(err.message);
      const dbDown = /not configured|unreachable|ServiceUnavailable|ECONNREFUSED/i.test(
        err.message + " " + (err.cause ? err.cause.message : "")
      );
      res.status(dbDown ? 503 : 500).json({
        error: dbDown
          ? "Can't reach the database right now. Check that your CognoDB instance is running and your connection settings are correct."
          : "Something went wrong handling that request.",
      });
    }
  };
}

app.get("/api/health", async (req, res) => {
  try {
    await db.verifyConnectivity();
    res.json({ status: "ok", database: "connected" });
  } catch (err) {
    res.status(503).json({ status: "degraded", database: "unreachable", detail: err.message });
  }
});

app.get("/api/stats", handle(() => q.getStats()));
app.get("/api/topics", handle(() => q.listTopics()));

app.get("/api/search/papers", handle((req) => q.searchPapers(req.query.q || "", req.query.limit)));
app.get("/api/search/authors", handle((req) => q.searchAuthors(req.query.q || "", req.query.limit)));

app.get("/api/papers/:id", handle(async (req, res) => {
  const detail = await q.getPaperDetail(req.params.id);
  if (!detail) {
    res.status(404).json({ error: "Paper not found." });
    return undefined;
  }
  return detail;
}));

app.get("/api/papers/:id/network", handle((req) => q.getCitationNetwork(req.params.id, req.query.hops)));
app.get("/api/papers/:id/co-cited", handle((req) => q.coCitedPapers(req.params.id, req.query.minShared)));

app.get("/api/path", handle((req) => {
  const { from, to } = req.query;
  if (!from || !to) {
    const err = new Error("Both `from` and `to` paper ids are required.");
    err.status = 400;
    throw err;
  }
  return q.findCitationPath(from, to);
}));

app.get("/api/authors/:id", handle(async (req, res) => {
  const detail = await q.getAuthorDetail(req.params.id);
  if (!detail) {
    res.status(404).json({ error: "Author not found." });
    return undefined;
  }
  return detail;
}));

app.get("/api/authors/:id/collaborators", handle((req) => q.suggestCollaborators(req.params.id)));

app.get("/api/topics/:id", handle(async (req, res) => {
  const overview = await q.getTopicOverview(req.params.id);
  if (!overview) {
    res.status(404).json({ error: "Topic not found." });
    return undefined;
  }
  return overview;
}));

// SPA fallback for the static frontend
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

const PORT = process.env.PORT || 3000;

async function start() {
  app.listen(PORT, () => console.log(`Citation Compass listening on port ${PORT}`));
  try {
    await db.verifyConnectivity();
    console.log("Connected to CognoDB.");
  } catch (err) {
    console.warn(
      "Warning: could not connect to CognoDB at startup. The app is running, but API " +
        "requests will fail until the database is reachable. " + err.message
    );
  }
}

start();

process.on("SIGINT", async () => {
  await db.closeDriver();
  process.exit(0);
});
