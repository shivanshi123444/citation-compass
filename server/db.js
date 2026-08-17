// server/db.js
//
// Thin wrapper around the official Neo4j driver, pointed at a CognoDB Cloud
// instance. CognoDB speaks openCypher over Bolt, so the standard driver
// works unmodified — no custom SDK required.

const neo4j = require("neo4j-driver");

const { COGNODB_URI, COGNODB_USER, COGNODB_PASSWORD } = process.env;

let driver = null;
let driverError = null;

function getDriver() {
  if (driver || driverError) return driver;

  if (!COGNODB_URI || !COGNODB_USER || !COGNODB_PASSWORD) {
    driverError = new Error(
      "Missing COGNODB_URI, COGNODB_USER, or COGNODB_PASSWORD environment variables."
    );
    return null;
  }

  try {
    driver = neo4j.driver(
      COGNODB_URI,
      neo4j.auth.basic(COGNODB_USER, COGNODB_PASSWORD),
      { maxConnectionPoolSize: 20 }
    );
  } catch (err) {
    driverError = err;
    driver = null;
  }

  return driver;
}

// Verifies connectivity once at startup so we fail fast with a clear
// message instead of surfacing a cryptic error on the first request.
async function verifyConnectivity() {
  const d = getDriver();
  if (!d) throw driverError || new Error("Driver not configured.");
  await d.verifyConnectivity();
}

// Runs a single Cypher statement inside a managed session and always
// closes the session, even if the query throws.
async function runQuery(cypher, params = {}) {
  const d = getDriver();
  if (!d) {
    const err = new Error(
      "Database is not configured or unreachable. Check your CognoDB connection settings."
    );
    err.cause = driverError;
    throw err;
  }

  const session = d.session();
  try {
    const result = await session.run(cypher, params);
    return result.records;
  } finally {
    await session.close();
  }
}

async function closeDriver() {
  if (driver) await driver.close();
}

module.exports = { getDriver, verifyConnectivity, runQuery, closeDriver };
