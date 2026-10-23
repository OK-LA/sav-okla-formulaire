/* ===================== Statistiques (accès complet uniquement) =====================
 * Chargé seulement par /gestion/ (jamais par /magasin/), et le Worker refuse de toute façon
 * /api/gestion/stats au rôle magasin. Réutilise les helpers globaux de app.js ($, api, esc,
 * state, openDossier, showList).
 *
 * Toute l'agrégation se fait ici, dans le navigateur, sur l'ensemble des dossiers chargés une
 * fois : les filtres (période, magasin, fournisseur) sont donc instantanés.
 *
 * Principe de transparence : chaque indicateur calculé sur un champ partiellement rempli
 * affiche « sur n dossiers », pour qu'on sache toujours sur quoi repose le chiffre.
 */

const STATS = {
  records: null,      // dossiers bruts renvoyés par le Worker
  loadedAt: null,
  filters: { periode: "12m", magasin: "", fournisseur: "" },
  sort: {},           // tri courant de chaque tableau : { [tableId]: { key, dir } }
};

// Au-delà, le montant « Claim Amount » (prix de vente du produit) est presque sûrement une
// erreur de saisie (virgule oubliée : 150365 pour 1503,65) — exclu des sommes, listé en
// « Qualité de saisie » pour correction.
const VALEUR_MAX_PLAUSIBLE = 10000;
// Délais hors de cette plage = dates incohérentes (inversées, faute de frappe sur l'année).
const DELAI_MAX_JOURS = 730;
// Les dossiers saisis pour la casse interne portent un nom de magasin/expo au lieu d'un client.
const CLIENT_INTERNE_RE = /^(magasins?|expo(sition)?|entrepot|ent|ok-?az|ham|breteuil|bret|roye|longueau|stock|client)(\s|$)/;
const MOIS_COURTS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

