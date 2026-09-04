/* ===================== Config ===================== */
const API_BASE = "https://sav-okla-proxy.okla-sav.workers.dev";
// Clé de stockage distincte par app (même script partagé entre /gestion/ et /magasin/)
// pour que se connecter sur l'une n'affecte pas la session de l'autre sur le même appareil.
const APP_KEY = location.pathname.includes("/magasin/") ? "magasin" : "gestion";
const TOKEN_KEY = `sav-okla-${APP_KEY}-token`;
const ROLE_KEY = `sav-okla-${APP_KEY}-role`;

// Récupérés en direct depuis Airtable au login (voir loadChoices) plutôt que recopiés en
// dur ici — un accent ou une apostrophe typographique mal recopiée ferait échouer un
// enregistrement silencieusement côté serveur (l'option n'existerait pas pour Airtable).
let CLAIM_STATUS_CHOICES = [];
let QUALIFICATION_CHOICES = [];
let SOLUTION_CHOICES = [];
let STATUT_CLIENT_CHOICES = [];

async function loadChoices() {
  try {
    const data = await api("/api/gestion/choices");
    CLAIM_STATUS_CHOICES = data.claimStatus || [];
    QUALIFICATION_CHOICES = data.qualificationRetenue || [];
    SOLUTION_CHOICES = data.solutionProposee || [];
    STATUT_CLIENT_CHOICES = data.statutClient || [];
    populateStatutFilter();
  } catch (e) { /* si ça échoue, les listes resteront vides — au pire l'edition est bloquée, jamais une mauvaise valeur envoyée */ }
}

/* ===================== State ===================== */
let state = { token: localStorage.getItem(TOKEN_KEY) || "", role: localStorage.getItem(ROLE_KEY) || "", offset: null, currentId: null };

const $ = (sel, root) => (root || document).querySelector(sel);

/* ===================== API ===================== */
async function api(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    logout();
    throw new Error("Session expirée, merci de vous reconnecter.");
  }
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "Erreur inconnue.");
  return data;
}

/* ===================== Auth ===================== */
function showLoggedOut() {
  $("#loginView").classList.remove("hidden");
  $("#listView").classList.add("hidden");
  $("#detailView").classList.add("hidden");
  $("#btnLogout").classList.add("hidden");
  $("#roleBadge").classList.add("hidden");
}
async function showLoggedIn() {
  $("#loginView").classList.add("hidden");
  $("#btnLogout").classList.remove("hidden");
  const badge = $("#roleBadge");
  badge.textContent = state.role === "full" ? "Accès complet" : "Magasin";
  badge.classList.remove("hidden");
  await loadChoices();
  showList();
}
function logout() {
  state.token = ""; state.role = "";
  localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(ROLE_KEY);
  showLoggedOut();
}
$("#btnLogout").addEventListener("click", logout);

