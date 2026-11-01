import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ToolError } from "../core/errors.ts";
import { redact } from "../probe/http.ts";
import { renderHtml } from "./html.ts";
import { renderJson } from "./json.ts";
import { renderMarkdown } from "./markdown.ts";
import type { AnyResult } from "./text.ts";

export const DEFAULT_OUT_DIR = "tlc-report";

/** Where the reports were written, for the last lines of the CLI output. */
export interface ReportPaths {
  json: string;
  markdown: string;
  html: string;
}

/**
 * The last line of defence before anything reaches disk: evidence is redacted when it is
 * recorded, every string of the result is redacted again before rendering, and every
 * rendered file once more after it (DESIGN.md section 11).
 */
export function redactReport(text: string): string {
  // Greedy up to the last "@" of the URL, so a password that itself holds "@" or "/" is covered too.
  return redact(text).replace(/(postgres(?:ql)?:\/\/)[^\s"'<>]+@/g, "$1[redacted]@");
}

/** Redacts every string inside a value, so each renderer starts from clean data whatever its escaping. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactReport(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item)])) as T;
  }
  return value;
}

/** Renders the JSON, Markdown and HTML reports into `outDir` (created if needed). */
export async function writeReports(raw: AnyResult, outDir: string): Promise<ReportPaths> {
  const result = redactDeep(raw);
  const dir = resolve(outDir);
  const paths: ReportPaths = { json: join(dir, "report.json"), markdown: join(dir, "report.md"), html: join(dir, "report.html") };
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(paths.json, redactReport(renderJson(result)));
    await writeFile(paths.markdown, redactReport(renderMarkdown(result)));
    await writeFile(paths.html, redactReport(renderHtml(result)));
  } catch (error) {
    throw new ToolError(`The reports could not be written to ${dir}: ${(error as Error).message}`, "Choose a folder you can write to with --out.");
  }
  return paths;
}
