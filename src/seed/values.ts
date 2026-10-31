import { randomBytes, randomInt, randomUUID } from "node:crypto";
import type { Column } from "../discover/catalog.ts";

/** What the simple shapes of a column's CHECK constraints allow (DESIGN.md section 7.1). */
export interface ColumnHints {
  allowed?: (string | number)[];
  min?: number;
  minInclusive?: boolean;
  max?: number;
  maxInclusive?: boolean;
  minLength?: number;
  maxLength?: number;
}

const MULTI_WORD_TYPES =
  "character varying|double precision|timestamp with(?:out)? time zone|time with(?:out)? time zone|bit varying";

/** Removes type casts and redundant parentheses, so `((amount > (0)::numeric))` reads `amount > 0`. */
export function normalizeCheck(definition: string): string {
  let text = definition.replace(/^CHECK\s*/i, "");
  const cast = new RegExp(
    `::(?:${MULTI_WORD_TYPES}|"[^"]+"|[a-z_][a-z0-9_.]*)(?:\\(\\d+(?:,\\s*\\d+)?\\))?(?:\\[\\])?`,
    "gi",
  );
  text = text.replace(cast, "");
  const simple = /(?<![\w"])\(\s*("[^"]+"|[\w.]+|'(?:[^']|'')*'|-?\d+(?:\.\d+)?)\s*\)/g;
  let previous: string;
  do {
    previous = text;
    text = text.replace(simple, "$1");
  } while (text !== previous);
  return stripOuterParentheses(text.trim());
}

/** `((a > 0))` becomes `a > 0`; `(a > 0) AND (b > 0)` stays as it is. */
function stripOuterParentheses(text: string): string {
  let current = text;
  for (;;) {
    if (!current.startsWith("(") || !current.endsWith(")")) return current;
    let depth = 0;
    let closesAtEnd = true;
    for (let i = 0; i < current.length; i++) {
      if (current[i] === "(") depth++;
      else if (current[i] === ")") depth--;
      if (depth === 0 && i < current.length - 1) {
        closesAtEnd = false;
        break;
      }
    }
    if (!closesAtEnd) return current;
    current = current.slice(1, -1).trim();
  }
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function columnPattern(column: string): string {
  const name = escapeRegex(column);
  return column === "VALUE" ? "VALUE" : `(?:"${name}"|(?<![\\w."])${name}(?![\\w"]))`;
}

const NUMBER = "(-?\\d+(?:\\.\\d+)?)";
const FLIP: Readonly<Record<string, string>> = { ">": "<", ">=": "<=", "<": ">", "<=": ">=", "=": "=" };

function applyBound(hints: ColumnHints, op: string, value: number, target: "value" | "length"): void {
  if (target === "length") {
    if (op === ">") hints.minLength = Math.max(hints.minLength ?? 0, Math.floor(value) + 1);
    if (op === ">=") hints.minLength = Math.max(hints.minLength ?? 0, Math.ceil(value));
    if (op === "<") hints.maxLength = Math.min(hints.maxLength ?? Infinity, Math.ceil(value) - 1);
    if (op === "<=") hints.maxLength = Math.min(hints.maxLength ?? Infinity, Math.floor(value));
    if (op === "=") {
      hints.minLength = value;
      hints.maxLength = value;
    }
    return;
  }
  if (op === ">" || op === ">=") {
    if (hints.min === undefined || value > hints.min) {
      hints.min = value;
      hints.minInclusive = op === ">=";
    }
  }
  if (op === "<" || op === "<=") {
    if (hints.max === undefined || value < hints.max) {
      hints.max = value;
      hints.maxInclusive = op === "<=";
    }
  }
  if (op === "=") hints.allowed = [value];
}

/** Reads the simple shapes of CHECK constraints that mention `column`. Anything else is ignored. */
export function parseCheckHints(column: string, definitions: readonly string[]): ColumnHints {
  const hints: ColumnHints = {};
  const col = columnPattern(column);
  for (const definition of definitions) {
    const text = normalizeCheck(definition);
    const list = new RegExp(`${col}\\s*=\\s*ANY\\s*\\(\\s*\\(?\\s*ARRAY\\[(.*?)\\]`, "i").exec(text) ??
      new RegExp(`${col}\\s+IN\\s*\\((.*?)\\)`, "i").exec(text);
    if (list?.[1] !== undefined) {
      const strings = [...list[1].matchAll(/'((?:[^']|'')*)'/g)].map((m) => (m[1] ?? "").replaceAll("''", "'"));
      const values: (string | number)[] = strings.length > 0 ? strings : [...list[1].matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
      if (values.length > 0) hints.allowed = values;
    }
    const lengthFn = `(?:char_length|character_length|length)\\(\\s*${col}\\s*\\)`;
    for (const m of text.matchAll(new RegExp(`${lengthFn}\\s*(>=|<=|>|<|=)\\s*${NUMBER}`, "gi"))) {
      applyBound(hints, m[1] as string, Number(m[2]), "length");
    }
    for (const m of text.matchAll(new RegExp(`${NUMBER}\\s*(>=|<=|>|<|=)\\s*${lengthFn}`, "gi"))) {
      applyBound(hints, FLIP[m[2] as string] as string, Number(m[1]), "length");
    }
    for (const m of text.matchAll(new RegExp(`${col}\\s*(>=|<=|>|<|=)\\s*${NUMBER}`, "gi"))) {
      applyBound(hints, m[1] as string, Number(m[2]), "value");
    }
    for (const m of text.matchAll(new RegExp(`${NUMBER}\\s*(>=|<=|>|<|=)\\s*${col}`, "gi"))) {
      applyBound(hints, FLIP[m[2] as string] as string, Number(m[1]), "value");
    }
    if (new RegExp(`${col}\\s*<>\\s*''`, "i").test(text)) hints.minLength = Math.max(hints.minLength ?? 0, 1);
  }
  return hints;
}

/** The check definitions that can constrain one column: table checks naming it, plus its domain checks with VALUE swapped in. */
export function hintsForColumn(column: Column, tableChecks: readonly { columns: string[]; definition: string }[]): ColumnHints {
  const own = tableChecks.filter((check) => check.columns.includes(column.name)).map((check) => check.definition);
  const fromTable = parseCheckHints(column.name, own);
  const fromDomain = parseCheckHints("VALUE", column.type.domainChecks);
  return { ...fromDomain, ...fromTable };
}

export function randomTag(length = 6): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(length);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

export type TenantLabel = "A" | "B" | "S";

export interface ValueRequest {
  column: Column;
  hints: ColumnHints;
  tenant: TenantLabel;
  /** Short table name, used inside text markers. */
  table: string;
  index: number;
  /** When set, the value must differ from this one (used for update probes). */
  differentFrom?: unknown;
}

export type Generated = { ok: true; value: unknown } | { ok: false; reason: string };

const TEXT_TYPES = new Set(["text", "varchar", "bpchar", "citext", "name"]);
const INTEGER_TYPES = new Map([
  ["int2", 32_767],
  ["int4", 2_147_483_647],
  ["int8", 2_147_483_647],
]);
const DECIMAL_TYPES = new Set(["numeric", "float4", "float8", "money"]);

function textValue(request: ValueRequest): Generated {
  const { column, hints, tenant } = request;
  const limit = Math.min(column.maxLength ?? Infinity, hints.maxLength ?? Infinity);
  const minimum = hints.minLength ?? 0;
  const tag = randomTag();
  const lower = column.name.toLowerCase();
  let value: string;
  if (/e?mail/.test(lower)) value = `tlc-${tenant.toLowerCase()}-${tag}@example.com`;
  else if (/(^|_)(url|website|link|href)($|_)/.test(lower)) value = `https://example.com/tlc-${tenant.toLowerCase()}-${tag}`;
  else if (/(^|_)(phone|mobile|cell|whatsapp)($|_)/.test(lower)) value = `+1555${String(randomInt(1_000_000, 9_999_999))}`;
  else value = `tlc-${tenant}-${request.table}-${request.index}-${tag}`.slice(0, 63);
  if (value.length > limit) value = `t${tenant}${randomTag(Math.max(1, limit - 2))}`.slice(0, limit);
  while (value.length < minimum) value += randomTag(1);
  if (value.length > limit || value.length < minimum) {
    return { ok: false, reason: `column ${column.name} needs a text length the tool could not produce` };
  }
  return { ok: true, value };
}

function numberInRange(hints: ColumnHints, integer: boolean, ceiling: number): Generated {
  let low = hints.min ?? 1;
  if (hints.min !== undefined && hints.minInclusive === false) low = integer ? Math.floor(hints.min) + 1 : hints.min + 0.01;
  if (integer) low = Math.ceil(low);
  let high = hints.max ?? (hints.min !== undefined ? low + 1000 : 1000);
  if (hints.max !== undefined && hints.maxInclusive === false) high = integer ? Math.ceil(hints.max) - 1 : hints.max - 0.01;
  high = Math.min(high, ceiling);
  if (integer) high = Math.floor(high);
  if (low > high) return { ok: false, reason: "no number satisfies the column's rules" };
  if (integer) return { ok: true, value: low === high ? low : randomInt(low, high + 1) };
  const value = Math.round((low + Math.random() * (high - low)) * 100) / 100;
  return { ok: true, value: Math.min(Math.max(value, low), high) };
}

/** A synthetic value for one column that respects its type and simple CHECK rules. */
export function generateValue(request: ValueRequest): Generated {
  const { column, hints } = request;
  const base = column.type.base;
  const differs = (value: unknown): boolean => request.differentFrom === undefined || String(value) !== String(request.differentFrom);
  const allowed = hints.allowed ?? (column.type.category === "E" && column.type.enumLabels.length > 0 ? column.type.enumLabels : undefined);
  if (allowed && column.type.category !== "A") {
    const choice = allowed.find(differs);
    return choice === undefined
      ? { ok: false, reason: `column ${column.name} allows only one value, so it cannot be changed` }
      : { ok: true, value: choice };
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const generated = generateOnce(request, base);
    if (!generated.ok || differs(generated.value)) return generated;
  }
  return { ok: false, reason: `column ${column.name} could not be given a different value` };
}

function generateOnce(request: ValueRequest, base: string): Generated {
  const { column, hints } = request;
  if (column.type.category === "A") return { ok: true, value: [] };
  if (TEXT_TYPES.has(base)) return textValue(request);
  const intCeiling = INTEGER_TYPES.get(base);
  if (intCeiling !== undefined) return numberInRange(hints, true, intCeiling);
  if (DECIMAL_TYPES.has(base)) return numberInRange(hints, false, 1e9);
  const today = new Date();
  switch (base) {
    case "uuid":
      return { ok: true, value: randomUUID() };
    case "bool":
      return { ok: true, value: request.differentFrom === undefined ? true : request.differentFrom !== true };
    case "date":
      return { ok: true, value: today.toISOString().slice(0, 10) };
    case "timestamp":
    case "timestamptz":
      return { ok: true, value: today.toISOString() };
    case "time":
    case "timetz":
      return { ok: true, value: `${String(randomInt(8, 18)).padStart(2, "0")}:00:00` };
    case "interval":
      return { ok: true, value: `${randomInt(1, 30)} days` };
    case "json":
    case "jsonb":
      return { ok: true, value: { tlc: `tlc-${request.tenant}-${randomTag()}` } };
    case "bytea":
      return { ok: true, value: "\\x746c63" };
    case "inet":
    case "cidr":
      return { ok: true, value: `192.0.2.${randomInt(1, 255)}` };
    case "macaddr":
      return { ok: true, value: "08:00:2b:01:02:03" };
    case "tsvector":
      return { ok: true, value: `tlc ${request.tenant.toLowerCase()}` };
    default:
      return { ok: false, reason: `column ${column.name} has the type ${column.type.display}, which the tool cannot fill in yet` };
  }
}
