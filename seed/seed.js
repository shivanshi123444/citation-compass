// seed/seed.js
//
// Loads seed/data.js into CognoDB. Safe to re-run: it clears existing
// data first, then recreates nodes, relationships and constraints.
//
// Usage:  npm run seed

require("dotenv").config();
const neo4j = require("neo4j-driver");
const { venues, topics, authors, papers } = require("./data");

const { COGNODB_URI, COGNODB_USER, COGNODB_PASSWORD } = process.env;

if (!COGNODB_URI || !COGNODB_USER || !COGNODB_PASSWORD) {
  console.error(
    "Missing COGNODB_URI / COGNODB_USER / COGNODB_PASSWORD.\n" +
      "Copy .env.example to .env and fill in your CognoDB Cloud connection details first."
  );
  process.exit(1);
}

async function main() {
  const driver = neo4j.driver(
    COGNODB_URI,
    neo4j.auth.basic(COGNODB_USER, COGNODB_PASSWORD)
  );

  try {
    console.log("Verifying connectivity to CognoDB...");
    await driver.verifyConnectivity();
    console.log("Connected.");

    const session = driver.session();
    try {
      console.log("Clearing existing data...");
      await session.run("MATCH (n) DETACH DELETE n");

      console.log("Creating uniqueness constraints...");
      for (const label of ["Paper", "Author", "Venue", "Topic"]) {
        await session.run(
          `CREATE CONSTRAINT IF NOT EXISTS FOR (n:${label}) REQUIRE n.id IS UNIQUE`
        );
      }

      console.log(`Loading ${venues.length} venues...`);
      await session.run(
        `UNWIND $rows AS row CREATE (:Venue {id: row.id, name: row.name, kind: row.kind})`,
        { rows: venues }
      );

      console.log(`Loading ${topics.length} topics...`);
      await session.run(
        `UNWIND $rows AS row CREATE (:Topic {id: row.id, name: row.name})`,
        { rows: topics }
      );

      console.log(`Loading ${authors.length} authors...`);
      await session.run(
        `UNWIND $rows AS row
         CREATE (:Author {id: row.id, name: row.name, affiliation: row.affiliation, hIndex: row.hIndex})`,
        { rows: authors }
      );

      console.log(`Loading ${papers.length} papers...`);
      await session.run(
        `UNWIND $rows AS row
         CREATE (:Paper {
           id: row.id, title: row.title, year: row.year,
           abstract: row.abstract, citationCount: 0
         })`,
        { rows: papers.map(({ id, title, year, abstract }) => ({ id, title, year, abstract })) }
      );

      console.log("Linking papers to venues...");
      await session.run(
        `UNWIND $rows AS row
         MATCH (p:Paper {id: row.paperId}), (v:Venue {id: row.venueId})
         CREATE (p)-[:PUBLISHED_IN]->(v)`,
        { rows: papers.map((p) => ({ paperId: p.id, venueId: p.venue })) }
      );

      console.log("Linking papers to topics...");
      const topicRows = papers.flatMap((p) =>
        p.topics.map((topicId) => ({ paperId: p.id, topicId }))
      );
      await session.run(
        `UNWIND $rows AS row
         MATCH (p:Paper {id: row.paperId}), (t:Topic {id: row.topicId})
         CREATE (p)-[:ABOUT]->(t)`,
        { rows: topicRows }
      );

      console.log("Linking authors to papers...");
      const authorRows = papers.flatMap((p) =>
        p.authors.map((authorId) => ({ paperId: p.id, authorId }))
      );
      await session.run(
        `UNWIND $rows AS row
         MATCH (p:Paper {id: row.paperId}), (a:Author {id: row.authorId})
         CREATE (a)-[:AUTHORED]->(p)`,
        { rows: authorRows }
      );

      console.log("Linking citations...");
      const citationRows = papers.flatMap((p) =>
        p.cites.map((citedId) => ({ paperId: p.id, citedId }))
      );
      await session.run(
        `UNWIND $rows AS row
         MATCH (p:Paper {id: row.paperId}), (c:Paper {id: row.citedId})
         CREATE (p)-[:CITES]->(c)`,
        { rows: citationRows }
      );

      console.log("Recomputing citationCount from actual :CITES edges...");
      await session.run(`
        MATCH (p:Paper)
        OPTIONAL MATCH (:Paper)-[:CITES]->(p)
        WITH p, count(*) AS c
        SET p.citationCount = c
      `);

      console.log("Seed complete.");
    } finally {
      await session.close();
    }
  } catch (err) {
    console.error("Seed failed:", err.message);
    process.exitCode = 1;
  } finally {
    await driver.close();
  }
}

main();
