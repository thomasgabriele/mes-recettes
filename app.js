/* ============================================================
   Mes Recettes — logique de l'application
   Stockage : fichiers JSON dans /recipes sur un dépôt GitHub
   IA : appel direct au navigateur vers l'API Anthropic (Claude)
   ============================================================ */

const SETTINGS_KEY = "recettes.settings.v1";
const CLAUDE_MODEL = "claude-sonnet-5";
const RECIPES_PATH = "recipes";

let settings = loadSettings();
let currentRecipes = []; // cache { path, sha, data }
let pendingReview = null; // { source, data, editing? }
let reviewPhoto = ""; // URL ou data URL de la photo en cours d'édition
let reviewSteps = []; // [{ text, tip }] en cours d'édition
let reviewIngredients = []; // [{ quantity, unit, name }] en cours d'édition
let currentCategoryFilter = ""; // catégorie sélectionnée dans la liste ("" = toutes)
let currentDifficultyFilter = ""; // difficulté sélectionnée ("" = toutes)
let currentSearchQuery = "";
let currentPrepTimeMax = ""; // minutes, "" = toute durée
let selectedIndices = new Set();
let currentDetailIndex = null; // index de la recette affichée dans le panneau détail
let detailServings = null; // portions actuellement affichées dans le détail
let currentShoppingList = null; // { items: [...] }
let currentShoppingListSha = null;
let shoppingSaveTimer = null;

const DIFFICULTY_ORDER = ["Facile", "Moyen", "Difficile"];

/* ---------- Réglages ---------- */

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch {
    return {};
  }
}

function saveSettings(s) {
  settings = s;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

function hasSettings() {
  return settings.anthropicKey && settings.ghOwner && settings.ghRepo && settings.ghToken;
}

/* ---------- Utilitaires UI ---------- */

function $(id) { return document.getElementById(id); }

function showToast(msg, isError = false) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("error", isError);
  t.classList.remove("hidden");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.add("hidden"), 4000);
}

function openModal(id) { $(id).classList.remove("hidden"); }
function closeModal(id) { $(id).classList.add("hidden"); }

function showView(id) {
  document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
  $(id).classList.remove("hidden");
}

/* ---------- GitHub API ---------- */

function ghHeaders() {
  return {
    "Authorization": `Bearer ${settings.ghToken}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

function ghContentsUrl(path) {
  return `https://api.github.com/repos/${settings.ghOwner}/${settings.ghRepo}/contents/${path}`;
}

async function ghListRecipeFiles() {
  const res = await fetch(ghContentsUrl(RECIPES_PATH), { headers: ghHeaders() });
  if (res.status === 404) return []; // dossier pas encore créé = pas de recettes
  if (!res.ok) throw new Error(`GitHub (liste) : ${res.status} ${await res.text()}`);
  const list = await res.json();
  return list.filter(f => f.name.endsWith(".json"));
}

async function ghFetchJson(downloadUrl) {
  const res = await fetch(downloadUrl);
  if (!res.ok) throw new Error(`GitHub (fichier) : ${res.status}`);
  return res.json();
}

function utf8ToBase64(str) {
  return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g,
    (_, p1) => String.fromCharCode("0x" + p1)));
}

async function ghSaveFile(path, jsonData, existingSha) {
  const label = path.startsWith(RECIPES_PATH + "/") ? "recette" : "fichier";
  const body = {
    message: existingSha ? `Mise à jour ${label} : ${path}` : `Ajout ${label} : ${path}`,
    content: utf8ToBase64(JSON.stringify(jsonData, null, 2)),
  };
  if (existingSha) body.sha = existingSha;
  const res = await fetch(ghContentsUrl(path), {
    method: "PUT",
    headers: { ...ghHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`GitHub (sauvegarde) : ${res.status} ${await res.text()}`);
  return res.json();
}

async function ghDeleteFile(path, sha) {
  const res = await fetch(ghContentsUrl(path), {
    method: "DELETE",
    headers: { ...ghHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ message: `Suppression recette : ${path}`, sha })
  });
  if (!res.ok) throw new Error(`GitHub (suppression) : ${res.status} ${await res.text()}`);
}

async function ghGetFileRaw(path) {
  const res = await fetch(ghContentsUrl(path), { headers: ghHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub (lecture) : ${res.status} ${await res.text()}`);
  return res.json();
}

async function ghLoadShoppingList() {
  const existing = await ghGetFileRaw("shopping-list.json");
  if (!existing) return null;
  const content = decodeURIComponent(escape(atob(existing.content.replace(/\n/g, ""))));
  return { data: JSON.parse(content), sha: existing.sha };
}

async function ghSaveShoppingList(list) {
  let sha = currentShoppingListSha;
  try {
    const existing = await ghGetFileRaw("shopping-list.json");
    sha = existing ? existing.sha : null;
  } catch { /* on tente quand même l'écriture */ }
  const result = await ghSaveFile("shopping-list.json", list, sha);
  currentShoppingListSha = result?.content?.sha || null;
}

/* ---------- Appels à Claude ---------- */

async function callClaudeRaw(contentBlocks, { tools, maxTokens = 2000 } = {}) {
  const body = {
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: contentBlocks }]
  };
  if (tools) body.tools = tools;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": settings.anthropicKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API : ${res.status} ${errText}`);
  }
  const data = await res.json();
  return data.content.map(b => b.text || "").join("\n");
}

async function callClaude(contentBlocks) {
  const text = await callClaudeRaw(contentBlocks);
  const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error("Réponse IA illisible");
  }
}

