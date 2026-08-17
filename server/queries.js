// server/queries.js
//
// Every query here is parameterised (no string concatenation) and runs
// through db.runQuery, which uses the official Neo4j driver's session API.
//
// Graph data model
// -----------------
// (:Author {id, name, affiliation, hIndex})
// (:Paper  {id, title, year, abstract, citationCount})
// (:Venue  {id, name, kind})            kind = "conference" | "journal"
// (:Topic  {id, name})
//
// (:Author)-[:AUTHORED]->(:Paper)
// (:Paper)-[:CITES]->(:Paper)
// (:Paper)-[:PUBLISHED_IN]->(:Venue)
// (:Paper)-[:ABOUT]->(:Topic)

const neo4j = require("neo4j-driver");
const { runQuery } = require("./db");

// The driver returns integer-typed properties (year, citationCount, hIndex,
// etc.) as Neo4j Integer objects rather than plain JS numbers, so they need
// converting before they hit JSON.stringify — otherwise they serialise as
// "[object Object]" in the response instead of a number.
function convertValue(value) {
  if (neo4j.isInt(value)) return value.toNumber();
  if (Array.isArray(value)) return value.map(convertValue);
  return value;
}

function toPlain(node) {
  if (node === null || node === undefined) return null;
  const props = {};
  for (const [key, value] of Object.entries(node.properties)) {
    props[key] = convertValue(value);
  }
  return props;
}

// ---------------------------------------------------------------------
// Dashboard / overview
// ---------------------------------------------------------------------

async function getStats() {
  const records = await runQuery(`
    MATCH (p:Paper) WITH count(p) AS papers
    MATCH (a:Author) WITH papers, count(a) AS authors
    MATCH (:Paper)-[c:CITES]->(:Paper) WITH papers, authors, count(c) AS citations
    MATCH (t:Topic) WITH papers, authors, citations, count(t) AS topics
    RETURN papers, authors, citations, topics
  `);
  if (!records.length) return { papers: 0, authors: 0, citations: 0, topics: 0 };
  const r = records[0];
  return {
    papers: r.get("papers").toNumber(),
    authors: r.get("authors").toNumber(),
    citations: r.get("citations").toNumber(),
    topics: r.get("topics").toNumber(),
  };
}

async function listTopics() {
  const records = await runQuery(
    `MATCH (t:Topic) RETURN t ORDER BY t.name`
  );
  return records.map((r) => toPlain(r.get("t")));
}

// ---------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------

async function searchPapers(term, limit = 15) {
  const records = await runQuery(
    `
    MATCH (p:Paper)
    WHERE toLower(p.title) CONTAINS toLower($term)
    OPTIONAL MATCH (a:Author)-[:AUTHORED]->(p)
    WITH p, collect(DISTINCT a.name) AS authorNames
    RETURN p, authorNames
    ORDER BY p.citationCount DESC
    LIMIT $limit
    `,
    { term, limit: neo4jInt(limit) }
  );
  return records.map((r) => ({
    ...toPlain(r.get("p")),
    authorNames: r.get("authorNames"),
  }));
}

async function searchAuthors(term, limit = 15) {
  const records = await runQuery(
    `
    MATCH (a:Author)
    WHERE toLower(a.name) CONTAINS toLower($term)
    OPTIONAL MATCH (a)-[:AUTHORED]->(p:Paper)
    WITH a, count(p) AS paperCount
    RETURN a, paperCount
    ORDER BY paperCount DESC
    LIMIT $limit
    `,
    { term, limit: neo4jInt(limit) }
  );
  return records.map((r) => ({
    ...toPlain(r.get("a")),
    paperCount: r.get("paperCount").toNumber(),
  }));
}

// ---------------------------------------------------------------------
// Paper detail (1-hop fan-out, aggregated)
// ---------------------------------------------------------------------

