# Citation Compass

A small web app for exploring how research ideas connect — citation chains, collaborator networks, and topic clusters — backed by **CognoDB**, a managed graph database.

> Built for the Wexa AI take-home assignment. Use case, data model, and code are my own; I used an AI coding assistant for parts of the implementation and can walk through and defend any part of it.

## The use case

**Citation Compass** lets you explore a graph of research papers: who wrote what, who cites whom, what topics a paper touches, and where the ideas trace back to. Given any two papers, it finds the shortest chain of citations between them. Given any author, it suggests people they haven't worked with yet but are two collaborations away from.

## Why a graph database?

A citation network is relationships wearing a data model. The questions that matter — *"How does idea A connect to idea B?"*, *"Who should this author meet?"*, *"What tends to get cited alongside this paper?"* — are all questions about paths and neighborhoods, not about rows.

In a relational schema, `CITES` would be a self-referencing join table on `papers`. Answering "is there a citation path of any length between paper A and paper B" means either:
- hardcoding a fixed number of self-joins (and still not knowing the true shortest path), or
- writing a recursive CTE that most engineers have to look up each time, and that gets slow as the depth grows.

In Cypher, it's one line: `MATCH path = shortestPath((a)-[:CITES*1..10]-(b))`. The same is true for "co-authors of co-authors" (collaborator suggestions) and "papers that share citation targets with this one" (co-cited papers) — both are 2–3 hop pattern matches in Cypher and multi-way self-joins with grouping in SQL. The graph model doesn't just make these queries shorter, it makes them the natural way to ask the question, which is the actual argument for reaching for a graph database here rather than a relational one.

## Data model

```
                 ┌────────────┐
                 │   Author   │
                 │ id, name,  │
                 │ affiliation│
                 │ hIndex     │
                 └─────┬──────┘
                       │ AUTHORED
                       ▼
┌──────────┐    ┌────────────┐    ABOUT     ┌──────────┐
│  Venue   │◄───┤   Paper    ├─────────────►│  Topic   │
│id, name, │PUB-│id, title,  │              │id, name  │
│kind      │LISH│year,       │              └──────────┘
│          │ED_ │abstract,   │
│          │IN  │citationCnt │
└──────────┘    └─────┬──────┘
                       │ CITES (self-referencing, directed)
                       ▼
                 ┌────────────┐
                 │   Paper    │
                 └────────────┘
```

**Nodes:** `Author`, `Paper`, `Venue`, `Topic`
**Relationships:** `(Author)-[:AUTHORED]->(Paper)`, `(Paper)-[:CITES]->(Paper)`, `(Paper)-[:PUBLISHED_IN]->(Venue)`, `(Paper)-[:ABOUT]->(Topic)`

The seed dataset (`seed/data.js`) is a curated set of 30 well-known machine-learning papers (LSTM through LLaMA), 42 authors, 10 venues, 10 topics, and 57 citation edges — enough to produce real multi-hop paths and non-trivial collaborator suggestions without needing a huge dataset to make the point.

## The queries that exercise the graph

All queries are parameterised and live in `server/queries.js`.

| Query | What it does | Why it matters |
|---|---|---|
| `getPaperDetail` | 1-hop fan-out: a paper's authors, venue, topics, what it cites, what cites it | Baseline aggregation across four relationship types in one round trip |
| `getCitationNetwork` | Variable-length traversal (`CITES*1..3`) around a paper | Multi-hop (2+), powers the force-directed graph view |
| `findCitationPath` | `shortestPath((a)-[:CITES*1..10]-(b))` between any two papers | Multi-hop, and the query relational databases handle worst — recursive, unbounded depth |
| `suggestCollaborators` | Co-authors of co-authors, excluding people already worked with | 3-hop pattern match; two self-joins on a bridge table in SQL |
| `coCitedPapers` | Papers that share citation targets with a given paper | Self-join + grouping in SQL; a direct pattern in Cypher |
| `getTopicOverview` | Papers under a topic, ranked by citations | Simple aggregation, included for completeness |

Example — the shortest citation path between two papers, run through the official Neo4j driver with parameters (never string-concatenated):