async function findImageViaWebSearch(title) {
  if (!title) return "";
  try {
    const text = await callClaudeRaw([
      { type: "text", text: `Cherche sur le web une vraie photo du plat "${title}".
Privilégie les photos culinaires issues de blogs de cuisine ou de Wikimedia Commons. Évite les banques d'images payantes (iStock, Getty Images, Alamy, Shutterstock, Depositphotos) : elles bloquent l'affichage direct et leurs liens ne fonctionneront pas.
Si tu trouves un fichier sur Wikipédia ou Wikimedia Commons, donne l'URL sous la forme exacte https://commons.wikimedia.org/wiki/Special:FilePath/NOM_DE_FICHIER.EXT (le lien direct vers l'image, pas la page de description du fichier).
Réponds UNIQUEMENT avec l'URL directe de l'image (se terminant par .jpg, .jpeg, .png ou .webp), sans aucun autre texte, sans balises markdown. Si tu ne trouves vraiment rien d'utilisable, réponds exactement AUCUNE.` }
    ], { tools: [{ type: "web_search_20250305", name: "web_search" }], maxTokens: 1024 });
    const cleaned = text.trim().replace(/^["'\`]+|["'\`]+$/g, "");
    const match = cleaned.match(/https?:\/\/\S+?\.(?:jpg|jpeg|png|webp|gif)(?:\?\S*)?/i);
    if (match) return match[0].replace(/[)\].,;:!?'"]+$/, "");
    return "";
  } catch {
    return "";
  }
}

const EXTRACTION_INSTRUCTIONS = `Tu extrais une recette de cuisine et tu réponds UNIQUEMENT avec un objet JSON valide, sans texte avant ni après, sans balises markdown, selon exactement ce schéma :
{
  "title": "string",
  "servings": "string (ex: '4 personnes', vide si inconnu)",
  "baseServings": nombre entier correspondant (ex: 4), ou null si vraiment impossible à déterminer,
  "prepTime": "string (ex: '15 min', vide si inconnu)",
  "cookTime": "string (ex: '30 min', vide si inconnu)",
  "difficulty": "Facile" ou "Moyen" ou "Difficile" ou "" si vraiment impossible à estimer,
  "ingredients": [{"quantity": nombre ou null, "unit": "string (ex: 'g', 'ml', 'cuillères à soupe', vide si non pertinent)", "name": "string"}],
  "steps": ["string", "..."]
}
Pour chaque ingrédient, sépare la quantité numérique (quantity), l'unité (unit) et le nom (name). Ex: "200 g de farine" → {"quantity":200,"unit":"g","name":"farine"}. Si la quantité n'est pas un nombre exploitable (ex: "sel, au goût", "quelques feuilles de basilic"), mets quantity à null, unit à "" et name au texte complet de la ligne. Chaque étape est une phrase claire et complète. Si la difficulté n'est pas indiquée sur la source, déduis-la du nombre d'étapes et de la complexité des techniques utilisées (peu d'étapes et gestes simples → Facile ; techniques avancées, précision ou nombreuses étapes → Difficile). Si une information est absente de la source, laisse une chaîne vide (ou null) plutôt que d'inventer.`;

const IMAGE_EXTRA_INSTRUCTION = `
Ajoute aussi un champ "isDishPhoto": true si la photo montre le plat cuisiné fini (le résultat à manger), ou false si la photo montre autre chose (une recette écrite, un livre, un écran, un emballage, des ingrédients bruts, etc).`;

async function extractFromImage(base64, mediaType) {
  return callClaude([
    { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
    { type: "text", text: EXTRACTION_INSTRUCTIONS + IMAGE_EXTRA_INSTRUCTION }
  ]);
}

async function extractFromPageText(pageText, url) {
  const truncated = pageText.slice(0, 15000);
  return callClaude([
    { type: "text", text: `Voici le texte extrait d'une page web (${url}) qui contient une recette de cuisine, mêlé à d'autres contenus (menus, commentaires, publicités) que tu dois ignorer :\n\n${truncated}\n\n${EXTRACTION_INSTRUCTIONS}` }
  ]);
}

/* ---------- Récupération du contenu d'une page web ---------- */

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function extractImageUrl(doc, baseUrl) {
  const meta = doc.querySelector('meta[property="og:image"]') || doc.querySelector('meta[name="twitter:image"]');
  let src = meta?.getAttribute("content");
  if (!src) {
    const img = doc.querySelector("article img, main img, img");
    src = img?.getAttribute("src");
  }
  if (!src) return "";
  try { return new URL(src, baseUrl).href; } catch { return ""; }
}

async function fetchPageText(url) {
  const proxies = [
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    `https://thingproxy.freeboard.io/fetch/${url}`
  ];
  let lastErr;
  for (const proxyUrl of proxies) {
    try {
      const res = await fetchWithTimeout(proxyUrl, 15000);
      if (!res.ok) throw new Error(`${new URL(proxyUrl).hostname} : ${res.status}`);
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const imageUrl = extractImageUrl(doc, url);
      doc.querySelectorAll("script, style, nav, footer, header, noscript").forEach(el => el.remove());
      const text = doc.body ? doc.body.innerText : doc.documentElement.textContent;
      const cleaned = text.replace(/\n{2,}/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
      if (cleaned.length > 200) return { text: cleaned, imageUrl };
      lastErr = new Error("Contenu trop court");
    } catch (e) {
      lastErr = e;
    }
  }
  // Repli : service de lecture qui contourne mieux les protections anti-robot
  // de certains sites (renvoie du texte propre, mais pas la photo).
  try {
    const res = await fetchWithTimeout(`https://r.jina.ai/${url}`, 20000);
    if (res.ok) {
      const text = await res.text();
      const cleaned = text.replace(/\n{2,}/g, "\n").trim();
      if (cleaned.length > 200) return { text: cleaned, imageUrl: "" };
    } else {
      lastErr = new Error(`r.jina.ai : ${res.status}`);
    }
  } catch (e) {
    lastErr = e;
  }
  throw new Error(`Impossible de lire cette page (${lastErr?.message || "erreur inconnue"})`);
}

/* ---------- Redimensionnement d'image (avant envoi à l'IA) ---------- */

function readAndResizeImage(file, maxWidth = 1100, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Lecture du fichier impossible"));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width);
        const canvas = document.createElement("canvas");
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        resolve({ base64: dataUrl.split(",")[1], dataUrl });
      };
      img.onerror = () => reject(new Error("Image invalide"));
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ---------- Liste des recettes ---------- */

async function refreshRecipeList() {
  $("loading-state").classList.remove("hidden");
  $("app-layout").classList.add("hidden");
  $("empty-state").classList.add("hidden");
  try {
    const files = await ghListRecipeFiles();
    const recipes = await Promise.all(files.map(async f => ({
      path: f.path, sha: f.sha, data: await ghFetchJson(f.download_url)
    })));
    recipes.sort((a, b) => (b.data.createdAt || "").localeCompare(a.data.createdAt || ""));
    currentRecipes = recipes;
    renderRecipeGrid(recipes);
  } catch (e) {
    showToast("Erreur de chargement : " + e.message, true);
    $("loading-state").classList.add("hidden");
  }
}

function renderRecipeGrid(recipes) {
  $("loading-state").classList.add("hidden");
  $("list-toolbar").classList.toggle("hidden", recipes.length === 0);
  renderCategoryFilters(recipes);
  renderDifficultyFilters(recipes);
  applyRecipeFilter();
}

function getCategories(recipes) {
  return [...new Set(recipes.map(r => (r.data.category || "").trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "fr"));
}

const CATEGORY_PALETTE = [
  { bg: "#FBEFD9", fg: "#8A5A15" },
  { bg: "#E4EFE6", fg: "#2F6B45" },
  { bg: "#E8EEF7", fg: "#31537E" },
  { bg: "#F6E6EC", fg: "#8C3455" },
  { bg: "#EDE7F6", fg: "#5B3B8C" },
  { bg: "#FDEBE3", fg: "#9C4A22" },
  { bg: "#E3F2F1", fg: "#1F6B66" },
  { bg: "#F2E9DD", fg: "#6B4A28" }
];

function categoryColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return CATEGORY_PALETTE[hash % CATEGORY_PALETTE.length];
}

const DIFFICULTY_COLORS = {
  Facile: { bg: "#E4EFE6", fg: "#2F6B45" },
  Moyen: { bg: "#FBEFD9", fg: "#8A5A15" },
  Difficile: { bg: "#FBE4E1", fg: "#A23B2E" }
};

function badgePill(label, colors) {
  return `<span class="badge-pill" style="background:${colors.bg};color:${colors.fg}">${escapeHtml(label)}</span>`;
}

function renderChipBar(barEl, values, current, onPick, colorFn) {
  if (values.length === 0) {
    barEl.classList.add("hidden");
    barEl.innerHTML = "";
    return;
  }
  barEl.classList.remove("hidden");
  barEl.innerHTML = "";
  const makeChip = (label, value) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "category-chip" + (current === value ? " active" : "");
    chip.textContent = label;
    if (colorFn && value && current !== value) {
      const c = colorFn(value);
      chip.style.background = c.bg;
      chip.style.color = c.fg;
      chip.style.borderColor = "transparent";
    }
    chip.addEventListener("click", () => onPick(value));
    return chip;
  };
  barEl.appendChild(makeChip("Toutes", ""));
  values.forEach(v => barEl.appendChild(makeChip(v, v)));
}

function renderCategoryFilters(recipes) {
  const cats = getCategories(recipes);
  $("category-list").innerHTML = cats.map(c => `<option value="${escapeHtml(c)}"></option>`).join("");
  renderChipBar($("category-filters"), cats, currentCategoryFilter, (v) => {
    currentCategoryFilter = v;
    applyRecipeFilter();
    renderCategoryFilters(currentRecipes);
  }, categoryColor);
}

function renderDifficultyFilters(recipes) {
  const present = DIFFICULTY_ORDER.filter(d => recipes.some(r => r.data.difficulty === d));
  renderChipBar($("difficulty-filters"), present, currentDifficultyFilter, (v) => {
    currentDifficultyFilter = v;
    applyRecipeFilter();
    renderDifficultyFilters(currentRecipes);
  }, (d) => DIFFICULTY_COLORS[d]);
}

function matchesSearch(r, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  if ((r.data.title || "").toLowerCase().includes(q)) return true;
  if ((r.data.category || "").toLowerCase().includes(q)) return true;
  return (r.data.ingredients || []).some(ing => {
    const o = ingredientObj(ing);
    return (o.name || "").toLowerCase().includes(q);
  });
}

function applyRecipeFilter() {
  const recipes = currentRecipes;

  if (recipes.length === 0) {
    $("empty-state").classList.remove("hidden");
    $("app-layout").classList.add("hidden");
    return;
  }
  $("empty-state").classList.add("hidden");
  $("app-layout").classList.remove("hidden");

  const filtered = recipes.filter(r => {
    if (currentCategoryFilter && (r.data.category || "").trim() !== currentCategoryFilter) return false;
    if (currentDifficultyFilter && r.data.difficulty !== currentDifficultyFilter) return false;
    if (currentPrepTimeMax) {
      const minutes = parsePrepMinutes(r.data.prepTime);
      if (minutes == null || minutes > Number(currentPrepTimeMax)) return false;
    }
    if (!matchesSearch(r, currentSearchQuery)) return false;
    return true;
  });

  const grid = $("recipe-grid");
  grid.innerHTML = "";
  filtered.forEach((r) => {
    const index = currentRecipes.indexOf(r);
    const card = document.createElement("div");
    card.className = "recipe-card" + (index === currentDetailIndex ? " active" : "");
    const meta = [r.data.prepTime, r.data.cookTime, r.data.servings].filter(Boolean);
    const photoHtml = r.data.photo
      ? `<img class="recipe-card-thumb" src="${escapeHtml(r.data.photo)}" alt="">`
      : `<div class="recipe-card-thumb"></div>`;
    const categoryHtml = r.data.category ? badgePill(r.data.category, categoryColor(r.data.category)) : "";
    const difficultyHtml = r.data.difficulty ? badgePill(r.data.difficulty, DIFFICULTY_COLORS[r.data.difficulty]) : "";
    const badgesHtml = (categoryHtml || difficultyHtml) ? `<div class="card-badges">${categoryHtml}${difficultyHtml}</div>` : "";
    card.innerHTML = `
      <label class="recipe-card-checkbox"><input type="checkbox" data-index="${index}" ${selectedIndices.has(index) ? "checked" : ""}></label>
      ${photoHtml}
      <div class="recipe-card-info">
        ${badgesHtml}
        <h3>${escapeHtml(r.data.title || "Sans titre")}</h3>
        <div class="recipe-meta">${meta.map(m => `<span>${escapeHtml(m)}</span>`).join("")}</div>
      </div>
    `;
    card.querySelector(".recipe-card-checkbox").addEventListener("click", (e) => e.stopPropagation());
    card.querySelector(".recipe-card-checkbox input").addEventListener("change", () => toggleSelection(index));
    card.addEventListener("click", () => openRecipeDetail(index));
    grid.appendChild(card);
  });
}

function toggleSelection(index) {
  if (selectedIndices.has(index)) selectedIndices.delete(index);
  else selectedIndices.add(index);
  updateSelectionBar();
}

function updateSelectionBar() {
  const bar = $("selection-bar");
  if (selectedIndices.size === 0) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  $("selection-count").textContent = `${selectedIndices.size} sélectionnée(s)`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- Ingrédients : structure quantité / unité / nom ---------- */

function parseIngredientLine(raw) {
  const m = String(raw).match(/^(\d+(?:[.,]\d+)?)\s*([a-zA-Zàâäéèêëïîôöùûüç]*)\s*(?:de |d')?(.*)$/i);
  if (m && m[3]) {
    return { quantity: parseFloat(m[1].replace(",", ".")), unit: (m[2] || "").trim(), name: m[3].trim() };
  }
  return { quantity: null, unit: "", name: String(raw).trim() };
}

function ingredientObj(ing) {
  if (typeof ing === "string") return parseIngredientLine(ing);
  return { quantity: ing.quantity ?? null, unit: ing.unit || "", name: ing.name || "" };
}

function formatQty(q) {
  const rounded = Math.round(q * 100) / 100;
  return rounded.toFixed(2).replace(/\.?0+$/, "");
}

function formatIngredient(ing, ratio = 1) {
  const o = ingredientObj(ing);
  if (o.quantity == null) return o.name;
  const q = formatQty(o.quantity * ratio);
  return `${q}${o.unit ? " " + o.unit : ""} ${o.name}`.trim();
}

function parsePrepMinutes(text) {
  if (!text) return null;
  const hMatch = String(text).match(/(\d+)\s*h/i);
  const minMatch = String(text).match(/(\d+)\s*(min|minutes)/i);
  let total = 0;
  let found = false;
  if (hMatch) { total += parseInt(hMatch[1], 10) * 60; found = true; }
  if (minMatch) { total += parseInt(minMatch[1], 10); found = true; }
  if (!found) {
    const num = String(text).match(/(\d+)/);
    if (num) { total = parseInt(num[1], 10); found = true; }
  }
  return found ? total : null;
}

/* ---------- Détail d'une recette ---------- */

function stepText(s) { return typeof s === "string" ? s : (s.text || ""); }
function stepTip(s) { return typeof s === "string" ? "" : (s.tip || ""); }

function getBaseServings(d) {
  if (typeof d.baseServings === "number" && d.baseServings > 0) return d.baseServings;
  const m = String(d.servings || "").match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function openRecipeDetail(index) {
  currentDetailIndex = index;
  const r = currentRecipes[index];
  const base = getBaseServings(r.data);
  detailServings = base || null;
  renderRecipeDetailContent(r);
  $("detail-placeholder").classList.add("hidden");
  $("detail-content").classList.remove("hidden");
  $("detail-pane").classList.add("open");
  applyRecipeFilter();
}

function closeRecipeDetail() {
  currentDetailIndex = null;
  $("detail-pane").classList.remove("open");
  $("detail-placeholder").classList.remove("hidden");
  $("detail-content").classList.add("hidden");
  applyRecipeFilter();
}

function renderRecipeDetailContent(r) {
  const d = r.data;
  const base = getBaseServings(d);
  const ratio = (base && detailServings) ? detailServings / base : 1;
  const meta = [
    d.prepTime && `Préparation : ${d.prepTime}`,
    d.cookTime && `Cuisson : ${d.cookTime}`
  ].filter(Boolean);
  const categoryHtml = d.category ? badgePill(d.category, categoryColor(d.category)) : "";
  const difficultyHtml = d.difficulty ? badgePill(d.difficulty, DIFFICULTY_COLORS[d.difficulty]) : "";

  $("detail-content").innerHTML = `
    ${d.photo ? `<img class="detail-photo" src="${escapeHtml(d.photo)}" alt="">` : ""}
    <div class="detail-header">
      ${(categoryHtml || difficultyHtml) ? `<div class="card-badges">${categoryHtml}${difficultyHtml}</div>` : ""}
      <h2>${escapeHtml(d.title || "Sans titre")}</h2>
      <div class="detail-meta">${meta.map(m => `<span>${escapeHtml(m)}</span>`).join("")}</div>
      ${d.source && d.source.url ? `<div class="detail-source">Source : <a href="${escapeHtml(d.source.url)}" target="_blank" rel="noopener">${escapeHtml(d.source.url)}</a></div>` : ""}
      ${base ? `
        <div class="servings-adjust">
          <button id="btn-servings-minus" type="button">−</button>
          <span>${detailServings} personne${detailServings > 1 ? "s" : ""}</span>
          <button id="btn-servings-plus" type="button">+</button>
        </div>` : ""}
    </div>
    <div class="detail-section">
      <h4>INGRÉDIENTS</h4>
      <ul class="ingredient-list">${(d.ingredients || []).map(ing => `<li>${escapeHtml(formatIngredient(ing, ratio))}</li>`).join("")}</ul>
    </div>
    <div class="detail-section">
      <h4>ÉTAPES</h4>
      <ol class="step-list">${(d.steps || []).map(s => `<li>${escapeHtml(stepText(s))}${stepTip(s) ? `<div class="step-tip">💡 ${escapeHtml(stepTip(s))}</div>` : ""}</li>`).join("")}</ol>
    </div>
    <div class="detail-footer">
      <button class="btn btn-text" id="btn-edit-recipe">✏️ Modifier</button>
      <button class="btn btn-danger" id="btn-delete-recipe">Supprimer cette recette</button>
    </div>
  `;
  $("btn-delete-recipe").addEventListener("click", () => deleteCurrentRecipe(r));
  $("btn-edit-recipe").addEventListener("click", () => startEditRecipe(r));
  if (base) {
    $("btn-servings-minus").addEventListener("click", () => {
      detailServings = Math.max(1, detailServings - 1);
      renderRecipeDetailContent(r);
    });
    $("btn-servings-plus").addEventListener("click", () => {
      detailServings = detailServings + 1;
      renderRecipeDetailContent(r);
    });
  }
}

async function deleteCurrentRecipe(r) {
  if (!confirm(`Supprimer « ${r.data.title} » ? Cette action est définitive.`)) return;
  try {
    await ghDeleteFile(r.path, r.sha);
    showToast("Recette supprimée");
    closeRecipeDetail();
    refreshRecipeList();
  } catch (e) {
    showToast("Erreur : " + e.message, true);
  }
}

/* ---------- Import : flux commun ---------- */

function resetImportModal() {
  $("import-modal-title").textContent = "Importer une recette";
  $("import-choice").classList.remove("hidden");
  $("import-photo-form").classList.add("hidden");
  $("import-url-form").classList.add("hidden");
  $("import-loading").classList.add("hidden");
  $("import-review").classList.add("hidden");
  $("input-photo").value = "";
  $("input-url").value = "";
  $("review-photo-file").value = "";
  pendingReview = null;
  reviewPhoto = "";
  reviewSteps = [];
  reviewIngredients = [];
}

function setReviewPhoto(value) {
  reviewPhoto = value || "";
  const img = $("review-photo-img");
  const empty = $("review-photo-empty");
  if (reviewPhoto) {
    img.src = reviewPhoto;
    img.classList.remove("hidden");
    empty.classList.add("hidden");
  } else {
    img.classList.add("hidden");
    empty.classList.remove("hidden");
  }
}

function renderStepsEditor() {
  const container = $("review-steps-list");
  container.innerHTML = reviewSteps.map((step, i) => `
    <div class="step-edit-row">
      <div class="step-edit-header">
        <span class="step-edit-number">${i + 1}</span>
        <button type="button" class="btn btn-icon step-remove" data-index="${i}">✕</button>
      </div>
      <textarea class="step-edit-text" rows="2" data-index="${i}" placeholder="Décris l'étape...">${escapeHtml(step.text)}</textarea>
      <input type="text" class="step-edit-tip" data-index="${i}" placeholder="💡 Astuce (optionnel)" value="${escapeHtml(step.tip || "")}">
    </div>
  `).join("");
}

function renderIngredientsEditor() {
  const container = $("review-ingredients-list");
  container.innerHTML = reviewIngredients.map((ing, i) => `
    <div class="ingredient-edit-row">
      <input type="text" class="ingredient-edit-qty" data-index="${i}" placeholder="Qté" value="${escapeHtml(ing.quantity ?? "")}">
      <input type="text" class="ingredient-edit-unit" data-index="${i}" placeholder="Unité" value="${escapeHtml(ing.unit || "")}">
      <input type="text" class="ingredient-edit-name" data-index="${i}" placeholder="Ingrédient" value="${escapeHtml(ing.name || "")}">
      <button type="button" class="btn btn-icon ingredient-remove" data-index="${i}">✕</button>
    </div>
  `).join("");
}

function showReview(data, source) {
  pendingReview = { source, data };
  $("review-title").value = data.title || "";
  $("review-category").value = data.category || "";
  $("review-base-servings").value = getBaseServings(data) || "";
  $("review-prep").value = data.prepTime || "";
  $("review-cook").value = data.cookTime || "";
  $("review-difficulty").value = data.difficulty || "";
  reviewIngredients = (data.ingredients || []).map(ing => {
    const o = ingredientObj(ing);
    return { quantity: o.quantity ?? "", unit: o.unit || "", name: o.name || "" };
  });
  renderIngredientsEditor();
  reviewSteps = (data.steps || []).map(s => ({ text: stepText(s), tip: stepTip(s) }));
  renderStepsEditor();
  setReviewPhoto(data.photo || "");
  $("btn-save-recipe").textContent = "Enregistrer la recette";
  $("import-modal-title").textContent = "Importer une recette";
  $("import-loading").classList.add("hidden");
  $("import-review").classList.remove("hidden");
}

function startEditRecipe(r) {
  resetImportModal();
  showReview({ ...r.data }, r.data.source || {});
  pendingReview.editing = { path: r.path, sha: r.sha, createdAt: r.data.createdAt };
  $("import-choice").classList.add("hidden");
  $("btn-save-recipe").textContent = "Enregistrer les modifications";
  $("import-modal-title").textContent = "Modifier la recette";
  openModal("modal-import");
}

async function saveReviewedRecipe() {
  const now = new Date();
  const title = $("review-title").value.trim() || "Sans titre";
  const editing = pendingReview.editing;
  let path;
  if (editing) {
    path = editing.path;
  } else {
    const slug = title.toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || "recette";
    path = `${RECIPES_PATH}/${slug}-${now.getTime()}.json`;
  }

  const baseServingsVal = parseInt($("review-base-servings").value, 10);
  const recipe = {
    title,
    category: $("review-category").value.trim(),
    baseServings: Number.isFinite(baseServingsVal) && baseServingsVal > 0 ? baseServingsVal : null,
    servings: Number.isFinite(baseServingsVal) && baseServingsVal > 0 ? `${baseServingsVal} personnes` : "",
    prepTime: $("review-prep").value.trim(),
    cookTime: $("review-cook").value.trim(),
    difficulty: $("review-difficulty").value,
    ingredients: reviewIngredients
      .map(ing => ({
        quantity: ing.quantity === "" || ing.quantity == null ? null : parseFloat(String(ing.quantity).replace(",", ".")),
        unit: (ing.unit || "").trim(),
        name: (ing.name || "").trim()
      }))
      .filter(ing => ing.name),
    steps: reviewSteps
      .map(s => ({ text: s.text.trim(), tip: (s.tip || "").trim() }))
      .filter(s => s.text),
    photo: reviewPhoto,
    source: pendingReview.source,
    createdAt: editing ? editing.createdAt : now.toISOString()
  };
  if (editing) recipe.updatedAt = now.toISOString();

  try {
    $("btn-save-recipe").disabled = true;
    $("btn-save-recipe").textContent = editing ? "Enregistrement…" : "Enregistrement…";
    await ghSaveFile(path, recipe, editing ? editing.sha : null);
    showToast(editing ? "Recette mise à jour" : "Recette enregistrée");
    closeModal("modal-import");
    resetImportModal();
    closeRecipeDetail();
    refreshRecipeList();
  } catch (e) {
    showToast("Erreur : " + e.message, true);
  } finally {
    $("btn-save-recipe").disabled = false;
    $("btn-save-recipe").textContent = editing ? "Enregistrer les modifications" : "Enregistrer la recette";
  }
}

/* ---------- Liste de courses ---------- */

function buildShoppingList(recipes) {
  const map = new Map();
  const unmerged = [];
  recipes.forEach(r => {
    (r.data.ingredients || []).forEach(ing => {
      const o = ingredientObj(ing);
      if (!o.name) return;
      if (o.quantity != null) {
        const key = (o.unit || "").toLowerCase() + "|" + o.name.trim().toLowerCase();
        if (map.has(key)) {
          const entry = map.get(key);
          entry.quantity += o.quantity;
          entry.recipes.add(r.data.title || "Sans titre");
        } else {
          map.set(key, { quantity: o.quantity, unit: o.unit, name: o.name, recipes: new Set([r.data.title || "Sans titre"]), checked: false });
        }
      } else {
        unmerged.push({ quantity: null, unit: "", name: o.name, recipes: new Set([r.data.title || "Sans titre"]), checked: false });
      }
    });
  });
  const items = [...map.values(), ...unmerged].map(it => ({ ...it, recipes: [...it.recipes] }));
  items.sort((a, b) => a.name.localeCompare(b.name, "fr"));
  return items;
}

function renderShoppingList(list) {
  const container = $("shopping-list-items");
  if (!list || !list.items || list.items.length === 0) {
    container.innerHTML = "<p class='empty-sub'>Ta liste de courses est vide. Sélectionne des recettes depuis la liste pour en créer une.</p>";
    return;
  }
  container.innerHTML = list.items.map((it, i) => `
    <div class="shopping-item ${it.checked ? "checked" : ""}">
      <label class="shopping-item-main">
        <input type="checkbox" data-index="${i}" ${it.checked ? "checked" : ""}>
        <span>
          ${escapeHtml((it.quantity != null ? formatQty(it.quantity) + (it.unit ? " " + it.unit : "") + " " : "") + it.name)}
          <span class="shopping-item-recipes">${escapeHtml(it.recipes.join(", "))}</span>
        </span>
      </label>
      <button type="button" class="btn btn-icon shopping-item-remove" data-index="${i}" title="Supprimer">✕</button>
    </div>
  `).join("");
}

/* ---------- Export vers Rappels (iOS) ---------- */

function icsEscape(s) {
  return String(s).replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
}

function buildIcsFromShoppingList(list) {
  const now = new Date();
  const dtstamp = now.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Mes Recettes//Liste de courses//FR"
  ];
  (list.items || []).forEach((it, i) => {
    const label = (it.quantity != null ? formatQty(it.quantity) + (it.unit ? " " + it.unit : "") + " " : "") + it.name;
    lines.push("BEGIN:VTODO");
    lines.push(`UID:mesrecettes-${now.getTime()}-${i}@mesrecettes`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`SUMMARY:${icsEscape(label)}`);
    if (it.checked) {
      lines.push("STATUS:COMPLETED");
      lines.push("PERCENT-COMPLETE:100");
    } else {
      lines.push("STATUS:NEEDS-ACTION");
    }
    lines.push("END:VTODO");
  });
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

function exportShoppingListToIcs() {
  if (!currentShoppingList || !currentShoppingList.items || currentShoppingList.items.length === 0) {
    showToast("Liste vide", true);
    return;
  }
  const ics = buildIcsFromShoppingList(currentShoppingList);
  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "liste-de-courses.ics";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ---------- Câblage des événements ---------- */

function wireEvents() {
  $("btn-add").addEventListener("click", () => { resetImportModal(); openModal("modal-import"); });
  $("btn-add-empty").addEventListener("click", () => { resetImportModal(); openModal("modal-import"); });
  $("btn-settings").addEventListener("click", () => {
    $("input-anthropic-key").value = settings.anthropicKey || "";
    $("input-gh-owner").value = settings.ghOwner || "";
    $("input-gh-repo").value = settings.ghRepo || "";
    $("input-gh-token").value = settings.ghToken || "";
    openModal("modal-settings");
  });
  $("btn-close-detail").addEventListener("click", () => closeRecipeDetail());

  document.querySelectorAll("[data-close-modal]").forEach(btn => {
    btn.addEventListener("click", (e) => e.target.closest(".modal-overlay").classList.add("hidden"));
  });

  $("btn-save-settings").addEventListener("click", () => {
    const s = {
      anthropicKey: $("input-anthropic-key").value.trim(),
      ghOwner: $("input-gh-owner").value.trim(),
      ghRepo: $("input-gh-repo").value.trim(),
      ghToken: $("input-gh-token").value.trim()
    };
    if (!s.anthropicKey || !s.ghOwner || !s.ghRepo || !s.ghToken) {
      showToast("Merci de remplir tous les champs", true);
      return;
    }
    saveSettings(s);
    closeModal("modal-settings");
    showToast("Réglages enregistrés");
    refreshRecipeList();
  });

  $("opt-photo").addEventListener("click", () => {
    $("import-choice").classList.add("hidden");
    $("import-photo-form").classList.remove("hidden");
  });
  $("opt-url").addEventListener("click", () => {
    $("import-choice").classList.add("hidden");
    $("import-url-form").classList.remove("hidden");
  });

  $("opt-manual").addEventListener("click", () => {
    $("import-choice").classList.add("hidden");
    showReview({ ingredients: [{ quantity: "", unit: "", name: "" }], steps: [{ text: "", tip: "" }] }, { type: "manual" });
  });

  $("btn-extract-photo").addEventListener("click", async () => {
    const file = $("input-photo").files[0];
    if (!file) { showToast("Choisis d'abord une photo", true); return; }
    $("import-photo-form").classList.add("hidden");
    $("import-loading-text").textContent = "Lecture de la photo…";
    $("import-loading").classList.remove("hidden");
    try {
      const { base64, dataUrl } = await readAndResizeImage(file);
      $("import-loading-text").textContent = "Analyse par l'IA…";
      const data = await extractFromImage(base64, "image/jpeg");
      $("import-loading-text").textContent = "Recherche d'une photo du plat…";
      const webPhoto = await findImageViaWebSearch(data.title);
      data.photo = webPhoto || (data.isDishPhoto !== false ? dataUrl : "");
      showReview(data, { type: "photo" });
    } catch (e) {
      showToast("Erreur : " + e.message, true);
      resetImportModal();
    }
  });

  $("btn-extract-url").addEventListener("click", async () => {
    const url = $("input-url").value.trim();
    if (!url) { showToast("Colle d'abord une adresse", true); return; }
    $("import-url-form").classList.add("hidden");
    $("import-loading-text").textContent = "Lecture de la page…";
    $("import-loading").classList.remove("hidden");
    try {
      const { text: pageText, imageUrl } = await fetchPageText(url);
      $("import-loading-text").textContent = "Analyse par l'IA…";
      const data = await extractFromPageText(pageText, url);
      data.photo = imageUrl || "";
      if (!data.photo) {
        $("import-loading-text").textContent = "Recherche d'une photo…";
        data.photo = await findImageViaWebSearch(data.title);
      }
      showReview(data, { type: "url", url });
    } catch (e) {
      showToast("Erreur : " + e.message, true);
      resetImportModal();
    }
  });

  $("review-photo-file").addEventListener("change", async () => {
    const file = $("review-photo-file").files[0];
    if (!file) return;
    try {
      const { dataUrl } = await readAndResizeImage(file);
      setReviewPhoto(dataUrl);
    } catch (e) {
      showToast("Erreur : " + e.message, true);
    }
  });

  $("btn-find-photo").addEventListener("click", async () => {
    const title = $("review-title").value.trim();
    if (!title) { showToast("Indique d'abord un titre", true); return; }
    const btn = $("btn-find-photo");
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Recherche…";
    try {
      const photo = await findImageViaWebSearch(title);
      if (photo) setReviewPhoto(photo);
      else showToast("Aucune photo trouvée");
    } catch (e) {
      showToast("Erreur : " + e.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  $("btn-add-step").addEventListener("click", () => {
    reviewSteps.push({ text: "", tip: "" });
    renderStepsEditor();
    const rows = $("review-steps-list").querySelectorAll(".step-edit-text");
    rows[rows.length - 1]?.focus();
  });

  $("review-steps-list").addEventListener("input", (e) => {
    const idx = Number(e.target.dataset.index);
    if (Number.isNaN(idx) || !reviewSteps[idx]) return;
    if (e.target.classList.contains("step-edit-text")) reviewSteps[idx].text = e.target.value;
    else if (e.target.classList.contains("step-edit-tip")) reviewSteps[idx].tip = e.target.value;
  });

  $("review-steps-list").addEventListener("click", (e) => {
    const btn = e.target.closest(".step-remove");
    if (!btn) return;
    reviewSteps.splice(Number(btn.dataset.index), 1);
    renderStepsEditor();
  });

  $("btn-add-ingredient").addEventListener("click", () => {
    reviewIngredients.push({ quantity: "", unit: "", name: "" });
    renderIngredientsEditor();
    const rows = $("review-ingredients-list").querySelectorAll(".ingredient-edit-name");
    rows[rows.length - 1]?.focus();
  });

  $("review-ingredients-list").addEventListener("input", (e) => {
    const idx = Number(e.target.dataset.index);
    if (Number.isNaN(idx) || !reviewIngredients[idx]) return;
    if (e.target.classList.contains("ingredient-edit-qty")) reviewIngredients[idx].quantity = e.target.value;
    else if (e.target.classList.contains("ingredient-edit-unit")) reviewIngredients[idx].unit = e.target.value;
    else if (e.target.classList.contains("ingredient-edit-name")) reviewIngredients[idx].name = e.target.value;
  });

  $("review-ingredients-list").addEventListener("click", (e) => {
    const btn = e.target.closest(".ingredient-remove");
    if (!btn) return;
    reviewIngredients.splice(Number(btn.dataset.index), 1);
    renderIngredientsEditor();
  });

  $("search-input").addEventListener("input", (e) => {
    currentSearchQuery = e.target.value;
    applyRecipeFilter();
  });

  $("filter-preptime").addEventListener("change", (e) => {
    currentPrepTimeMax = e.target.value;
    applyRecipeFilter();
  });

  $("btn-cancel-selection").addEventListener("click", () => {
    selectedIndices.clear();
    applyRecipeFilter();
    updateSelectionBar();
  });

  $("btn-create-shopping-list").addEventListener("click", async () => {
    if (selectedIndices.size === 0) { showToast("Choisis au moins une recette", true); return; }
    const selectedRecipes = [...selectedIndices].map(i => currentRecipes[i]);
    const items = buildShoppingList(selectedRecipes);
    currentShoppingList = { items, updatedAt: new Date().toISOString() };
    selectedIndices.clear();
    updateSelectionBar();
    applyRecipeFilter();
    showView("view-shopping");
    renderShoppingList(currentShoppingList);
    try {
      await ghSaveShoppingList(currentShoppingList);
    } catch (e) {
      showToast("Erreur d'enregistrement : " + e.message, true);
    }
  });

  $("btn-shopping").addEventListener("click", async () => {
    showView("view-shopping");
    $("shopping-list-items").innerHTML = "<p class='empty-sub'>Chargement…</p>";
    try {
      const loaded = await ghLoadShoppingList();
      currentShoppingList = loaded ? loaded.data : { items: [] };
      currentShoppingListSha = loaded ? loaded.sha : null;
      renderShoppingList(currentShoppingList);
    } catch (e) {
      showToast("Erreur : " + e.message, true);
      $("shopping-list-items").innerHTML = "";
    }
  });

  $("btn-back-shopping").addEventListener("click", () => showView("view-list"));

  $("btn-clear-shopping").addEventListener("click", async () => {
    if (!confirm("Vider la liste de courses ?")) return;
    try {
      if (currentShoppingListSha) await ghDeleteFile("shopping-list.json", currentShoppingListSha);
      currentShoppingList = { items: [] };
      currentShoppingListSha = null;
      renderShoppingList(currentShoppingList);
      showToast("Liste vidée");
    } catch (e) {
      showToast("Erreur : " + e.message, true);
    }
  });

  $("btn-export-ics").addEventListener("click", exportShoppingListToIcs);

  $("shopping-list-items").addEventListener("change", (e) => {
    if (e.target.type !== "checkbox") return;
    const idx = Number(e.target.dataset.index);
    if (!currentShoppingList || !currentShoppingList.items[idx]) return;
    currentShoppingList.items[idx].checked = e.target.checked;
    renderShoppingList(currentShoppingList);
    clearTimeout(shoppingSaveTimer);
    shoppingSaveTimer = setTimeout(() => {
      ghSaveShoppingList(currentShoppingList).catch(() => {});
    }, 600);
  });

  $("shopping-list-items").addEventListener("click", (e) => {
    const btn = e.target.closest(".shopping-item-remove");
    if (!btn || !currentShoppingList) return;
    const idx = Number(btn.dataset.index);
    currentShoppingList.items.splice(idx, 1);
    renderShoppingList(currentShoppingList);
    clearTimeout(shoppingSaveTimer);
    shoppingSaveTimer = setTimeout(() => {
      ghSaveShoppingList(currentShoppingList).catch(() => {});
    }, 600);
  });

  $("btn-save-recipe").addEventListener("click", saveReviewedRecipe);
}

/* ---------- Démarrage ---------- */

wireEvents();
if (!hasSettings()) {
  openModal("modal-settings");
  $("loading-state").classList.add("hidden");
} else {
  refreshRecipeList();
}