async function getPaperDetail(paperId) {
  const records = await runQuery(
    `
    MATCH (p:Paper {id: $paperId})
    OPTIONAL MATCH (a:Author)-[:AUTHORED]->(p)
    OPTIONAL MATCH (p)-[:PUBLISHED_IN]->(v:Venue)
    OPTIONAL MATCH (p)-[:ABOUT]->(t:Topic)
    OPTIONAL MATCH (p)-[:CITES]->(cited:Paper)
    OPTIONAL MATCH (citing:Paper)-[:CITES]->(p)
    RETURN p,
           collect(DISTINCT a)      AS authors,
           v,
           collect(DISTINCT t)      AS topics,
           collect(DISTINCT cited)  AS cites,
           collect(DISTINCT citing) AS citedBy
    `,
    { paperId }
  );
  if (!records.length || !records[0].get("p")) return null;
  const r = records[0];
  return {
    paper: toPlain(r.get("p")),
    authors: r.get("authors").map(toPlain),
    venue: toPlain(r.get("v")),
    topics: r.get("topics").map(toPlain),
    cites: r.get("cites").filter(Boolean).map(toPlain),
    citedBy: r.get("citedBy").filter(Boolean).map(toPlain),
  };
}

// ---------------------------------------------------------------------
// Multi-hop: local citation network around a paper, for graph visualisation
// ---------------------------------------------------------------------

async function getCitationNetwork(paperId, hops = 2) {
  const h = Math.min(Math.max(Number(hops) || 2, 1), 3); // clamp 1..3

  const nodeRecords = await runQuery(
    `
    MATCH (center:Paper {id: $paperId})
    MATCH path = (center)-[:CITES*1..${h}]-(other:Paper)
    UNWIND nodes(path) AS n
    RETURN DISTINCT n
    LIMIT 150
    `,
    { paperId }
  );

  const edgeRecords = await runQuery(
    `
    MATCH (center:Paper {id: $paperId})
    MATCH path = (center)-[:CITES*1..${h}]-(:Paper)
    UNWIND relationships(path) AS rel
    WITH DISTINCT startNode(rel) AS s, endNode(rel) AS t
    RETURN s.id AS source, t.id AS target
    LIMIT 300
    `,
    { paperId }
  );

  return {
    nodes: nodeRecords.map((r) => toPlain(r.get("n"))),
    edges: edgeRecords.map((r) => ({ source: r.get("source"), target: r.get("target") })),
  };
}

// ---------------------------------------------------------------------
// Multi-hop: shortest citation path between two papers (2+ hops)
// ---------------------------------------------------------------------

async function findCitationPath(fromId, toId, maxHops = 6) {
  const h = Math.min(Math.max(Number(maxHops) || 6, 1), 10);
  const records = await runQuery(
    `
    MATCH (a:Paper {id: $fromId}), (b:Paper {id: $toId})
    MATCH path = shortestPath((a)-[:CITES*1..${h}]-(b))
    RETURN [n IN nodes(path) | n] AS nodes, length(path) AS hops
    `,
    { fromId, toId }
  );
  if (!records.length) return null;
  const r = records[0];
  return {
    hops: r.get("hops").toNumber(),
    nodes: r.get("nodes").map(toPlain),
  };
}

// ---------------------------------------------------------------------
// Author detail: profile plus everything they've authored
// ---------------------------------------------------------------------

async function getAuthorDetail(authorId) {
  const records = await runQuery(
    `
    MATCH (a:Author {id: $authorId})
    OPTIONAL MATCH (a)-[:AUTHORED]->(p:Paper)
    OPTIONAL MATCH (p)-[:PUBLISHED_IN]->(v:Venue)
    RETURN a, collect(DISTINCT {paper: p, venueName: v.name}) AS papers
    `,
    { authorId }
  );
  if (!records.length || !records[0].get("a")) return null;
  const r = records[0];
  const papers = r
    .get("papers")
    .filter((row) => row.paper)
    .map((row) => ({ ...toPlain(row.paper), venueName: row.venueName }))
    .sort((x, y) => (y.year || 0) - (x.year || 0));
  return { author: toPlain(r.get("a")), papers };
}