```js
const records = await runQuery(
  `MATCH (a:Paper {id: $fromId}), (b:Paper {id: $toId})
   MATCH path = shortestPath((a)-[:CITES*1..${h}]-(b))
   RETURN [n IN nodes(path) | n] AS nodes, length(path) AS hops`,
  { fromId, toId }
);
```

(The hop bound `${h}` is a clamped integer set server-side, not user input — Cypher doesn't support parameterising variable-length relationship bounds, so this is the accepted pattern for that one value; every id and limit that *can* be parameterised is.)

## Application

- **Backend:** Node.js + Express, official `neo4j-driver` (CognoDB speaks openCypher over Bolt, so the standard driver works unmodified).
- **Frontend:** a small hash-routed vanilla-JS single-page app (no build step) with a D3 force-directed graph for the citation network view.
- **Pages:** search (papers/authors + topic browsing), paper detail (with the local citation graph and co-cited papers), author detail (with collaborator suggestions), topic pages, and a citation path finder.
- Loading, empty, and error states are handled throughout — e.g. if CognoDB is unreachable, the API returns a 503 with a clear message instead of hanging or crashing, and the UI shows that inline.

## Project structure

```
citation-compass/
├── server/
│   ├── index.js       # Express app, routes, error handling
│   ├── db.js           # Neo4j driver wrapper, connectivity checks
│   └── queries.js      # All Cypher, parameterised
├── seed/
│   ├── data.js          # Seed dataset (authors, papers, venues, topics, citations)
│   └── seed.js           # Loads seed/data.js into CognoDB (idempotent — clears first)
├── public/
│   ├── index.html
│   ├── style.css
│   └── app.js            # Router + rendering + D3 graph
├── .env.example
└── package.json
```

## Setup

### 1. Create a CognoDB instance

1. Sign up at [console.cognodb.com/signup](https://console.cognodb.com/signup) (free tier, no card required).
2. Create a free `c0` instance and pick a region — provisioning takes under a minute.
3. Copy the connection URI (`bolt+s://<instance-id>.databases.cognodb.cloud`) and the generated password for user `cognodb`. **The password is shown once** — save it immediately.

### 2. Configure the app

```bash
git clone <this-repo-url>
cd citation-compass
npm install
cp .env.example .env
```

Edit `.env`:

```
COGNODB_URI=bolt+s://<your-instance-id>.databases.cognodb.cloud
COGNODB_USER=cognodb
COGNODB_PASSWORD=<your-generated-password>
PORT=3000
```

### 3. Seed the database

```bash
npm run seed
```

This clears any existing data, creates uniqueness constraints on `id` for each label, and loads the full dataset (authors, papers, venues, topics, and citation edges).

### 4. Run the app

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000).

## Deployment

The app is a single Node/Express process that also serves the static frontend, so it deploys as-is to any Node-friendly free host (Render, Railway, Fly.io, etc.):

1. Push this repo to GitHub.
2. Create a new web service on your host of choice, pointing at this repo.
3. Set the build command to `npm install` and the start command to `npm start`.
4. Add the three `COGNODB_*` environment variables from your `.env` in the host's dashboard (never commit `.env`).
5. Deploy, then run `npm run seed` once (locally, pointed at the same CognoDB instance — seeding only needs to happen once, not on every deploy).

## Screenshots

_Add screenshots of the search page, a paper detail page (with the citation graph), and the path finder here after you deploy and seed your own instance._

## Screen recording

_Add a link to a short screen recording here, walking through search → paper detail → citation graph → path finder → collaborator suggestions._

## Notes on the seed data

The seed dataset uses real, publicly documented paper titles, years, venues, and authorship (e.g. "Attention Is All You Need", Vaswani et al., NeurIPS 2017) because a demo graph is far more convincing with real, checkable relationships than invented ones. Abstracts are short original summaries written for this project, not copied from the papers. Citation edges are a simplified, illustrative subset of real citation relationships between these papers — chosen to produce a connected, multi-hop graph for the demo, not a complete or authoritative citation record.
