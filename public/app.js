// public/app.js — no build step, plain DOM + fetch, hash-based routing.
(function () {
  const appEl = document.getElementById("app");
  const statsEl = document.getElementById("stats-strip");

  const TOPIC_COLORS = {
    "t-nlp": "#e0b85c", "t-cv": "#4f8c7d", "t-dl": "#8fb3e0",
    "t-rl": "#b2563e", "t-opt": "#c69a3b", "t-gen": "#c07fc7",
    "t-attn": "#e0955c", "t-arch": "#7fb8c0", "t-repr": "#9fd6c4",
    "t-compress": "#a8a0d6",
  };

  function esc(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  async function api(path) {
    const res = await fetch(path);
    let body;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok) {
      const err = new Error((body && body.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  function skeleton(n = 3) {
    return `<div>${Array.from({ length: n }).map(() => `<div class="skeleton-card"></div>`).join("")}</div>`;
  }

  function stateBlock(message, isError) {
    return `<div class="state-block${isError ? " error" : ""}">${esc(message)}</div>`;
  }

  // ---------------------------------------------------------------------
  // Stats strip
  // ---------------------------------------------------------------------
  async function loadStats() {
    try {
      const s = await api("/api/stats");
      statsEl.innerHTML = `
        <span class="stat-tile"><strong>${s.papers}</strong> papers</span>
        <span class="stat-tile"><strong>${s.authors}</strong> authors</span>
        <span class="stat-tile"><strong>${s.citations}</strong> citations</span>
        <span class="stat-tile"><strong>${s.topics}</strong> topics</span>
      `;
    } catch {
      statsEl.innerHTML = `<span class="small-muted">database unreachable</span>`;
    }
  }

  // ---------------------------------------------------------------------
  // Card renderers
  // ---------------------------------------------------------------------
  function paperCard(p) {
    const authorNames = p.authorNames || [];
    return `
      <div class="card clickable-card" data-nav="#/paper/${esc(p.id)}">
        <a class="card-title-link" href="#/paper/${esc(p.id)}">
          <div class="card-title">${esc(p.title)}</div>
        </a>
        <div class="card-meta">
          <span>${esc(p.year)}</span>
          <span>${esc(p.citationCount ?? 0)} citations</span>
        </div>
        ${authorNames.length ? `<div class="card-authors">${esc(authorNames.join(", "))}</div>` : ""}
      </div>
    `;
  }

  function authorCard(a) {
    return `
      <div class="card clickable-card" data-nav="#/author/${esc(a.id)}">
        <a class="card-title-link" href="#/author/${esc(a.id)}">
          <div class="card-title">${esc(a.name)}</div>
        </a>
        <div class="card-meta">
          <span>${esc(a.affiliation || "")}</span>
          <span>${esc(a.paperCount ?? 0)} papers</span>
        </div>
      </div>
    `;
  }

  function attachCardNav(container) {
    container.querySelectorAll("[data-nav]").forEach((c) => {
      c.addEventListener("click", (e) => {
        if (e.target.closest("a")) return; // let inner link handle it
        window.location.hash = c.getAttribute("data-nav");
      });
    });
  }

  // ---------------------------------------------------------------------
  // Home / search
  // ---------------------------------------------------------------------
  async function renderHome() {
    appEl.innerHTML = `
      <h1 class="page-title">Trace how ideas connect</h1>
      <p class="page-subtitle">Search papers or authors, then follow citations, collaborators and topics through the graph.</p>

      <div class="search-row">
        <input type="text" id="search-input" placeholder="Search papers or authors…" autocomplete="off" />
        <div class="mode-toggle">
          <button data-mode="papers" class="active">Papers</button>
          <button data-mode="authors">Authors</button>
        </div>
      </div>

      <div id="topic-chips" class="topic-chips"></div>
      <div id="results"></div>
    `;

    let mode = "papers";
    const input = document.getElementById("search-input");
    const resultsEl = document.getElementById("results");
    const toggleBtns = appEl.querySelectorAll(".mode-toggle button");

    toggleBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        mode = btn.dataset.mode;
        toggleBtns.forEach((b) => b.classList.toggle("active", b === btn));
        runSearch();
      });
    });

    async function runSearch() {
      const term = input.value.trim();
      if (!term) {
        resultsEl.innerHTML = `<p class="small-muted">Start typing to search, or pick a topic below.</p>`;
        return;
      }
      resultsEl.innerHTML = skeleton();
      try {
        const rows = mode === "papers"
          ? await api(`/api/search/papers?q=${encodeURIComponent(term)}`)
          : await api(`/api/search/authors?q=${encodeURIComponent(term)}`);
        if (!rows.length) {
          resultsEl.innerHTML = stateBlock(`No ${mode} match "${term}". Try a different term.`);
          return;
        }
        resultsEl.innerHTML = rows.map(mode === "papers" ? paperCard : authorCard).join("");
        attachCardNav(resultsEl);
      } catch (err) {
        resultsEl.innerHTML = stateBlock(err.message, true);
      }
    }

    input.addEventListener("input", debounce(runSearch, 250));
    resultsEl.innerHTML = `<p class="small-muted">Start typing to search, or pick a topic below.</p>`;

    try {
      const topics = await api("/api/topics");
      document.getElementById("topic-chips").innerHTML = topics
        .map((t) => `<a class="chip chip-topic" href="#/topic/${esc(t.id)}">${esc(t.name)}</a>`)
        .join("");
    } catch {
      document.getElementById("topic-chips").innerHTML = "";
    }
  }

  // ---------------------------------------------------------------------
  // Paper detail
  // ---------------------------------------------------------------------
  async function renderPaper(id) {
    appEl.innerHTML = `<a href="#/" class="back-link">← Back to search</a>` + skeleton(1);
    let detail;
    try {
      detail = await api(`/api/papers/${encodeURIComponent(id)}`);
    } catch (err) {
      appEl.innerHTML += stateBlock(err.message, true);
      return;
    }

    const { paper, authors, venue, topics, cites, citedBy } = detail;

    appEl.innerHTML = `
      <a href="#/" class="back-link">← Back to search</a>
      <div class="card">
        <div class="card-title" style="font-size:1.5rem">${esc(paper.title)}</div>
        <div class="card-meta">
          <span>${esc(paper.year)}</span>
          ${venue ? `<span class="chip chip-venue">${esc(venue.name)}</span>` : ""}
          <span>${esc(paper.citationCount ?? 0)} citations</span>
        </div>
        <hr class="card-inner-rule" />
        <p class="card-abstract">${esc(paper.abstract)}</p>
        <div class="card-chiprow">
          ${authors.map((a) => `<a class="chip chip-author" href="#/author/${esc(a.id)}">${esc(a.name)}</a>`).join("")}
          ${topics.map((t) => `<a class="chip chip-topic" href="#/topic/${esc(t.id)}">${esc(t.name)}</a>`).join("")}
        </div>
      </div>

      <div class="section-heading">Local citation network</div>
      <div id="graph-wrap" class="graph-panel"><div style="padding:16px" class="small-muted">Loading graph…</div></div>

      <div class="two-col">
        <div>
          <div class="section-heading">Cites (${cites.length})</div>
          ${cites.length ? cites.map(paperCard).join("") : stateBlock("This paper doesn't cite anything else in the dataset.")}
        </div>
        <div>
          <div class="section-heading">Cited by (${citedBy.length})</div>
          ${citedBy.length ? citedBy.map(paperCard).join("") : stateBlock("No later papers in the dataset cite this one yet.")}
        </div>
      </div>

      <div class="section-heading">Frequently co-cited with</div>
      <div id="co-cited">${skeleton(2)}</div>
    `;
    attachCardNav(appEl);

    // Force-directed local network
    api(`/api/papers/${encodeURIComponent(id)}/network?hops=2`)
      .then((net) => renderGraph(document.getElementById("graph-wrap"), net, id))
      .catch((err) => {
        document.getElementById("graph-wrap").innerHTML = stateBlock(err.message, true);
      });

    // Co-cited papers (relational-awkward query)
    api(`/api/papers/${encodeURIComponent(id)}/co-cited`)
      .then((rows) => {
        const el = document.getElementById("co-cited");
        if (!rows.length) {
          el.innerHTML = stateBlock("No other papers in the dataset share citation targets with this one.");
          return;
        }
        el.innerHTML = rows.map((row) => `
          <div class="card clickable-card" data-nav="#/paper/${esc(row.paper.id)}">
            <a class="card-title-link" href="#/paper/${esc(row.paper.id)}">
              <div class="card-title">${esc(row.paper.title)}</div>
            </a>
            <div class="card-meta">
              <span>${esc(row.paper.year)}</span>
              <span>shares ${esc(row.sharedCiters)} citing paper${row.sharedCiters === 1 ? "" : "s"}</span>
            </div>
          </div>
        `).join("");
        attachCardNav(el);
      })
      .catch((err) => {
        document.getElementById("co-cited").innerHTML = stateBlock(err.message, true);
      });
  }

  function renderGraph(container, net, centerId) {
    if (!net.nodes.length) {
      container.innerHTML = stateBlock("No citation links found within 2 hops of this paper.");
      return;
    }
    container.innerHTML = `<svg></svg><div class="graph-legend">
      <span><span class="legend-dot" style="background:#e0b85c"></span>this paper</span>
      <span><span class="legend-dot" style="background:#8fb3e0"></span>connected paper</span>
    </div>`;
    const svg = d3.select(container.querySelector("svg"));
    const width = container.clientWidth || 600, height = 360;
    svg.attr("viewBox", [0, 0, width, height]);

    const nodes = net.nodes.map((n) => ({ ...n }));
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const links = net.edges
      .filter((e) => nodeById.has(e.source) && nodeById.has(e.target))
      .map((e) => ({ ...e }));

    const sim = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(links).id((d) => d.id).distance(90).strength(0.5))
      .force("charge", d3.forceManyBody().strength(-160))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collide", d3.forceCollide(26));

    const link = svg.append("g")
      .attr("stroke", "#c69a3b").attr("stroke-opacity", 0.35)
      .selectAll("line").data(links).join("line")
      .attr("stroke-width", 1.2)
      .attr("marker-end", "url(#arrow)");

    svg.append("defs").append("marker")
      .attr("id", "arrow").attr("viewBox", "0 -4 8 8")
      .attr("refX", 20).attr("refY", 0).attr("markerWidth", 6).attr("markerHeight", 6)
      .attr("orient", "auto")
      .append("path").attr("d", "M0,-4L8,0L0,4").attr("fill", "#c69a3b").attr("opacity", 0.6);

    const node = svg.append("g")
      .selectAll("circle").data(nodes).join("circle")
      .attr("r", (d) => (d.id === centerId ? 9 : 6))
      .attr("fill", (d) => (d.id === centerId ? "#e0b85c" : "#8fb3e0"))
      .attr("stroke", "#0c1224").attr("stroke-width", 1.5)
      .style("cursor", "pointer")
      .on("click", (event, d) => { window.location.hash = `#/paper/${d.id}`; })
      .call(d3.drag()
        .on("start", (event, d) => { if (!event.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on("drag", (event, d) => { d.fx = event.x; d.fy = event.y; })
        .on("end", (event, d) => { if (!event.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));

    node.append("title").text((d) => d.title);

    const label = svg.append("g")
      .selectAll("text").data(nodes).join("text")
      .text((d) => (d.title.length > 28 ? d.title.slice(0, 26) + "…" : d.title))
      .attr("font-size", 9.5)
      .attr("fill", "#c9cfe4")
      .attr("font-family", "var(--font-body)")
      .attr("dx", 10).attr("dy", 3)
      .style("pointer-events", "none");

    sim.on("tick", () => {
      link.attr("x1", (d) => d.source.x).attr("y1", (d) => d.source.y)
          .attr("x2", (d) => d.target.x).attr("y2", (d) => d.target.y);
      node.attr("cx", (d) => d.x).attr("cy", (d) => d.y);
      label.attr("x", (d) => d.x).attr("y", (d) => d.y);
    });
  }

  // ---------------------------------------------------------------------
  // Author detail
  // ---------------------------------------------------------------------
  async function renderAuthor(id) {
    appEl.innerHTML = `<a href="#/" class="back-link">← Back to search</a>` + skeleton(1);
    let detail;
    try {
      detail = await api(`/api/authors/${encodeURIComponent(id)}`);
    } catch (err) {
      appEl.innerHTML += stateBlock(err.message, true);
      return;
    }
    const { author, papers } = detail;

    appEl.innerHTML = `
      <a href="#/" class="back-link">← Back to search</a>
      <div class="card">
        <div class="card-title" style="font-size:1.4rem">${esc(author.name)}</div>
        <div class="card-meta">
          <span>${esc(author.affiliation || "")}</span>
          <span>h-index ${esc(author.hIndex ?? "—")}</span>
          <span>${papers.length} paper${papers.length === 1 ? "" : "s"}</span>
        </div>
      </div>

      <div class="section-heading">Published</div>
      <div>${papers.length ? papers.map(paperCard).join("") : stateBlock("No papers on file for this author.")}</div>

      <div class="section-heading">Suggested collaborators</div>
      <p class="small-muted" style="margin-top:-4px">People two hops away in the co-authorship graph — co-authors of this author's co-authors — who haven't published with them directly yet.</p>
      <div id="collab">${skeleton(2)}</div>
    `;
    attachCardNav(appEl);

    api(`/api/authors/${encodeURIComponent(id)}/collaborators`)
      .then((rows) => {
        const el = document.getElementById("collab");
        if (!rows.length) {
          el.innerHTML = stateBlock("No second-degree collaborators found in the dataset.");
          return;
        }
        el.innerHTML = rows.map((row) => `
          <div class="card clickable-card" data-nav="#/author/${esc(row.author.id)}">
            <a class="card-title-link" href="#/author/${esc(row.author.id)}">
              <div class="card-title">${esc(row.author.name)}</div>
            </a>
            <div class="card-meta">
              <span>${esc(row.author.affiliation || "")}</span>
              <span>${esc(row.sharedPathStrength)} shared connection${row.sharedPathStrength === 1 ? "" : "s"}</span>
            </div>
            ${row.topics.length ? `<div class="card-chiprow">${row.topics.slice(0, 4).map((t) => `<span class="chip chip-topic">${esc(t)}</span>`).join("")}</div>` : ""}
          </div>
        `).join("");
        attachCardNav(el);
      })
      .catch((err) => {
        document.getElementById("collab").innerHTML = stateBlock(err.message, true);
      });
  }

  // ---------------------------------------------------------------------
  // Topic detail
  // ---------------------------------------------------------------------
  async function renderTopic(id) {
    appEl.innerHTML = `<a href="#/" class="back-link">← Back to search</a>` + skeleton(2);
    try {
      const { topic, papers } = await api(`/api/topics/${encodeURIComponent(id)}`);
      appEl.innerHTML = `
        <a href="#/" class="back-link">← Back to search</a>
        <h1 class="page-title">${esc(topic.name)}</h1>
        <p class="page-subtitle">${papers.length} papers, ranked by citation count.</p>
        <div>${papers.length ? papers.map(paperCard).join("") : stateBlock("No papers tagged with this topic yet.")}</div>
      `;
      attachCardNav(appEl);
    } catch (err) {
      appEl.innerHTML = stateBlock(err.message, true);
    }
  }

  // ---------------------------------------------------------------------
  // Path finder
  // ---------------------------------------------------------------------
  function renderPath() {
    appEl.innerHTML = `
      <h1 class="page-title">Citation path finder</h1>
      <p class="page-subtitle">Find the shortest chain of citations connecting two papers — a multi-hop traversal that's simple in Cypher and painful in SQL.</p>

      <div class="path-form">
        <div class="autocomplete">
          <label for="from-input">From</label>
          <input type="text" id="from-input" placeholder="Search a paper…" autocomplete="off" />
          <div id="from-list" class="autocomplete-list" hidden></div>
        </div>
        <div class="arrow">→</div>
        <div class="autocomplete">
          <label for="to-input">To</label>
          <input type="text" id="to-input" placeholder="Search a paper…" autocomplete="off" />
          <div id="to-list" class="autocomplete-list" hidden></div>
        </div>
        <button id="find-btn" disabled>Find path</button>
      </div>

      <div id="path-result"></div>
    `;

    const state = { from: null, to: null };
    setupAutocomplete("from-input", "from-list", (p) => { state.from = p; updateBtn(); });
    setupAutocomplete("to-input", "to-list", (p) => { state.to = p; updateBtn(); });

    const btn = document.getElementById("find-btn");
    function updateBtn() { btn.disabled = !(state.from && state.to); }

    btn.addEventListener("click", async () => {
      const resultEl = document.getElementById("path-result");
      resultEl.innerHTML = skeleton(1);
      try {
        const result = await api(`/api/path?from=${encodeURIComponent(state.from.id)}&to=${encodeURIComponent(state.to.id)}`);
        if (!result) {
          resultEl.innerHTML = stateBlock("No citation path connects these two papers within 10 hops.");
          return;
        }
        resultEl.innerHTML = `
          <div class="section-heading">${result.hops} hop${result.hops === 1 ? "" : "s"} apart</div>
          <div class="path-trail">
            ${result.nodes.map((n, i) => `
              ${i > 0 ? `<span class="path-arrow">→</span>` : ""}
              <a class="path-node" href="#/paper/${esc(n.id)}"><strong>${esc(n.title)}</strong>${esc(n.year)}</a>
            `).join("")}
          </div>
        `;
      } catch (err) {
        resultEl.innerHTML = stateBlock(err.message, true);
      }
    });
  }

  function setupAutocomplete(inputId, listId, onPick) {
    const input = document.getElementById(inputId);
    const list = document.getElementById(listId);

    const search = debounce(async () => {
      const term = input.value.trim();
      if (!term) { list.hidden = true; list.innerHTML = ""; return; }
      try {
        const rows = await api(`/api/search/papers?q=${encodeURIComponent(term)}&limit=8`);
        if (!rows.length) { list.hidden = true; return; }
        list.innerHTML = rows.map((p) => `<button type="button" data-id="${esc(p.id)}" data-title="${esc(p.title)}">${esc(p.title)} <span class="small-muted">(${esc(p.year)})</span></button>`).join("");
        list.hidden = false;
      } catch {
        list.hidden = true;
      }
    }, 220);

    input.addEventListener("input", search);
    list.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-id]");
      if (!btn) return;
      input.value = btn.dataset.title;
      list.hidden = true;
      onPick({ id: btn.dataset.id, title: btn.dataset.title });
    });
    document.addEventListener("click", (e) => {
      if (!list.contains(e.target) && e.target !== input) list.hidden = true;
    });
  }

  // ---------------------------------------------------------------------
  // Router
  // ---------------------------------------------------------------------
  function route() {
    const hash = window.location.hash || "#/";
    const [, segment, id] = hash.match(/^#\/([a-z]*)(?:\/([^/]+))?$/) || [];
    if (!segment) return renderHome();
    if (segment === "paper" && id) return renderPaper(decodeURIComponent(id));
    if (segment === "author" && id) return renderAuthor(decodeURIComponent(id));
    if (segment === "topic" && id) return renderTopic(decodeURIComponent(id));
    if (segment === "path") return renderPath();
    return renderHome();
  }

  window.addEventListener("hashchange", route);
  window.addEventListener("DOMContentLoaded", () => { loadStats(); route(); });
})();