// ---------------------------------------------------------------------
// Collaborator suggestions: co-authors of co-authors, excluding people
// the author has already published with. This is a natural 2-hop graph
// traversal — the relational equivalent needs two self-joins on a
// bridge table and gets unreadable fast.
// ---------------------------------------------------------------------

async function suggestCollaborators(authorId, limit = 8) {
  const records = await runQuery(
    `
    MATCH (me:Author {id: $authorId})-[:AUTHORED]->(:Paper)<-[:AUTHORED]-(direct:Author)
    WITH me, collect(DISTINCT direct) AS directCollaborators
    MATCH (me)-[:AUTHORED]->(:Paper)<-[:AUTHORED]-(:Author)-[:AUTHORED]->(:Paper)<-[:AUTHORED]-(candidate:Author)
    WHERE NOT candidate IN directCollaborators AND candidate <> me
    WITH candidate, count(DISTINCT candidate) AS strength
    OPTIONAL MATCH (candidate)-[:AUTHORED]->(:Paper)-[:ABOUT]->(t:Topic)
    WITH candidate, strength, collect(DISTINCT t.name) AS topics
    RETURN candidate, strength, topics
    ORDER BY strength DESC
    LIMIT $limit
    `,
    { authorId, limit: neo4jInt(limit) }
  );
  return records.map((r) => ({
    author: toPlain(r.get("candidate")),
    sharedPathStrength: r.get("strength").toNumber(),
    topics: r.get("topics"),
  }));
}

// ---------------------------------------------------------------------
// Co-cited papers: papers frequently cited alongside a given paper by
// the same third papers. Awkward relationally — it's a self-join on the
// citations table grouped by shared target, which balloons in SQL; in
// Cypher it's a direct pattern match.
// ---------------------------------------------------------------------

async function coCitedPapers(paperId, minShared = 1, limit = 10) {
  const records = await runQuery(
    `
    MATCH (p:Paper {id: $paperId})<-[:CITES]-(citer:Paper)-[:CITES]->(other:Paper)
    WHERE other.id <> $paperId
    WITH other, count(DISTINCT citer) AS sharedCiters
    WHERE sharedCiters >= $minShared
    RETURN other, sharedCiters
    ORDER BY sharedCiters DESC, other.citationCount DESC
    LIMIT $limit
    `,
    { paperId, minShared: neo4jInt(minShared), limit: neo4jInt(limit) }
  );
  return records.map((r) => ({
    paper: toPlain(r.get("other")),
    sharedCiters: r.get("sharedCiters").toNumber(),
  }));
}

// ---------------------------------------------------------------------
// Topic overview
// ---------------------------------------------------------------------

async function getTopicOverview(topicId, limit = 20) {
  const records = await runQuery(
    `
    MATCH (t:Topic {id: $topicId})<-[:ABOUT]-(p:Paper)
    OPTIONAL MATCH (a:Author)-[:AUTHORED]->(p)
    WITH t, p, collect(DISTINCT a.name) AS authorNames
    RETURN t, p, authorNames
    ORDER BY p.citationCount DESC
    LIMIT $limit
    `,
    { topicId, limit: neo4jInt(limit) }
  );
  if (!records.length) return null;
  const topic = toPlain(records[0].get("t"));
  const papers = records.map((r) => ({
    ...toPlain(r.get("p")),
    authorNames: r.get("authorNames"),
  }));
  return { topic, papers };
}

function neo4jInt(n) {
  const neo4j = require("neo4j-driver");
  return neo4j.int(n);
}

module.exports = {
  getStats,
  listTopics,
  searchPapers,
  searchAuthors,
  getPaperDetail,
  getCitationNetwork,
  findCitationPath,
  suggestCollaborators,
  coCitedPapers,
  getTopicOverview,
  getAuthorDetail,
};