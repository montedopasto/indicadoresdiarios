import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

// A televisão recebe somente este resumo; os registos individuais nunca são publicados no painel.

const SOURCE_URL = process.env.BOVITRACK_SOURCE_URL ||
  "https://script.google.com/macros/s/AKfycbxyobcRj8Phe6rCZKW-7kcOunoF5difoXlTtLKXCnZA_oprNAXwlqrZDTQcuTLQ0_35/exec";
const OUTPUT_PATH = resolve(process.argv[2] || "data/bovitrack-summary.json");

function text(value) {
  return String(value ?? "").trim();
}

function number(value) {
  const parsed = Number.parseFloat(text(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function date(value) {
  const input = text(value);
  let match = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  match = input.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  if (match) return new Date(Date.UTC(+match[3], +match[2] - 1, +match[1]));
  return null;
}

function daysBetween(start, end) {
  return Math.floor((end.getTime() - start.getTime()) / 86400000);
}

function round(value, digits) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function emptySex() {
  return {
    count: 0,
    weightTotal: 0,
    weightCount: 0,
    gmdTotal: 0,
    gmdCount: 0,
    ageTotal: 0,
    ageCount: 0
  };
}

function publicSexSummary(data) {
  return {
    averageWeightKg: round(data.weightCount ? data.weightTotal / data.weightCount : null, 1),
    averageGmdKgDay: round(data.gmdCount ? data.gmdTotal / data.gmdCount : null, 2),
    averageAgeMonths: round(data.ageCount ? data.ageTotal / data.ageCount : null, 1)
  };
}

async function previousSummary() {
  try {
    return JSON.parse(await readFile(OUTPUT_PATH, "utf8"));
  } catch {
    return null;
  }
}

const response = await fetch(SOURCE_URL, { headers: { accept: "application/json" } });
if (!response.ok) throw new Error(`BoviTrack respondeu com HTTP ${response.status}`);

const rows = await response.json();
if (!Array.isArray(rows) || !rows.length) throw new Error("A fonte BoviTrack não devolveu animais");

const now = new Date();
const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const aggregate = { M: emptySex(), F: emptySex() };

for (const row of rows) {
  const sex = text(row.sexo).toUpperCase();
  if (sex !== "M" && sex !== "F") continue;
  const bucket = aggregate[sex];
  bucket.count += 1;

  const currentWeight = number(row.peso_atual);
  if (currentWeight !== null && currentWeight > 0) {
    bucket.weightTotal += currentWeight;
    bucket.weightCount += 1;
  }

  const birthDate = date(row.data_nasc);
  if (birthDate && birthDate <= today) {
    bucket.ageTotal += daysBetween(birthDate, today) / 30.4375;
    bucket.ageCount += 1;
  }

  const previousWeight = number(row.peso_anterior);
  const previousDate = date(row.data_peso_anterior);
  const currentDate = date(row.data_peso_atual);
  if (previousWeight !== null && currentWeight !== null && previousDate && currentDate) {
    const days = daysBetween(previousDate, currentDate);
    const gmd = days > 0 ? (currentWeight - previousWeight) / days : null;
    if (gmd !== null && gmd >= 0 && gmd <= 3) {
      bucket.gmdTotal += gmd;
      bucket.gmdCount += 1;
    }
  }
}

const prior = await previousSummary();
const currentMetrics = {
  totalAnimals: aggregate.M.count + aggregate.F.count,
  male: publicSexSummary(aggregate.M),
  female: publicSexSummary(aggregate.F)
};
const priorMetrics = prior ? {
  totalAnimals: prior.totalAnimals,
  male: prior.male,
  female: prior.female
} : null;

const day = new Date().toISOString().slice(0, 10);
const priorHistory = prior && Array.isArray(prior.history) ? prior.history : [];
const history = priorHistory.filter((entry) => entry && entry.day !== day).slice(-89);
history.push({
  day,
  totalAnimals: currentMetrics.totalAnimals,
  male: { averageGmdKgDay: currentMetrics.male.averageGmdKgDay },
  female: { averageGmdKgDay: currentMetrics.female.averageGmdKgDay }
});

const metricsChanged = !priorMetrics || JSON.stringify(priorMetrics) !== JSON.stringify(currentMetrics);
const historyChanged = JSON.stringify(priorHistory) !== JSON.stringify(history);

if (!metricsChanged && !historyChanged && prior?.schemaVersion === 2) {
  console.log(`Resumo BoviTrack sem alterações: ${currentMetrics.totalAnimals} animais`);
  process.exit(0);
}

const summary = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  ...currentMetrics,
  previous: metricsChanged && prior ? {
    totalAnimals: prior.totalAnimals ?? null,
    male: prior.male ?? null,
    female: prior.female ?? null
  } : (prior?.previous ?? null),
  history
};

await mkdir(dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(`Resumo BoviTrack atualizado: ${summary.totalAnimals} animais`);
