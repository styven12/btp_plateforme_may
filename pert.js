// pert.js — Durées aléatoires (loi Bêta-PERT) et simulation de Monte Carlo
// Aucune dépendance externe.

// --- Tirage d'une loi Normale centrée réduite (Box-Muller) ---
function randNormal() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// --- Tirage d'une loi Gamma(k, 1) — méthode de Marsaglia-Tsang ---
function randGamma(k) {
  if (k < 1) {
    const u = Math.random();
    return randGamma(1 + k) * Math.pow(u, 1 / k);
  }
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x, v;
    do {
      x = randNormal();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

// --- Tirage d'une loi Bêta(alpha, beta) à partir de deux lois Gamma ---
function randBeta(alpha, beta) {
  const x = randGamma(alpha);
  const y = randGamma(beta);
  return x / (x + y);
}

// --- Tirage d'une durée selon la loi Bêta-PERT(o, m, p) ---
// lambda = 4 est la valeur standard de la méthode PERT
function randBetaPert(o, m, p, lambda = 4) {
  if (!(p > o)) return m; // garde-fou si les 3 valeurs sont incohérentes (ou toutes égales)
  const alpha = 1 + (lambda * (m - o)) / (p - o);
  const beta = 1 + (lambda * (p - m)) / (p - o);
  const sample = randBeta(alpha, beta);
  return o + sample * (p - o);
}

// --- Formules PERT classiques d'UNE tâche ---
// moyenne = (o + 4m + p) / 6      écart-type = (p - o) / 6
function pertStats(o, m, p) {
  const mean = (o + 4 * m + p) / 6;
  const sd = (p - o) / 6;
  return { mean, sd, variance: sd * sd };
}

// --- Fonction de répartition de la loi Normale (approximation d'Abramowitz-Stegun) ---
function normalCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

// --- Construit un histogramme simple à partir d'un tableau de valeurs triées ---
function buildHistogram(sortedValues, bins = 20) {
  const min = sortedValues[0];
  const max = sortedValues[sortedValues.length - 1];
  const width = (max - min) / bins || 1;
  const counts = new Array(bins).fill(0);
  for (const v of sortedValues) {
    let idx = Math.floor((v - min) / width);
    if (idx >= bins) idx = bins - 1;
    counts[idx]++;
  }
  return { min, max, width, counts };
}

// --- Simulation de Monte Carlo sur une liste de tâches [{id, o, m, p}, ...] ---
// Chaque tirage = somme des durées tirées au hasard (tâches faites l'une après l'autre).
// target (optionnel) = délai en jours dont on veut la probabilité de respect.
function runMonteCarlo(tasks, iterations = 5000, target = null) {
  const totals = new Array(iterations);
  for (let i = 0; i < iterations; i++) {
    let total = 0;
    for (const t of tasks) total += randBetaPert(t.o, t.m, t.p);
    totals[i] = total;
  }
  totals.sort((a, b) => a - b);
  const pct = (q) => totals[Math.min(iterations - 1, Math.floor(q * iterations))];

  // Moyenne et écart-type du chantier = somme des moyennes, racine de la somme des variances
  let mean = 0, variance = 0;
  for (const t of tasks) {
    const s = pertStats(t.o, t.m, t.p);
    mean += s.mean;
    variance += s.variance;
  }
  const sd = Math.sqrt(variance);

  const out = {
    iterations,
    nbTasks: tasks.length,
    mean, sd,
    p10: pct(0.10), p50: pct(0.50), p80: pct(0.80), p90: pct(0.90),
    min: totals[0],
    max: totals[iterations - 1],
    histogram: buildHistogram(totals, 20),
  };

  if (typeof target === 'number' && isFinite(target)) {
    let n = 0;
    while (n < iterations && totals[n] <= target) n++;     // nombre de tirages finis dans le délai
    out.target = target;
    out.probTarget = n / iterations;                        // probabilité par Monte Carlo
    out.probTargetNormal = sd > 0 ? normalCdf((target - mean) / sd) : (target >= mean ? 1 : 0); // approx. normale
  }
  return out;
}

module.exports = { randBetaPert, pertStats, normalCdf, runMonteCarlo };
