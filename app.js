(async function () {
  const searchInput = document.getElementById("search");
  const dropdown = document.getElementById("dropdown");
  const results = document.getElementById("results");
  const loading = document.getElementById("loading");
  const greetingEl = document.getElementById("greeting");

  let fuse = null;
  let policies = [];
  let usersByEmail = {};
  let pagerdutyToken = null;
  let activeIndex = -1;

  // --- Init ---

  const [users, user, tokenDoc] = await Promise.all([
    fetchNDJSON("/users.json"),
    quick.id.waitForUser(),
    quick.db.collection("config").where({ key: "pagerduty_token" }).find(),
  ]);

  // Greeting
  if (user?.firstName) {
    greetingEl.textContent = `Hey ${user.firstName}, who's on call?`;
  }

  // PagerDuty token
  if (tokenDoc.length > 0) {
    pagerdutyToken = tokenDoc[0].value;
  } else {
    results.innerHTML = errorCard(
      "PagerDuty token not configured. An admin needs to seed it — see README."
    );
    return;
  }

  // Build user lookup by email
  for (const u of users) {
    if (u.email) {
      usersByEmail[u.email.toLowerCase()] = u;
    }
  }

  // Extract unique team names from Vault
  const teamSet = new Set();
  for (const u of users) {
    if (u.team_name) teamSet.add(u.team_name);
  }

  // Fetch all escalation policies from PagerDuty
  searchInput.placeholder = "Loading escalation policies...";
  policies = await fetchAllPolicies();

  // Build a unified search list: escalation policies + Vault team names
  // Each entry has { name, type, policyId? }
  const policyNames = new Set(policies.map((p) => p.name));
  const searchItems = policies.map((p) => ({ name: p.name, type: "policy", policyId: p.id }));

  // Add Vault team names that aren't already covered by a policy name
  for (const team of teamSet) {
    if (!policyNames.has(team)) {
      searchItems.push({ name: team, type: "team" });
    }
  }

  // Init Fuse.js on combined list
  fuse = new Fuse(searchItems, {
    keys: ["name"],
    threshold: 0.4,
    distance: 100,
    includeMatches: true,
  });

  searchInput.placeholder = `Search ${searchItems.length} teams & policies...`;
  searchInput.disabled = false;
  searchInput.focus();

  // --- Search / dropdown ---

  searchInput.addEventListener("input", () => {
    const query = searchInput.value.trim();
    activeIndex = -1;

    if (!query) {
      hideDropdown();
      return;
    }

    const matches = fuse.search(query).slice(0, 10);
    if (matches.length === 0) {
      hideDropdown();
      return;
    }

    dropdown.innerHTML = matches
      .map((m, i) => {
        const highlighted = highlightMatches(m.item.name, m.matches);
        const badge = m.item.type === "team" ? ' <span class="badge">team</span>' : "";
        return `<div class="dropdown-item" data-index="${i}" data-type="${m.item.type}" data-policy-id="${escapeAttr(m.item.policyId || "")}" data-name="${escapeAttr(m.item.name)}">${highlighted}${badge}</div>`;
      })
      .join("");
    dropdown.classList.remove("hidden");
  });

  // Keyboard nav
  searchInput.addEventListener("keydown", (e) => {
    const items = dropdown.querySelectorAll(".dropdown-item");
    if (!items.length) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, items.length - 1);
      updateActive(items);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      updateActive(items);
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      const item = items[activeIndex];
      selectItem(item.dataset);
    } else if (e.key === "Escape") {
      hideDropdown();
    }
  });

  // Click on dropdown item
  dropdown.addEventListener("click", (e) => {
    const item = e.target.closest(".dropdown-item");
    if (item) selectItem(item.dataset);
  });

  // Close dropdown on outside click
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-wrapper")) hideDropdown();
  });

  // --- Selection ---

  async function selectItem(dataset) {
    hideDropdown();
    const name = dataset.name;
    searchInput.value = name;
    results.innerHTML = "";
    loading.classList.remove("hidden");

    try {
      let oncalls;

      if (dataset.type === "policy" && dataset.policyId) {
        // Direct lookup by policy ID
        oncalls = await fetchOncallsByPolicyId(dataset.policyId);
      } else {
        // Vault team name — search PagerDuty by name
        oncalls = await fetchOncallsBySearch(name);
      }

      loading.classList.add("hidden");

      if (!oncalls || oncalls.length === 0) {
        // Suggest similar PagerDuty policies using Fuse on just policy entries
        const words = name.split(/[\s-]+/);
        const suggestions = [];
        for (const word of words) {
          if (word.length < 3) continue;
          const hits = fuse.search(word).filter((m) => m.item.type === "policy").slice(0, 3);
          for (const h of hits) {
            if (!suggestions.find((s) => s.id === h.item.policyId)) {
              suggestions.push({ id: h.item.policyId, name: h.item.name });
            }
          }
        }

        let html = messageCard(`No on-call schedule found for "${name}".`);
        if (suggestions.length > 0) {
          html += `<div class="message-card" style="margin-top:12px;text-align:left">
            <p style="font-size:13px;font-weight:600;margin-bottom:8px">Did you mean one of these?</p>
            ${suggestions.slice(0, 5).map((s) => `<div class="suggestion" data-policy-id="${escapeAttr(s.id)}" data-name="${escapeAttr(s.name)}">${escapeHtml(s.name)}</div>`).join("")}
          </div>`;
        }
        results.innerHTML = html;

        // Make suggestions clickable
        results.querySelectorAll(".suggestion").forEach((el) => {
          el.addEventListener("click", () => selectItem({ type: "policy", policyId: el.dataset.policyId, name: el.dataset.name }));
        });
        return;
      }

      results.innerHTML = oncalls.map(renderOncallCard).join("");
    } catch (err) {
      loading.classList.add("hidden");
      results.innerHTML = errorCard(`Error looking up on-call: ${err.message}`);
    }
  }

  // --- PagerDuty API ---

  async function fetchAllPolicies() {
    const all = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const resp = await quick.http.get(
        `https://api.pagerduty.com/escalation_policies?limit=${limit}&offset=${offset}&sort_by=name`,
        { headers: pdHeaders() }
      );
      const data = await resp.json();
      const batch = data.escalation_policies || [];
      all.push(...batch);

      if (batch.length < limit) break;
      offset += limit;
    }

    return all;
  }

  async function fetchOncallsByPolicyId(policyId) {
    const resp = await quick.http.get(
      `https://api.pagerduty.com/oncalls?escalation_policy_ids[]=${policyId}`,
      { headers: pdHeaders() }
    );
    const data = await resp.json();
    return dedupeOncalls(data.oncalls || []);
  }

  async function fetchOncallsBySearch(teamName) {
    const epResp = await quick.http.get(
      `https://api.pagerduty.com/escalation_policies?query=${encodeURIComponent(teamName)}`,
      { headers: pdHeaders() }
    );
    const epData = await epResp.json();
    const eps = epData.escalation_policies || [];

    if (eps.length === 0) return [];

    const params = eps.map((ep) => `escalation_policy_ids[]=${ep.id}`).join("&");
    const resp = await quick.http.get(
      `https://api.pagerduty.com/oncalls?${params}`,
      { headers: pdHeaders() }
    );
    const data = await resp.json();
    return dedupeOncalls(data.oncalls || []);
  }

  function dedupeOncalls(oncalls) {
    const seen = new Map();
    for (const oc of oncalls) {
      const key = `${oc.user.id}-${oc.escalation_policy.id}`;
      if (!seen.has(key) || oc.escalation_level < seen.get(key).escalation_level) {
        seen.set(key, oc);
      }
    }
    return [...seen.values()];
  }

  function pdHeaders() {
    return {
      Authorization: `Token token=${pagerdutyToken}`,
      "Content-Type": "application/json",
    };
  }

  // --- Rendering ---

  function renderOncallCard(oncall) {
    const pdUser = oncall.user;
    const email = (pdUser.email || "").toLowerCase();
    const vaultUser = usersByEmail[email];

    const name = vaultUser?.name || pdUser.summary || pdUser.name || "Unknown";
    const title = vaultUser?.title || "";
    const avatar = vaultUser?.slack_image_url || "";
    const slack = vaultUser?.slack_handle || "";
    const schedule = oncall.schedule?.summary || "";
    const policyName = oncall.escalation_policy?.summary || "";
    const level = oncall.escalation_level || 1;
    const endRaw = oncall.end;

    const levelLabel =
      level === 1 ? "Primary" : level === 2 ? "Secondary" : `Level ${level}`;
    const endStr = endRaw ? formatEnd(endRaw) : "";

    const avatarEl = avatar
      ? `<img class="avatar" src="${escapeAttr(avatar)}" alt="">`
      : `<div class="avatar"></div>`;

    const metaParts = [];
    if (slack) metaParts.push(`<span>@${escapeHtml(slack)}</span>`);
    if (endStr) metaParts.push(`<span>Until ${endStr}</span>`);

    return `
      <div>
        <div class="schedule-label">${escapeHtml(policyName)}${schedule ? ` — ${escapeHtml(schedule)}` : ""} (${levelLabel})</div>
        <div class="oncall-card">
          ${avatarEl}
          <div class="info">
            <div class="name">${escapeHtml(name)}</div>
            ${title ? `<div class="title-text">${escapeHtml(title)}</div>` : ""}
            <div class="meta">${metaParts.join("")}</div>
          </div>
        </div>
      </div>
    `;
  }

  function messageCard(text) {
    return `<div class="message-card"><p>${escapeHtml(text)}</p></div>`;
  }

  function errorCard(text) {
    return `<div class="message-card error"><p>${escapeHtml(text)}</p></div>`;
  }

  // --- Helpers ---

  async function fetchNDJSON(path) {
    const resp = await fetch(path);
    const text = await resp.text();
    return text.trim().split("\n").map(JSON.parse);
  }

  function highlightMatches(text, matches) {
    if (!matches || !matches.length) return escapeHtml(text);
    // Find the match for the "name" key
    const match = matches.find((m) => m.key === "name") || matches[0];
    const indices = match.indices;
    const chars = [...text];
    const result = [];
    let pos = 0;

    const sorted = [...indices].sort((a, b) => a[0] - b[0]);
    for (const [start, end] of sorted) {
      if (pos < start) result.push(escapeHtml(chars.slice(pos, start).join("")));
      result.push(`<mark>${escapeHtml(chars.slice(start, end + 1).join(""))}</mark>`);
      pos = end + 1;
    }
    if (pos < chars.length) result.push(escapeHtml(chars.slice(pos).join("")));
    return result.join("");
  }

  function formatEnd(iso) {
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  }

  function hideDropdown() {
    dropdown.classList.add("hidden");
    dropdown.innerHTML = "";
    activeIndex = -1;
  }

  function updateActive(items) {
    items.forEach((el, i) => {
      el.classList.toggle("active", i === activeIndex);
    });
    if (items[activeIndex]) {
      items[activeIndex].scrollIntoView({ block: "nearest" });
    }
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
})();
