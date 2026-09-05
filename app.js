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
let pendingReview = null; // { source, data }

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
  const body = {
    message: existingSha ? `Mise à jour recette : ${path}` : `Ajout recette : ${path}`,
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

/* ---------- Appels à Claude ---------- */

async function callClaude(contentBlocks) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": settings.anthropicKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 2000,
      messages: [{ role: "user", content: contentBlocks }]
    })
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API : ${res.status} ${errText}`);
  }
  const data = await res.json();
  const text = data.content.map(b => b.text || "").join("\n");
  const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
  return JSON.parse(cleaned);
}

const EXTRACTION_INSTRUCTIONS = `Tu extrais une recette de cuisine et tu réponds UNIQUEMENT avec un objet JSON valide, sans texte avant ni après, sans balises markdown, selon exactement ce schéma :
{
  "title": "string",
  "servings": "string (ex: '4 personnes', vide si inconnu)",
  "prepTime": "string (ex: '15 min', vide si inconnu)",
  "cookTime": "string (ex: '30 min', vide si inconnu)",
  "ingredients": ["string", "..."],
  "steps": ["string", "..."]
}
Chaque ingrédient est une seule ligne de texte (quantité + unité + nom, ex: "200 g de farine"). Chaque étape est une phrase claire et complète. Si une information est absente de la source, laisse une chaîne vide plutôt que d'inventer.`;