/* ---------- helpers de normalisation ---------- */
function sansAccents(s) { return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, ""); }
function normTexte(s) { return sansAccents(s).toLowerCase().replace(/\s+/g, " ").trim(); }
function normRef(s) { return sansAccents(s).toUpperCase().replace(/\s+/g, " ").trim(); }
function joursEntre(a, b) {
  if (!a || !b) return null;
  const d = Math.round((new Date(b + "T12:00:00") - new Date(a + "T12:00:00")) / 86400000);
  return isNaN(d) || d < 0 || d > DELAI_MAX_JOURS ? null : d;
}
function mediane(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
function isoJour(d) { return d.toISOString().slice(0, 10); }
function euros(n) { return n == null ? "—" : Math.round(n).toLocaleString("fr-FR") + " €"; }
function pct(n, total) { return total ? Math.round((n / total) * 100) + " %" : "—"; }
function compter(arr) {
  const m = new Map();
  arr.forEach((k) => { if (k) m.set(k, (m.get(k) || 0) + 1); });
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

// Regroupe les 19 statuts fournisseurs en 6 issues lisibles.
function issueDe(statut) {
  const s = (statut || "").toLowerCase();
  if (s.startsWith("sav terminé")) {
    if (s.includes("répar")) return "Réparé";
    if (s.includes("échang")) return "Échangé";
    if (s.includes("rembours")) return "Remboursé";
    return "Terminé (autre)";
  }
  if (s.startsWith("sav clôturé")) return "Clôturé sans suite";
  if (s.startsWith("refus du fournisseur")) return "Refus fournisseur";
  return "En cours";
}
const ISSUES_ORDRE = ["Réparé", "Échangé", "Remboursé", "Terminé (autre)", "Clôturé sans suite", "Refus fournisseur", "En cours"];

// Un dossier brut Airtable → objet plat déjà normalisé, calculé une seule fois au chargement.
function preparer(r) {
  const f = r.f;
  const clientTexte = (f["Client"] || "").trim();
  const clientNorm = normTexte(clientTexte);
  const valeur = typeof f["Claim Amount"] === "number" && f["Claim Amount"] > 0 ? f["Claim Amount"] : null;
  const fournisseur = (f["Fournisseur"] || "").trim().toUpperCase();
  return {
    id: r.id,
    date: f["Date de la demande"] || null,
    magasins: Array.isArray(f["Magasin"]) ? f["Magasin"] : (f["Magasin"] ? [f["Magasin"]] : []),
    fournisseur: fournisseur || "(non renseigné)",
    fournisseurRenseigne: !!fournisseur,
    refBrute: (f["Référence produit"] || "").trim(),
    ref: normRef(f["Référence produit"]),
    designation: (f["Désignation produit"] || [])[0] || "",
    piece: normTexte(f["Pièce concernée"]),
    types: f["Type de réclamation"] || [],
    nature: f["Nature du problème constaté"] || "",
    qualification: f["Qualification retenue"] || "",
    solution: (f["Solution proposée"] || [])[0] || "",
    statut: f["Claim Status"] || "",
    issue: issueDe(f["Claim Status"]),
    clientTexte,
    clientInterne: CLIENT_INTERNE_RE.test(clientNorm),
    // Fiche Clients liée = identité fiable ; sinon (anciens dossiers) le nom saisi à la main.
    clientCle: (f["Clients"] && f["Clients"][0]) || (clientNorm ? "nom:" + clientNorm : ""),
    clientLie: !!(f["Clients"] && f["Clients"][0]),
    dateAchat: f["date achat"] || null,
    delaiPriseEnCharge: joursEntre(f["Date de la demande"], f["Demande au fournisseur"]),
    delaiFournisseur: joursEntre(f["Demande au fournisseur"], f["Réception à l'entrepôt"]),
    delaiTotal: joursEntre(f["Date de la demande"], f["Date de clôture"]),
    ageProduitJours: joursEntre(f["date achat"], f["Date de la demande"]),
    valeur: valeur && valeur <= VALEUR_MAX_PLAUSIBLE ? valeur : null,
    valeurAberrante: valeur && valeur > VALEUR_MAX_PLAUSIBLE ? valeur : null,
    avoir: typeof f["Montant avoir"] === "number" ? f["Montant avoir"] : null,
    rembFournisseur: typeof f["Remboursement fournisseur"] === "number" ? f["Remboursement fournisseur"] : null,
    demandeFournisseur: !!f["Demande au fournisseur"],
  };
}

/* ---------- périodes ---------- */
function bornesPeriode(code) {
  const auj = new Date();
  const y = auj.getFullYear();
  const decale = (d, ans) => { const x = new Date(d); x.setFullYear(x.getFullYear() + ans); return x; };
  if (code === "12m") {
    const debut = decale(auj, -1); debut.setDate(debut.getDate() + 1);
    return { debut: isoJour(debut), fin: isoJour(auj), prec: { debut: isoJour(decale(debut, -1)), fin: isoJour(decale(auj, -1)) }, libellePrec: "les 12 mois précédents" };
  }
  if (code === "annee") {
    return { debut: `${y}-01-01`, fin: isoJour(auj), prec: { debut: `${y - 1}-01-01`, fin: isoJour(decale(auj, -1)) }, libellePrec: `la même période en ${y - 1}` };
  }
  if (code === "anneeprec") {
    return { debut: `${y - 1}-01-01`, fin: `${y - 1}-12-31`, prec: { debut: `${y - 2}-01-01`, fin: `${y - 2}-12-31` }, libellePrec: `${y - 2}` };
  }
  return { debut: "2020-01-01", fin: "2999-12-31", prec: null, libellePrec: "" };
}

function filtrer(recs, debut, fin) {
  const { magasin, fournisseur } = STATS.filters;
  return recs.filter((d) =>
    d.date && d.date >= debut && d.date <= fin &&
    (!magasin || d.magasins.includes(magasin)) &&
    (!fournisseur || d.fournisseur === fournisseur)
  );
}

/* ---------- composants d'affichage ---------- */
function couverture(n, total) {
  return `<span class="st-cov">sur ${n} dossier${n > 1 ? "s" : ""}${total != null && total !== n ? " / " + total : ""}</span>`;
}
function tuile(libelle, valeur, detail) {
  return `<div class="st-tile"><div class="st-tile-k">${esc(libelle)}</div><div class="st-tile-v">${valeur}</div>${detail ? `<div class="st-tile-d">${detail}</div>` : ""}</div>`;
}
function evolution(n, nPrec, libellePrec) {
  if (nPrec == null) return "";
  if (!nPrec) return `${n ? "aucun" : "0"} dossier sur ${esc(libellePrec)}`;
  const d = Math.round(((n - nPrec) / nPrec) * 100);
  return `${d > 0 ? "+" : ""}${d} % vs ${esc(libellePrec)} (${nPrec})`;
}
// Barres horizontales : un seul aplat de couleur (une seule série), libellé + valeur en encre.
function barres(items, opts = {}) {
  if (!items.length) return `<p class="st-vide">Aucune donnée sur cette sélection.</p>`;
  const max = Math.max(...items.map((i) => i.value)) || 1;
  return `<div class="st-bars">${items.map((i) => `
    <div class="st-bar-row${i.onclick ? " st-click" : ""}" ${i.onclick ? `data-action="${esc(i.onclick)}"` : ""} title="${esc(i.label)} : ${esc(i.valueLabel || i.value)}">
      <div class="st-bar-label">${esc(i.label)}</div>
      <div class="st-bar-track"><div class="st-bar-fill${opts.muted ? " muted" : ""}" style="width:${Math.max(2, (i.value / max) * 100)}%"></div></div>
      <div class="st-bar-val">${esc(i.valueLabel || i.value)}</div>
    </div>`).join("")}</div>`;
}
// Histogramme mensuel (colonnes) avec info-bulle au survol.
function histogrammeMensuel(recs, debut, fin) {
  const premier = recs.reduce((m, d) => (d.date < m ? d.date : m), fin);
  const dep = debut > premier ? debut : premier;
  const mois = [];
  let y = +dep.slice(0, 4), m = +dep.slice(5, 7);
  const yFin = +fin.slice(0, 4), mFin = +fin.slice(5, 7);
  while (y < yFin || (y === yFin && m <= mFin)) {
    mois.push(`${y}-${String(m).padStart(2, "0")}`);
    m++; if (m > 12) { m = 1; y++; }
    if (mois.length > 60) break;
  }
  const comptes = new Map(mois.map((k) => [k, 0]));
  recs.forEach((d) => { const k = d.date.slice(0, 7); if (comptes.has(k)) comptes.set(k, comptes.get(k) + 1); });
  const max = Math.max(1, ...comptes.values());
  const etiquetteTous = mois.length <= 14;
  return `<div class="st-cols">${mois.map((k, idx) => {
    const n = comptes.get(k);
    const lib = `${MOIS_COURTS[+k.slice(5, 7) - 1]} ${k.slice(2, 4)}`;
    const montrer = etiquetteTous || idx % 3 === 0;
    return `<div class="st-col" title="${lib} : ${n} dossier${n > 1 ? "s" : ""}">
      <div class="st-col-n">${n || ""}</div>
      <div class="st-col-bar" style="height:${(n / max) * 100}%"></div>
      <div class="st-col-l">${montrer ? lib : ""}</div>
    </div>`;
  }).join("")}</div>`;
}
// Tableau triable : clic sur un en-tête = tri, re-clic = sens inverse.
function tableau(id, colonnes, lignes, opts = {}) {
  if (!lignes.length) return `<p class="st-vide">Aucune donnée sur cette sélection.</p>`;
  const s = STATS.sort[id] || opts.triDefaut || { key: colonnes[1].key, dir: -1 };
  const col = colonnes.find((c) => c.key === s.key) || colonnes[1];
  const tri = [...lignes].sort((a, b) => {
    const va = col.sortVal ? col.sortVal(a) : a[col.key];
    const vb = col.sortVal ? col.sortVal(b) : b[col.key];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return (typeof va === "string" ? va.localeCompare(vb, "fr") : va - vb) * s.dir;
  });
  const visibles = opts.limite ? tri.slice(0, opts.limite) : tri;
  return `<div class="st-table-wrap"><table class="st-table">
    <thead><tr>${colonnes.map((c) => `<th data-table="${id}" data-key="${c.key}" class="${c.num ? "num" : ""}${c.key === s.key ? " sorted" : ""}">${esc(c.label)}${c.key === s.key ? (s.dir < 0 ? " ▼" : " ▲") : ""}</th>`).join("")}</tr></thead>
    <tbody>${visibles.map((l) => `<tr${opts.action ? ` class="st-click" data-action="${esc(opts.action(l))}"` : ""}>${colonnes.map((c) => `<td class="${c.num ? "num" : ""}">${c.html ? c.html(l) : esc(l[c.key] == null ? "—" : l[c.key])}</td>`).join("")}</tr>`).join("")}</tbody>
  </table></div>${opts.limite && tri.length > opts.limite ? `<p class="st-note">${tri.length - opts.limite} autre(s) non affiché(s).</p>` : ""}`;
}

/* ---------- sections ---------- */
function sectionVueEnsemble(cur, prec, b) {
  const enCours = cur.filter((d) => d.issue === "En cours").length;
  const avecValeur = cur.filter((d) => d.valeur != null);
  const dPec = cur.map((d) => d.delaiPriseEnCharge).filter((x) => x != null);
  const dFour = cur.map((d) => d.delaiFournisseur).filter((x) => x != null);
  const dTot = cur.map((d) => d.delaiTotal).filter((x) => x != null);
  const issues = ISSUES_ORDRE.map((k) => ({ label: k, value: cur.filter((d) => d.issue === k).length }))
    .filter((i) => i.value).map((i) => ({ ...i, valueLabel: `${i.value} (${pct(i.value, cur.length)})` }));
  const types = compter(cur.flatMap((d) => d.types)).map(([k, n]) => ({ label: k, value: n, valueLabel: `${n} (${pct(n, cur.length)})` }));
  const sansType = cur.filter((d) => !d.types.length).length;
  const seuilDelai = 5;
  return `
  <div class="panel"><h3>Vue d'ensemble</h3>
    <div class="st-tiles">
      ${tuile("Dossiers SAV", cur.length, evolution(cur.length, prec ? prec.length : null, b.libellePrec))}
      ${tuile("En cours", enCours, pct(enCours, cur.length) + " des dossiers")}
      ${tuile("Valeur des produits concernés", euros(avecValeur.reduce((s, d) => s + d.valeur, 0)), couverture(avecValeur.length, cur.length) + " · prix de vente")}
      ${tuile("Délai de prise en charge", dPec.length ? mediane(dPec) + " j" : "—", "demande client → demande fournisseur, médiane " + couverture(dPec.length, cur.length))}
      ${tuile("Délai fournisseur", dFour.length ? mediane(dFour) + " j" : "—", "demande fournisseur → pièce reçue, médiane " + couverture(dFour.length, cur.length))}
      ${tuile("Délai total du SAV", dTot.length >= seuilDelai ? mediane(dTot) + " j" : "—", dTot.length >= seuilDelai ? "demande → clôture, médiane " + couverture(dTot.length, cur.length) : `pas encore assez de dossiers clôturés depuis l'appli (${dTot.length})`)}
    </div>
    <h4>Dossiers par mois</h4>
    ${cur.length ? histogrammeMensuel(cur, b.debut, b.fin) : `<p class="st-vide">Aucun dossier.</p>`}
    <div class="st-grid2">
      <div><h4>Issue des dossiers</h4>${barres(issues)}</div>
      <div><h4>Type de réclamation</h4>${barres(types)}${sansType ? `<p class="st-note">${sansType} dossier(s) sans type renseigné.</p>` : ""}</div>
    </div>
  </div>`;
}

function sectionFournisseurs(cur) {
  const groupes = new Map();
  cur.forEach((d) => { if (!groupes.has(d.fournisseur)) groupes.set(d.fournisseur, []); groupes.get(d.fournisseur).push(d); });
  const lignes = [...groupes.entries()].map(([nom, ds]) => {
    const dF = ds.map((d) => d.delaiFournisseur).filter((x) => x != null);
    const vals = ds.filter((d) => d.valeur != null);
    const refus = ds.filter((d) => d.issue === "Refus fournisseur").length;
    const typeMaj = compter(ds.flatMap((d) => d.types))[0];
    const refMaj = compter(ds.map((d) => d.ref))[0];
    return {
      nom, dossiers: ds.length, part: ds.length / cur.length,
      fab: ds.filter((d) => d.types.includes("Défaut de fabrication")).length,
      manq: ds.filter((d) => d.types.includes("Pièce manquante")).length,
      refus, tauxRefus: refus / ds.length,
      delai: mediane(dF), delaiN: dF.length,
      valeur: vals.length ? vals.reduce((s, d) => s + d.valeur, 0) : null, valeurN: vals.length,
      typeMaj: typeMaj ? typeMaj[0] : "",
      refMaj: refMaj && refMaj[1] > 1 ? `${refMaj[0]} (${refMaj[1]})` : "",
    };
  });
  const filtre = STATS.filters.fournisseur;
  return `
  <div class="panel" id="st-fournisseurs"><h3>Fournisseurs</h3>
    <p class="st-note">${filtre ? `Filtré sur <b>${esc(filtre)}</b> — <a href="#" data-action="fournisseur:">voir tous les fournisseurs</a>.` : "Cliquez sur un fournisseur pour filtrer toute la page sur lui (produits, magasins, clients…)."}</p>
    ${tableau("fournisseurs", [
      { key: "nom", label: "Fournisseur" },
      { key: "dossiers", label: "Dossiers", num: true },
      { key: "part", label: "Part", num: true, html: (l) => pct(l.dossiers, cur.length) },
      { key: "fab", label: "Défaut fab.", num: true },
      { key: "manq", label: "Pièce manquante", num: true },
      { key: "tauxRefus", label: "Refus", num: true, html: (l) => l.refus ? `${l.refus} (${pct(l.refus, l.dossiers)})` : "0" },
      { key: "delai", label: "Délai fournisseur", num: true, html: (l) => l.delai != null ? `${l.delai} j <span class="st-cov">(${l.delaiN})</span>` : "—" },
      { key: "valeur", label: "Valeur produits", num: true, html: (l) => l.valeur != null ? `${euros(l.valeur)} <span class="st-cov">(${l.valeurN})</span>` : "—" },
      { key: "refMaj", label: "Produit le plus fréquent" },
    ], lignes, { action: (l) => "fournisseur:" + l.nom })}
    <p class="st-note">Délai fournisseur = médiane entre « Demande au fournisseur » et « Réception à l'entrepôt ». Entre parenthèses : nombre de dossiers où l'information existe.</p>
  </div>`;
}

function sectionProduits(cur) {
  const groupes = new Map();
  cur.filter((d) => d.ref).forEach((d) => { if (!groupes.has(d.ref)) groupes.set(d.ref, []); groupes.get(d.ref).push(d); });
  const lignes = [...groupes.entries()].map(([ref, ds]) => {
    const vals = ds.filter((d) => d.valeur != null).map((d) => d.valeur);
    return {
      ref,
      designation: ds.map((d) => d.designation).find(Boolean) || "",
      fournisseur: compter(ds.map((d) => d.fournisseur))[0][0],
      dossiers: ds.length,
      pieces: compter(ds.map((d) => d.piece)).slice(0, 3).map(([p, n]) => n > 1 ? `${p} (${n})` : p).join(", "),
      prix: vals.length ? mediane(vals) : null,
    };
  });
  const recurrents = lignes.filter((l) => l.dossiers > 1).length;
  const sansRef = cur.filter((d) => !d.ref).length;
  return `
  <div class="panel"><h3>Produits</h3>
    <p class="st-note">${groupes.size} références différentes, dont <b>${recurrents}</b> avec au moins 2 SAV. Les références sont saisies en texte libre : « Sandra SX » et « SANDRA SX » sont regroupées, mais « Sandra » seul resterait à part.${sansRef ? ` ${sansRef} dossier(s) sans référence.` : ""}</p>
    ${tableau("produits", [
      { key: "ref", label: "Référence" },
      { key: "dossiers", label: "Dossiers", num: true },
      { key: "fournisseur", label: "Fournisseur" },
      { key: "pieces", label: "Pièces concernées" },
      { key: "prix", label: "Prix de vente", num: true, html: (l) => l.prix != null ? euros(l.prix) : "—" },
    ], lignes, { limite: 25, triDefaut: { key: "dossiers", dir: -1 } })}
  </div>`;
}

function sectionMagasins(cur, prec, b) {
  const noms = [...new Set(cur.concat(prec || []).flatMap((d) => d.magasins))];
  const lignes = noms.map((m) => {
    const ds = cur.filter((d) => d.magasins.includes(m));
    const nPrec = prec ? prec.filter((d) => d.magasins.includes(m)).length : null;
    const four = compter(ds.map((d) => d.fournisseur))[0];
    const dPec = ds.map((d) => d.delaiPriseEnCharge).filter((x) => x != null);
    return {
      nom: m, dossiers: ds.length, nPrec,
      evol: nPrec ? (ds.length - nPrec) / nPrec : null,
      fournisseur: four ? `${four[0]} (${four[1]})` : "",
      enCours: ds.filter((d) => d.issue === "En cours").length,
      delai: mediane(dPec), delaiN: dPec.length,
    };
  }).filter((l) => l.dossiers || l.nPrec);
  return `
  <div class="panel"><h3>Magasins</h3>
    ${tableau("magasins", [
      { key: "nom", label: "Magasin" },
      { key: "dossiers", label: "Dossiers", num: true },
      { key: "evol", label: "Évolution", num: true, html: (l) => l.nPrec == null ? "—" : l.evol == null ? `${l.dossiers} (avant : 0)` : `${l.evol > 0 ? "+" : ""}${Math.round(l.evol * 100)} % <span class="st-cov">(avant : ${l.nPrec})</span>` },
      { key: "enCours", label: "En cours", num: true },
      { key: "delai", label: "Prise en charge", num: true, html: (l) => l.delai != null ? `${l.delai} j <span class="st-cov">(${l.delaiN})</span>` : "—" },
      { key: "fournisseur", label: "Fournisseur principal" },
    ], lignes)}
    <p class="st-note">Chiffres bruts : sans le chiffre d'affaires de chaque magasin, ils ne disent pas lequel « fait le plus de SAV pour 100 ventes ».${b.prec ? ` Évolution comparée à ${esc(b.libellePrec)}.` : ""} Un dossier rattaché à deux magasins compte dans les deux.</p>
  </div>`;
}

function sectionClients(cur) {
  const externes = cur.filter((d) => !d.clientInterne && d.clientCle);
  const internes = cur.filter((d) => d.clientInterne);
  const parClient = new Map();
  externes.forEach((d) => { if (!parClient.has(d.clientCle)) parClient.set(d.clientCle, []); parClient.get(d.clientCle).push(d); });
  const recidivistes = [...parClient.values()].filter((ds) => ds.length > 1).map((ds) => {
    const tri = [...ds].sort((a, b) => (a.date < b.date ? 1 : -1));
    return {
      nom: tri.find((d) => d.clientTexte)?.clientTexte || "?",
      dossiers: ds.length,
      lie: ds.some((d) => d.clientLie),
      magasins: [...new Set(ds.flatMap((d) => d.magasins))].join(", "),
      fournisseurs: [...new Set(ds.map((d) => d.fournisseur))].join(", "),
      produits: [...new Set(ds.map((d) => d.refBrute).filter(Boolean))].slice(0, 3).join(", "),
      dernier: tri[0].date,
    };
  });
  const ages = externes.map((d) => d.ageProduitJours).filter((x) => x != null);
  const tranches = [
    ["Moins d'1 mois", 0, 30], ["1 à 3 mois", 31, 91], ["3 à 6 mois", 92, 182],
    ["6 mois à 1 an", 183, 365], ["1 à 2 ans", 366, 730],
  ].map(([label, a, z]) => { const n = ages.filter((x) => x >= a && x <= z).length; return { label, value: n, valueLabel: `${n} (${pct(n, ages.length)})` }; });
  return `
  <div class="panel"><h3>Clients</h3>
    <div class="st-tiles">
      ${tuile("Clients distincts", parClient.size, couverture(externes.length) + " clients")}
      ${tuile("Clients avec plusieurs SAV", recidivistes.length, pct(recidivistes.length, parClient.size) + " des clients")}
      ${tuile("Dossiers internes", internes.length, "casse magasin / expo / entrepôt (" + pct(internes.length, cur.length) + ")")}
      ${tuile("Âge médian du produit", ages.length ? mediane(ages) + " j" : "—", "achat → réclamation, " + couverture(ages.length, externes.length))}
    </div>
    <div class="st-grid2">
      <div><h4>Âge du produit au moment du SAV</h4>${barres(tranches.filter((t) => t.value))}
        <p class="st-note">Calculé ${couverture(ages.length, externes.length)} (date d'achat renseignée). Repère : la garantie légale de conformité dure 2 ans.</p></div>
      <div><h4>Clients avec plusieurs dossiers</h4>
        ${tableau("recidivistes", [
          { key: "nom", label: "Client" },
          { key: "dossiers", label: "SAV", num: true },
          { key: "produits", label: "Produits" },
          { key: "dernier", label: "Dernier", html: (l) => l.dernier ? new Date(l.dernier + "T12:00").toLocaleDateString("fr-FR") : "—" },
        ], recidivistes, { limite: 15, triDefaut: { key: "dossiers", dir: -1 }, action: (l) => "client:" + l.nom })}
        <p class="st-note">Cliquez sur un client pour voir ses dossiers. Pour les anciens dossiers (sans fiche client), le regroupement se fait sur le nom saisi : deux homonymes peuvent être confondus.</p>
      </div>
    </div>
  </div>`;
}

function sectionQualite(cur, tousLesDossiers) {
  const n = cur.length;
  const champs = [
    ["Fournisseur", (d) => d.fournisseurRenseigne],
    ["Type de réclamation", (d) => d.types.length > 0],
    ["Référence produit", (d) => !!d.ref],
    ["Prix de vente (Claim Amount)", (d) => d.valeur != null],
    ["Date d'achat", (d) => !!d.dateAchat],
    ["Date de demande au fournisseur", (d) => d.demandeFournisseur],
    ["Solution proposée", (d) => !!d.solution],
    ["Qualification retenue", (d) => !!d.qualification],
    ["Fiche client liée", (d) => d.clientLie],
  ].map(([label, test]) => { const k = cur.filter(test).length; return { label, value: k, valueLabel: `${pct(k, n)} (${k}/${n})` }; });
  const aberrants = tousLesDossiers.filter((d) => d.valeurAberrante);
  const datesSuspectes = tousLesDossiers.filter((d) => !d.date || d.date < "2020-01-01");
  return `
  <div class="panel"><h3>Qualité de saisie</h3>
    <p class="st-note">Taux de remplissage des champs sur la sélection. Plus ils sont remplis, plus les chiffres ci-dessus sont fiables. « Qualification retenue » est indispensable pour mesurer la part de produits abîmés par les clients.</p>
    ${barres(champs, { muted: true })}
    ${aberrants.length ? `<h4>Prix de vente probablement faux (exclus des calculs)</h4>
      <ul class="st-list">${aberrants.map((d) => `<li class="st-click" data-action="dossier:${d.id}">${esc(d.refBrute || "?")} — ${esc(d.fournisseur)} — <b>${euros(d.valeurAberrante)}</b> <span class="st-cov">(virgule oubliée ?)</span></li>`).join("")}</ul>` : ""}
    ${datesSuspectes.length ? `<h4>Dossiers sans date de demande valide (absents des statistiques)</h4>
      <ul class="st-list">${datesSuspectes.map((d) => `<li class="st-click" data-action="dossier:${d.id}">${esc(d.clientTexte || "?")} — ${esc(d.refBrute || "?")} — date : ${esc(d.date || "vide")}</li>`).join("")}</ul>` : ""}
  </div>`;
}

/* ---------- rendu ---------- */
function renderStats() {
  const view = $("#statsView");
  const tous = STATS.records;
  const b = bornesPeriode(STATS.filters.periode);
  const cur = filtrer(tous, b.debut, b.fin);
  const prec = b.prec ? filtrer(tous, b.prec.debut, b.prec.fin) : null;

  const magasins = [...new Set(tous.flatMap((d) => d.magasins))].sort();
  const fournisseurs = compter(tous.map((d) => d.fournisseur)).map(([k]) => k);
  const opt = (v, lib, cur) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(lib)}</option>`;
  const heure = STATS.loadedAt.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

  view.innerHTML = `
    <div class="detail-backlink" id="statsBack">&larr; Retour à la liste</div>
    <div class="detail-header"><div><h2>Statistiques SAV</h2>
      <div class="sub">${tous.length} dossiers chargés à ${heure} · <a href="#" id="statsRefresh">actualiser</a></div></div></div>
    <div class="toolbar st-filters">
      <select id="stPeriode">
        ${opt("12m", "12 derniers mois", STATS.filters.periode)}
        ${opt("annee", "Cette année", STATS.filters.periode)}
        ${opt("anneeprec", "L'année dernière", STATS.filters.periode)}
        ${opt("tout", "Depuis le début", STATS.filters.periode)}
      </select>
      <select id="stMagasin">${opt("", "Tous magasins", STATS.filters.magasin)}${magasins.map((m) => opt(m, m, STATS.filters.magasin)).join("")}</select>
      <select id="stFournisseur">${opt("", "Tous fournisseurs", STATS.filters.fournisseur)}${fournisseurs.map((f) => opt(f, f, STATS.filters.fournisseur)).join("")}</select>
    </div>
    ${cur.length ? `
      ${sectionVueEnsemble(cur, prec, b)}
      ${sectionFournisseurs(cur)}
      ${sectionProduits(cur)}
      ${sectionMagasins(cur, prec, b)}
      ${sectionClients(cur)}
      ${sectionQualite(cur, tous)}
    ` : `<div class="empty-state">Aucun dossier sur cette sélection.</div>`}
  `;

  $("#statsBack").addEventListener("click", showList);
  $("#statsRefresh").addEventListener("click", (e) => { e.preventDefault(); chargerStats(true); });
  $("#stPeriode").addEventListener("change", (e) => { STATS.filters.periode = e.target.value; renderStats(); });
  $("#stMagasin").addEventListener("change", (e) => { STATS.filters.magasin = e.target.value; renderStats(); });
  $("#stFournisseur").addEventListener("change", (e) => { STATS.filters.fournisseur = e.target.value; renderStats(); });
}

// Un seul écouteur délégué pour tout l'écran (tri des tableaux + éléments cliquables), posé une
// fois : le contenu est régénéré à chaque filtre, l'écouteur sur le conteneur reste.
function brancherClicsStats() {
  $("#statsView").addEventListener("click", (e) => {
    const th = e.target.closest("th[data-table]");
    if (th) {
      const id = th.dataset.table, key = th.dataset.key;
      const s = STATS.sort[id];
      STATS.sort[id] = { key, dir: s && s.key === key ? -s.dir : (key === "nom" || key === "ref" ? 1 : -1) };
      renderStats();
      return;
    }
    const el = e.target.closest("[data-action]");
    if (!el) return;
    e.preventDefault();
    const action = el.dataset.action;
    const sep = action.indexOf(":");
    const type = action.slice(0, sep), valeur = action.slice(sep + 1);
    if (type === "fournisseur") {
      STATS.filters.fournisseur = valeur;
      renderStats();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else if (type === "dossier") {
      openDossier(valeur);
    } else if (type === "client") {
      $("#searchInput").value = valeur;
      showList();
    }
  });
}

async function chargerStats(forcer) {
  const view = $("#statsView");
  if (STATS.records && !forcer) { renderStats(); return; }
  view.innerHTML = '<div class="loading">Chargement de tous les dossiers…</div>';
  try {
    const data = await api("/api/gestion/stats");
    STATS.records = data.records.map(preparer);
    STATS.loadedAt = new Date();
    renderStats();
  } catch (e) {
    view.innerHTML = `<div class="detail-backlink" id="statsBack">&larr; Retour à la liste</div><div class="empty-state">${esc(e.message)}</div>`;
    $("#statsBack").addEventListener("click", showList);
  }
}

function showStats() {
  if (state.role !== "full") return;
  if (new URLSearchParams(location.search).get("vue") !== "stats") {
    history.pushState({}, "", `${location.pathname}?vue=stats`);
  }
  $("#listView").classList.add("hidden");
  $("#detailView").classList.add("hidden");
  $("#statsView").classList.remove("hidden");
  window.scrollTo(0, 0);
  chargerStats(false);
}

$("#btnStats").addEventListener("click", showStats);
brancherClicsStats();