$("#btnLogin").addEventListener("click", doLogin);
$("#loginPassword").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
async function doLogin() {
  const password = $("#loginPassword").value;
  $("#loginError").textContent = "";
  if (!password) return;
  try {
    const res = await fetch(`${API_BASE}/api/gestion/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Mot de passe incorrect.");
    state.token = data.token; state.role = data.role;
    localStorage.setItem(TOKEN_KEY, data.token); localStorage.setItem(ROLE_KEY, data.role);
    $("#loginPassword").value = "";
    showLoggedIn();
  } catch (e) {
    $("#loginError").textContent = e.message;
  }
}

function populateStatutFilter() {
  const sel = $("#filterStatut");
  if (sel.options.length > 1) return;
  CLAIM_STATUS_CHOICES.forEach((s) => {
    const o = document.createElement("option"); o.textContent = s; sel.appendChild(o);
  });
}

/* ===================== List view ===================== */
function statusPillClass(status) {
  if (/^SAV (terminé|clôturé)/.test(status || "")) return "done";
  if (status === "Refus du fournisseur" || status === "Voir avec Antoine") return "blocked";
  return "";
}

async function loadDossiers(reset) {
  if (reset) { state.offset = null; $("#dossierList").innerHTML = '<div class="loading">Chargement…</div>'; }
  const qs = new URLSearchParams();
  const q = $("#searchInput").value.trim();
  const statut = $("#filterStatut").value;
  const magasin = $("#filterMagasin").value;
  if (q) qs.set("q", q);
  if (statut) qs.set("statut", statut);
  if (magasin) qs.set("magasin", magasin);
  if (!reset && state.offset) qs.set("offset", state.offset);

  try {
    const data = await api(`/api/gestion/dossiers?${qs.toString()}`);
    if (reset) $("#dossierList").innerHTML = "";
    if (reset && data.records.length === 0) {
      $("#dossierList").innerHTML = '<div class="empty-state">Aucun dossier ne correspond à cette recherche.</div>';
    }
    data.records.forEach((r) => $("#dossierList").appendChild(renderDossierRow(r)));
    state.offset = data.offset;
    $("#loadMoreWrap").classList.toggle("hidden", !data.offset);
  } catch (e) {
    $("#dossierList").innerHTML = `<div class="empty-state">${e.message}</div>`;
  }
}

function renderDossierRow(r) {
  const f = r.fields;
  const div = document.createElement("div");
  div.className = "dossier-row";
  const prenom = (f["Prénom client"] || [])[0] || "";
  const nom = (f["Nom client"] || [])[0] || "";
  const magasin = Array.isArray(f["Magasin"]) ? f["Magasin"].join(", ") : (f["Magasin"] || "");
  const statut = f["Claim Status"] || "";
  div.innerHTML = `
    <span class="claim-id">${f["Numéro SAV"] || ""}</span>
    <span class="client-name">${prenom} ${nom}</span>
    <span class="magasin">${magasin}</span>
    <span class="nature">${f["Nature du problème constaté"] || ""}</span>
    <span class="status-pill ${statusPillClass(statut)}">${statut || "—"}</span>
  `;
  div.addEventListener("click", () => openDossier(r.id));
  return div;
}

function showList() {
  $("#detailView").classList.add("hidden");
  $("#listView").classList.remove("hidden");
  loadDossiers(true);
}

$("#btnLoadMore").addEventListener("click", () => loadDossiers(false));
$("#filterStatut").addEventListener("change", () => loadDossiers(true));
$("#filterMagasin").addEventListener("change", () => loadDossiers(true));
let searchDebounce;
$("#searchInput").addEventListener("input", () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => loadDossiers(true), 350);
});

/* ===================== Detail view ===================== */
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function kv(label, value) {
  const v = value === undefined || value === null || value === "" ? '<span class="v empty">—</span>' : `<span class="v">${esc(value)}</span>`;
  return `<div class="kv"><div class="k">${esc(label)}</div>${v}</div>`;
}
function selectHtml(id, choices, current, required) {
  const opts = ['<option value="">—</option>'].concat(
    choices.map((c) => `<option value="${esc(c)}" ${c === current ? "selected" : ""}>${esc(c)}</option>`)
  );
  return `<select id="${id}" ${required ? "required" : ""}>${opts.join("")}</select>`;
}

async function openDossier(id) {
  state.currentId = id;
  $("#listView").classList.add("hidden");
  $("#detailView").classList.remove("hidden");
  $("#detailView").innerHTML = '<div class="loading">Chargement du dossier…</div>';
  try {
    const data = await api(`/api/gestion/dossiers/${id}`);
    renderDetail(data.fields);
  } catch (e) {
    $("#detailView").innerHTML = `<div class="detail-backlink" id="backlink">&larr; Retour à la liste</div><div class="empty-state">${e.message}</div>`;
    $("#backlink").addEventListener("click", showList);
  }
}

function renderDetail(f) {
  const prenom = (f["Prénom client"] || [])[0] || "";
  const nom = (f["Nom client"] || [])[0] || "";
  const email = (f["Email client"] || [])[0] || "";
  const photos = f["Supporting Photos"] || [];
  const isFull = state.role === "full";

  let html = `<div class="detail-backlink" id="backlink">&larr; Retour à la liste</div>`;
  html += `<div class="detail-header">
    <div><h2>${esc(f["Numéro SAV"] || "")}</h2><div class="sub">${esc(prenom)} ${esc(nom)}${email ? " · " + esc(email) : ""}</div></div>
  </div>`;

  html += `<div class="panel"><h3>Déclaré par le client</h3>
    <div class="kv-grid">
      ${kv("Magasin", f["Magasin"])}
      ${kv("Référence produit", f["Référence produit"])}
      ${kv("Désignation produit", (f["Désignation produit"] || [])[0])}
      ${kv("Pièce concernée", f["Pièce concernée"])}
      ${kv("Nature du problème", f["Nature du problème constaté"])}
      ${kv("Date de la demande", f["Date de la demande"])}
      ${isFull ? kv("Date d'achat", f["date achat"]) : ""}
      ${isFull ? kv("Date de livraison", f["Date de livraison"]) : ""}
      ${isFull ? kv("Date de déballage/montage", f["Date de déballage/montage"]) : ""}
      ${isFull ? kv("Monté par", f["Produit monté par vous ou livré déjà monté ?"]) : ""}
    </div>
    ${isFull && f["Claim Description"] ? `<div class="description-block">${esc(f["Claim Description"])}</div>` : ""}
    ${photos.length ? `<div class="photo-grid">${photos.map((p) => `<a href="${esc(p.url)}" target="_blank" rel="noopener"><img src="${esc((p.thumbnails && p.thumbnails.large) ? p.thumbnails.large.url : p.url)}" alt=""></a>`).join("")}</div>` : ""}
  </div>`;

  if (isFull) {
    html += `<div class="panel"><h3>Traitement (Émilie)</h3>
      <div class="edit-grid">
        <div class="field"><label for="f-qualification">Qualification retenue</label>${selectHtml("f-qualification", QUALIFICATION_CHOICES, f["Qualification retenue"])}</div>
        <div class="field"><label for="f-claimstatus">Claim Status</label>${selectHtml("f-claimstatus", CLAIM_STATUS_CHOICES, f["Claim Status"])}</div>
        <div class="field"><label for="f-solution">Solution proposée</label>${selectHtml("f-solution", SOLUTION_CHOICES, (f["Solution proposée"] || [])[0])}</div>
        <div class="field"><label for="f-numsuivi">Numéro suivi</label><input type="text" id="f-numsuivi" value="${esc(f["Numéro suivi"])}"></div>
        <div class="field"><label for="f-montantavoir">Montant avoir (€)</label><input type="number" step="0.01" id="f-montantavoir" value="${esc(f["Montant avoir"])}"></div>
        <div class="field"><label for="f-rembfourn">Remboursement fournisseur (€)</label><input type="number" step="0.01" id="f-rembfourn" value="${esc(f["Remboursement fournisseur"])}"></div>
        <div class="field"><label for="f-numavoir">Numéro avoir</label><input type="text" id="f-numavoir" value="${esc(f["Numéro avoir"])}"></div>
      </div>
      <div class="field" style="margin-top:14px;"><label for="f-notes">Notes</label><textarea id="f-notes">${esc(f["Notes"])}</textarea></div>
      <div class="field" style="margin-top:14px;"><label for="f-infos">Infos</label><textarea id="f-infos">${esc(f["Infos"])}</textarea></div>
      <div class="save-row"><span class="save-msg" id="saveMsgFull"></span><button type="button" id="btnSaveFull">Enregistrer</button></div>
    </div>`;

    const reponsePhotos = f["Photos complémentaires"] || [];
    html += `<div class="panel"><h3>Échanges avec le client</h3>
      ${f["Accord client - preuve"] ? `<div class="description-block" style="margin-bottom:14px;">${esc(f["Accord client - preuve"])}</div>` : ""}
      ${f["Réponse client"] ? `<div class="kv" style="margin-bottom:10px;"><div class="k">Réponse du client</div><div class="v">${esc(f["Réponse client"])}</div></div>` : ""}
      ${reponsePhotos.length ? `<div class="photo-grid">${reponsePhotos.map((p) => `<a href="${esc(p.url)}" target="_blank" rel="noopener"><img src="${esc((p.thumbnails && p.thumbnails.large) ? p.thumbnails.large.url : p.url)}" alt=""></a>`).join("")}</div>` : ""}
      <div class="field" style="margin-top:14px;">
        <label for="f-demandecomplement">Demander un complément au client (photo, précision...)</label>
        <textarea id="f-demandecomplement" placeholder="Ex. Merci d'ajouter une photo de l'étiquette du produit.">${esc(f["Demande complément"])}</textarea>
      </div>
      ${f["Lien suivi client"] ? `<div class="kv" style="margin-top:10px;"><div class="k">Lien du portail client</div><div class="v"><a href="${esc(f["Lien suivi client"])}" target="_blank" rel="noopener">${esc(f["Lien suivi client"])}</a></div></div>` : ""}
      <p class="sub" style="margin:10px 0 0;">Le message ci-dessus part au client par email au prochain enregistrement — pense aussi à changer le Claim Status (ex. "En attente d'informations client") dans le panneau Traitement ci-dessus pour déclencher l'envoi.</p>
    </div>`;
  }

  html += `<div class="panel"><h3>Clôture (magasin)</h3>
    <div class="edit-grid">
      <div class="field"><label for="f-statutclient">Statut Client</label>${selectHtml("f-statutclient", STATUT_CLIENT_CHOICES, f["Statut Client"])}</div>
      <div class="field"><label for="f-cloturepar">Clôturé par (nom/code vendeur)</label><input type="text" id="f-cloturepar" value="${esc(f["Clôturé par"])}"></div>
      <div class="field"><label for="f-retrait">Retrait par le client (date)</label><input type="date" id="f-retrait" value="${esc(f["Retrait par le client"])}"></div>
      <div class="field checkbox"><input type="checkbox" id="f-solutionexec" ${f["Solution exécutée"] ? "checked" : ""}><label for="f-solutionexec">Solution exécutée</label></div>
    </div>
    <div class="save-row"><span class="save-msg" id="saveMsgMagasin"></span><button type="button" id="btnSaveMagasin">Enregistrer</button></div>
  </div>`;

  $("#detailView").innerHTML = html;
  $("#backlink").addEventListener("click", showList);
  if (isFull) $("#btnSaveFull").addEventListener("click", saveFullSection);
  $("#btnSaveMagasin").addEventListener("click", saveMagasinSection);
}

async function saveSection(btn, msgEl, fields) {
  btn.disabled = true;
  const original = btn.textContent;
  btn.innerHTML = '<span class="spinner"></span>Enregistrement…';
  msgEl.textContent = ""; msgEl.className = "save-msg";
  try {
    await api(`/api/gestion/dossiers/${state.currentId}`, { method: "PATCH", body: JSON.stringify({ fields }) });
    msgEl.textContent = "Enregistré."; msgEl.classList.add("ok");
  } catch (e) {
    msgEl.textContent = e.message; msgEl.classList.add("err");
  } finally {
    btn.disabled = false; btn.textContent = original;
  }
}

function saveFullSection() {
  const val = (id) => $("#" + id).value;
  const fields = {
    qualificationRetenue: val("f-qualification"),
    claimStatus: val("f-claimstatus"),
    solutionProposee: val("f-solution") ? [val("f-solution")] : [],
    numeroSuivi: val("f-numsuivi"),
    montantAvoir: val("f-montantavoir") ? Number(val("f-montantavoir")) : null,
    remboursementFournisseur: val("f-rembfourn") ? Number(val("f-rembfourn")) : null,
    numeroAvoir: val("f-numavoir"),
    notes: val("f-notes"),
    infos: val("f-infos"),
    demandeComplement: val("f-demandecomplement"),
  };
  saveSection($("#btnSaveFull"), $("#saveMsgFull"), fields);
}

function saveMagasinSection() {
  const val = (id) => $("#" + id).value;
  const fields = {
    statutClient: val("f-statutclient"),
    cloturePar: val("f-cloturepar"),
    retraitParLeClient: val("f-retrait"),
    solutionExecutee: $("#f-solutionexec").checked,
  };
  saveSection($("#btnSaveMagasin"), $("#saveMsgMagasin"), fields);
}

/* ===================== Boot ===================== */
if (state.token && state.role) {
  showLoggedIn();
} else {
  showLoggedOut();
}