async function extractFromImage(base64, mediaType) {
  return callClaude([
    { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
    { type: "text", text: EXTRACTION_INSTRUCTIONS }
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

async function fetchPageText(url) {
  const proxies = [
    `https://thingproxy.freeboard.io/fetch/${url}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`
  ];
  let lastErr;
  for (const proxyUrl of proxies) {
    try {
      const res = await fetchWithTimeout(proxyUrl, 12000);
      if (!res.ok) throw new Error(`${res.status}`);
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      doc.querySelectorAll("script, style, nav, footer, header, noscript").forEach(el => el.remove());
      const text = doc.body ? doc.body.innerText : doc.documentElement.textContent;
      const cleaned = text.replace(/\n{2,}/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
      if (cleaned.length > 200) return cleaned;
      lastErr = new Error("Contenu trop court");
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Impossible de lire cette page (${lastErr?.message || "erreur inconnue"})`);
}

/* ---------- Redimensionnement d'image (avant envoi à l'IA) ---------- */

function readAndResizeImage(file, maxWidth = 1400) {
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
        const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
        resolve(dataUrl.split(",")[1]); // base64 sans le préfixe
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
  $("recipe-grid").classList.add("hidden");
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
  if (recipes.length === 0) {
    $("empty-state").classList.remove("hidden");
    return;
  }
  const grid = $("recipe-grid");
  grid.innerHTML = "";
  recipes.forEach((r, i) => {
    const card = document.createElement("div");
    card.className = "recipe-card";
    const meta = [r.data.prepTime, r.data.cookTime, r.data.servings].filter(Boolean);
    card.innerHTML = `<h3>${escapeHtml(r.data.title || "Sans titre")}</h3>
      <div class="recipe-meta">${meta.map(m => `<span>${escapeHtml(m)}</span>`).join("")}</div>`;
    card.addEventListener("click", () => openRecipeDetail(i));
    grid.appendChild(card);
  });
  grid.classList.remove("hidden");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- Détail d'une recette ---------- */

function openRecipeDetail(index) {
  const r = currentRecipes[index];
  const d = r.data;
  const meta = [
    d.servings && `${d.servings}`,
    d.prepTime && `Préparation : ${d.prepTime}`,
    d.cookTime && `Cuisson : ${d.cookTime}`
  ].filter(Boolean);

  $("detail-content").innerHTML = `
    <div class="detail-header">
      <h2>${escapeHtml(d.title || "Sans titre")}</h2>
      <div class="detail-meta">${meta.map(m => `<span>${escapeHtml(m)}</span>`).join("")}</div>
      ${d.source && d.source.url ? `<div class="detail-source">Source : <a href="${escapeHtml(d.source.url)}" target="_blank" rel="noopener">${escapeHtml(d.source.url)}</a></div>` : ""}
    </div>
    <div class="detail-section">
      <h4>INGRÉDIENTS</h4>
      <ul class="ingredient-list">${(d.ingredients || []).map(ing => `<li>${escapeHtml(ing)}</li>`).join("")}</ul>
    </div>
    <div class="detail-section">
      <h4>ÉTAPES</h4>
      <ol class="step-list">${(d.steps || []).map(s => `<li>${escapeHtml(s)}</li>`).join("")}</ol>
    </div>
    <div class="detail-footer">
      <button class="btn btn-danger" id="btn-delete-recipe">Supprimer cette recette</button>
    </div>
  `;
  $("btn-delete-recipe").addEventListener("click", () => deleteCurrentRecipe(r));
  showView("view-detail");
}

async function deleteCurrentRecipe(r) {
  if (!confirm(`Supprimer « ${r.data.title} » ? Cette action est définitive.`)) return;
  try {
    await ghDeleteFile(r.path, r.sha);
    showToast("Recette supprimée");
    showView("view-list");
    refreshRecipeList();
  } catch (e) {
    showToast("Erreur : " + e.message, true);
  }
}

/* ---------- Import : flux commun ---------- */

function resetImportModal() {
  $("import-choice").classList.remove("hidden");
  $("import-photo-form").classList.add("hidden");
  $("import-url-form").classList.add("hidden");
  $("import-loading").classList.add("hidden");
  $("import-review").classList.add("hidden");
  $("input-photo").value = "";
  $("input-url").value = "";
  pendingReview = null;
}

function showReview(data, source) {
  pendingReview = { source, data };
  $("review-title").value = data.title || "";
  $("review-servings").value = data.servings || "";
  $("review-prep").value = data.prepTime || "";
  $("review-cook").value = data.cookTime || "";
  $("review-ingredients").value = (data.ingredients || []).join("\n");
  $("review-steps").value = (data.steps || []).join("\n");
  $("import-loading").classList.add("hidden");
  $("import-review").classList.remove("hidden");
}

async function saveReviewedRecipe() {
  const now = new Date();
  const title = $("review-title").value.trim() || "Sans titre";
  const slug = title.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || "recette";
  const path = `${RECIPES_PATH}/${slug}-${now.getTime()}.json`;

  const recipe = {
    title,
    servings: $("review-servings").value.trim(),
    prepTime: $("review-prep").value.trim(),
    cookTime: $("review-cook").value.trim(),
    ingredients: $("review-ingredients").value.split("\n").map(s => s.trim()).filter(Boolean),
    steps: $("review-steps").value.split("\n").map(s => s.trim()).filter(Boolean),
    source: pendingReview.source,
    createdAt: now.toISOString()
  };

  try {
    $("btn-save-recipe").disabled = true;
    $("btn-save-recipe").textContent = "Enregistrement…";
    await ghSaveFile(path, recipe, null);
    showToast("Recette enregistrée");
    closeModal("modal-import");
    resetImportModal();
    showView("view-list");
    refreshRecipeList();
  } catch (e) {
    showToast("Erreur : " + e.message, true);
  } finally {
    $("btn-save-recipe").disabled = false;
    $("btn-save-recipe").textContent = "Enregistrer la recette";
  }
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
  $("btn-back").addEventListener("click", () => showView("view-list"));

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

  $("btn-extract-photo").addEventListener("click", async () => {
    const file = $("input-photo").files[0];
    if (!file) { showToast("Choisis d'abord une photo", true); return; }
    $("import-photo-form").classList.add("hidden");
    $("import-loading-text").textContent = "Lecture de la photo…";
    $("import-loading").classList.remove("hidden");
    try {
      const base64 = await readAndResizeImage(file);
      $("import-loading-text").textContent = "Analyse par l'IA…";
      const data = await extractFromImage(base64, "image/jpeg");
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
      const pageText = await fetchPageText(url);
      $("import-loading-text").textContent = "Analyse par l'IA…";
      const data = await extractFromPageText(pageText, url);
      showReview(data, { type: "url", url });
    } catch (e) {
      showToast("Erreur : " + e.message, true);
      resetImportModal();
    }
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
