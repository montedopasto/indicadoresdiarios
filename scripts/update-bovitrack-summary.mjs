import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

// A televisão recebe somente este resumo; os registos individuais nunca são publicados no painel.

const SOURCE_URL = process.env.BOVITRACK_SOURCE_URL ||
  "https://script.google.com/macros/s/AKfycbxyobcRj8Phe6rCZKW-7kcOunoF5difoXlTtLKXCnZA_oprNAXwlqrZDTQcuTLQ0_35/exec";
const summaryUrl = new URL(SOURCE_URL);
summaryUrl.searchParams.set("type", "summary");
const OUTPUT_PATH = resolve(process.argv[2] || "data/bovitrack-summary.json");

function readSexMetrics(metrics) {
  const { averageWeightKg, averageGmdKgDay, averageAgeMonths } = metrics ?? {};
  const values = [averageWeightKg, averageGmdKgDay, averageAgeMonths];
  if (!values.every((value) => value === null || Number.isFinite(value))) {
    throw new Error("A fonte BoviTrack devolveu métricas inválidas");
  }
  return { averageWeightKg, averageGmdKgDay, averageAgeMonths };
}

async function previousSummary() {
  try {
    return JSON.parse(await readFile(OUTPUT_PATH, "utf8"));
  } catch {
    return null;
  }
}

const response = await fetch(summaryUrl, { headers: { accept: "application/json" } });
if (!response.ok) throw new Error(`BoviTrack respondeu com HTTP ${response.status}`);

const source = await response.json();
if (source?.schemaVersion !== 2 || !Number.isSafeInteger(source.totalAnimals) || source.totalAnimals <= 0) {
  throw new Error("A fonte BoviTrack não devolveu um resumo válido com animais");
}

const currentMetrics = {
  totalAnimals: source.totalAnimals,
  male: readSexMetrics(source.male),
  female: readSexMetrics(source.female)
};
const prior = await previousSummary();
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
