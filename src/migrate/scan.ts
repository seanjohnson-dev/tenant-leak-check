/**
 * The static scan of new migrations (DESIGN.md section 9, step 2). It reads the SQL text only:
 * comments and string literals are blanked, function bodies are skipped, and each statement is
 * matched against the rules below. The probes, not this scan, decide whether anything leaks.
 */

/**
 * `destructive`: data or objects are lost. `security`: an access rule is weakened.
 * `attention`: worth a look, but common in healthy migrations. Only the first two need a human review.
 */
export type Severity = "destructive" | "security" | "attention";

export type StatementRule =
  | "drop_table"
  | "drop_view"
  | "drop_function"
  | "drop_policy"
  | "drop_schema"
  | "drop_trigger"
  | "truncate"
  | "drop_column"
  | "alter_column_type"
  | "delete_without_where"
  | "update_without_where"
  | "disable_rls"
  | "no_force_rls"
  | "grant_to_clients"
  | "security_definer"
  | "policy_always_true"
  | "do_block";

export interface StatementFinding {
  /** Base name of the migration file. */
  file: string;
  /** 1-based line where the statement starts. */
  line: number;
  rule: StatementRule;
  severity: Severity;
  /** The table, column, policy or function concerned, schema-qualified (`public` when the migration leaves it out). */
  object: string;
  /** Plain-English explanation for the report. */
  message: string;
  /** The statement as written, on one line, shortened to 200 characters. */
  statement: string;
}

export interface Statement {
  /**
   * The statement with comments removed, string literals replaced by `''`, dollar-quoted bodies by
   * `$$ $$`, whitespace collapsed, and everything lower-case except quoted identifiers.
   */
  text: string;
  /** The original text, whitespace collapsed. */
  original: string;
  line: number;
}

const STATEMENT_EXCERPT = 200;

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Splits SQL into statements, blanking comments, string literals and dollar-quoted bodies so
 * that a semicolon or a keyword inside them is never mistaken for real SQL.
 */
export function splitStatements(sql: string): Statement[] {
  const statements: Statement[] = [];
  let cleaned = "";
  let start = -1;
  let line = 1;
  let startLine = 1;
  const flush = (end: number): void => {
    const text = collapse(cleaned);
    if (text.length > 0 && start >= 0) {
      statements.push({ text, original: collapse(sql.slice(start, end)), line: startLine });
    }
    cleaned = "";
    start = -1;
  };
  const begin = (index: number): void => {
    if (start < 0) {
      start = index;
      startLine = line;
    }
  };
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i] as string;
    const next = sql[i + 1];
    if (ch === "\n") {
      line += 1;
      cleaned += " ";
      i += 1;
      continue;
    }
    if (ch === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      cleaned += " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      let depth = 0;
      while (i < sql.length) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          i += 2;
          if (depth === 0) break;
        } else {
          if (sql[i] === "\n") line += 1;
          i += 1;
        }
      }
      cleaned += " ";
      continue;
    }
    if (ch === ";") {
      flush(i);
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      cleaned += " ";
      i += 1;
      continue;
    }
    begin(i);
    if (ch === "'") {
      const escapes = /[eE]/.test(sql[i - 1] ?? "") && !/[A-Za-z0-9_]/.test(sql[i - 2] ?? "");
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "\n") line += 1;
        if (escapes && sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          break;
        }
        i += 1;
      }
      i += 1;
      cleaned += "''";
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === '"' && sql[j + 1] !== '"')) j += sql[j] === '"' ? 2 : 1;
      const quoted = sql.slice(i, j + 1);
      line += quoted.split("\n").length - 1;
      cleaned += quoted;
      i = j + 1;
      continue;
    }
    if (ch === "$") {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? "")) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        const end = close < 0 ? sql.length : close + tag[0].length;
        line += sql.slice(i, end).split("\n").length - 1;
        cleaned += "$$ $$";
        i = end;
        continue;
      }
    }
    cleaned += ch.toLowerCase();
    i += 1;
  }
  flush(sql.length);
  return statements;
}

/** One SQL name: a bare word or a quoted identifier, with the quotes removed. */
const NAME = String.raw`(?:"(?:[^"]|"")+"|[a-z_][a-z0-9_$]*)`;
const QUALIFIED = String.raw`${NAME}(?:\s*\.\s*${NAME})?`;

function unquote(part: string): string {
  const trimmed = part.trim();
  return trimmed.startsWith('"') ? trimmed.slice(1, -1).replaceAll('""', '"') : trimmed;
}

/** `Foo."Bar"` becomes `public.foo`-style `schema.name`, with `public` when no schema is given. */
export function qualifiedName(text: string, defaultSchema = "public"): string {
  const parts = text.match(new RegExp(NAME, "g")) ?? [];
  if (parts.length >= 2) return `${unquote(parts[0] as string)}.${unquote(parts[1] as string)}`;
  return `${defaultSchema}.${unquote(parts[0] ?? text)}`;
}

/** Splits a comma-separated list at the top level (not inside brackets). */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function names(list: string): string[] {
  return splitTopLevel(list)
    .map((item) => new RegExp(`^${QUALIFIED}`).exec(item.trim())?.[0])
    .filter((name): name is string => name !== undefined)
    .map((name) => qualifiedName(name));
}

type Draft = Omit<StatementFinding, "file" | "line" | "statement">;

const DROP_KIND: Readonly<Record<string, { rule: StatementRule; severity: Severity; message: (name: string) => string }>> = {
  table: { rule: "drop_table", severity: "destructive", message: (n) => `Deletes the table ${n} and every row in it.` },
  view: { rule: "drop_view", severity: "destructive", message: (n) => `Deletes the view ${n}; anything that reads it stops working.` },
  "materialized view": { rule: "drop_view", severity: "destructive", message: (n) => `Deletes the materialized view ${n}; anything that reads it stops working.` },
  function: { rule: "drop_function", severity: "destructive", message: (n) => `Deletes the function ${n}; callers and triggers that use it stop working.` },
  procedure: { rule: "drop_function", severity: "destructive", message: (n) => `Deletes the procedure ${n}.` },
  schema: { rule: "drop_schema", severity: "destructive", message: (n) => `Deletes the schema ${n.split(".").pop()} and, with CASCADE, everything in it.` },
};

function dropFindings(text: string): Draft[] {
  const match = /^drop (table|view|materialized view|function|procedure|schema) (?:if exists )?(.+?)(?: cascade| restrict)?$/.exec(text);
  if (!match) return [];
  const kind = DROP_KIND[match[1] as string];
  if (!kind) return [];
  const list = (match[2] as string).replace(/\([^)]*\)/g, "");
  return names(list).map((name) => ({ rule: kind.rule, severity: kind.severity, object: name, message: kind.message(name) }));
}

function dropOnTable(text: string): Draft[] {
  const match = new RegExp(`^drop (policy|trigger) (?:if exists )?(${NAME}) on (${QUALIFIED})`).exec(text);
  if (!match) return [];
  const table = qualifiedName(match[3] as string);
  const name = unquote(match[2] as string);
  if (match[1] === "policy") {
    return [{ rule: "drop_policy", severity: "security", object: `${table}: ${name}`, message: `Removes the access rule "${name}" on ${table}. Check that the table is still limited to each tenant's own rows.` }];
  }
  return [{ rule: "drop_trigger", severity: "destructive", object: `${table}: ${name}`, message: `Removes the trigger "${name}" on ${table}. If it filled in or checked the tenant of new rows, that no longer happens.` }];
}

function truncateFindings(text: string): Draft[] {
  const match = /^truncate (?:table )?(?:only )?(.+?)(?: restart identity| continue identity)?(?: cascade| restrict)?$/.exec(text);
  if (!match) return [];
  return names(match[1] as string).map((name) => ({ rule: "truncate", severity: "destructive", object: name, message: `Deletes every row in ${name}.` }));
}

function alterTableFindings(text: string): Draft[] {
  const match = new RegExp(`^alter table (?:if exists )?(?:only )?(${QUALIFIED}) (.+)$`).exec(text);
  if (!match) return [];
  const table = qualifiedName(match[1] as string);
  const drafts: Draft[] = [];
  for (const action of splitTopLevel(match[2] as string)) {
    if (/^disable row level security$/.test(action)) {
      drafts.push({ rule: "disable_rls", severity: "security", object: table, message: `Switches row level security off on ${table}, so its policies stop applying and every client with access sees every row.` });
      continue;
    }
    if (/^no force row level security$/.test(action)) {
      drafts.push({ rule: "no_force_rls", severity: "security", object: table, message: `Stops forcing row level security on ${table}, so the table owner (and functions running as the owner) skip its policies again.` });
      continue;
    }
    const dropColumn = new RegExp(`^drop (?:column )?(?:if exists )?(${NAME})(?: cascade| restrict)?$`).exec(action);
    if (dropColumn && !/^drop (constraint|identity|default|not null|expression)\b/.test(action)) {
      const column = unquote(dropColumn[1] as string);
      drafts.push({ rule: "drop_column", severity: "destructive", object: `${table}.${column}`, message: `Deletes the column ${column} from ${table}, with every value in it.` });
      continue;
    }
    const retype = new RegExp(`^alter (?:column )?(${NAME}) (?:set data )?type `).exec(action);
    if (retype) {
      const column = unquote(retype[1] as string);
      drafts.push({ rule: "alter_column_type", severity: "destructive", object: `${table}.${column}`, message: `Changes the type of ${table}.${column}; existing values are converted and can be cut short or fail to convert.` });
    }
  }
  return drafts;
}

function writeWithoutWhere(text: string): Draft[] {
  const body = text.replace(/^with .*?\) (?=(delete|update) )/, "");
  const del = new RegExp(`^delete from (?:only )?(${QUALIFIED})`).exec(body);
  if (del && !/\bwhere\b/.test(body)) {
    const table = qualifiedName(del[1] as string);
    return [{ rule: "delete_without_where", severity: "destructive", object: table, message: `Deletes every row in ${table} (there is no WHERE clause).` }];
  }
  const upd = new RegExp(`^update (?:only )?(${QUALIFIED})(?: as ${NAME}| ${NAME})? set `).exec(body);
  if (upd && !/\bwhere\b/.test(body)) {
    const table = qualifiedName(upd[1] as string);
    return [{ rule: "update_without_where", severity: "destructive", object: table, message: `Changes every row in ${table} (there is no WHERE clause).` }];
  }
  return [];
}

function grantFindings(text: string): Draft[] {
  if (!/^(grant |alter default privileges .* grant )/.test(text)) return [];
  const match = /\bgrant (.+?) on (.+?) to (.+?)(?: with grant option)?(?: granted by .+)?$/.exec(text);
  if (!match) return [];
  const roles = (match[3] as string).split(",").map((role) => unquote(role.trim()));
  const clients = roles.filter((role) => ["anon", "public", "authenticated"].includes(role));
  if (clients.length === 0) return [];
  const target = collapse(match[2] as string);
  const futureTables = text.startsWith("alter default privileges");
  const schemaUsage = /^schema\b/.test(target);
  const anonymous = clients.some((role) => role === "anon" || role === "public");
  const severity: Severity = anonymous && !schemaUsage ? "security" : "attention";
  const who = clients.join(", ");
  const what = futureTables ? `every new object created later (${target})` : target;
  return [{
    rule: "grant_to_clients",
    severity,
    object: target,
    message: anonymous
      ? `Gives ${who} (visitors who are not signed in) ${match[1]} rights on ${what}. Only row level security now stands between them and the data.`
      : `Gives signed-in users ${match[1]} rights on ${what}. Row level security policies must limit them to their own tenant.`,
  }];
}

function functionFindings(text: string): Draft[] {
  if (!/\bsecurity definer\b/.test(text)) return [];
  const match = new RegExp(`^(?:create (?:or replace )?|alter )(function|procedure) (${QUALIFIED})`).exec(text);
  if (!match) return [];
  const name = qualifiedName(match[2] as string);
  return [{
    rule: "security_definer",
    severity: "attention",
    object: name,
    message: `${name} runs with its owner's rights (SECURITY DEFINER), which skip row level security. It must check for itself that the caller may touch the data.`,
  }];
}

function policyFindings(text: string): Draft[] {
  const match = new RegExp(`^(?:create|alter) policy (${NAME}) on (${QUALIFIED})`).exec(text);
  if (!match) return [];
  const always = /\b(using|with check) \(\s*(?:\(\s*)*true(?:\s*\))*\s*\)/.exec(text);
  if (!always) return [];
  const table = qualifiedName(match[2] as string);
  const name = unquote(match[1] as string);
  return [{
    rule: "policy_always_true",
    severity: "security",
    object: `${table}: ${name}`,
    message: `The access rule "${name}" on ${table} is ${always[1] === "using" ? "USING (true)" : "WITH CHECK (true)"}, so it matches every row of every tenant. That is only right for data every tenant may share.`,
  }];
}

function doBlock(text: string): Draft[] {
  if (!/^do\b/.test(text)) return [];
  return [{ rule: "do_block", severity: "attention", object: "DO block", message: "Runs a block of procedural code. Its contents are not scanned, so read it yourself." }];
}

/** Every finding for one statement. */
export function scanStatement(statement: Statement): Draft[] {
  const { text } = statement;
  return [
    ...dropFindings(text),
    ...dropOnTable(text),
    ...truncateFindings(text),
    ...alterTableFindings(text),
    ...writeWithoutWhere(text),
    ...grantFindings(text),
    ...functionFindings(text),
    ...policyFindings(text),
    ...doBlock(text),
  ];
}

/** Objects created by a statement, keyed the way drops are, so a drop followed by a re-create can be recognised. */
function createdObjects(text: string): string[] {
  const created: string[] = [];
  const object = new RegExp(`^create (?:or replace )?(view|materialized view|function|procedure) (?:if not exists )?(${QUALIFIED})`).exec(text);
  if (object) created.push(`${object[1] === "materialized view" ? "view" : object[1] === "procedure" ? "function" : object[1]}:${qualifiedName(object[2] as string)}`);
  const onTable = new RegExp(`^create (?:or replace )?(?:constraint )?(policy|trigger) (${NAME}) .*?\\bon (${QUALIFIED})`).exec(text);
  if (onTable) created.push(`${onTable[1]}:${qualifiedName(onTable[3] as string)}: ${unquote(onTable[2] as string)}`);
  return created;
}

const RECREATABLE: Partial<Record<StatementRule, string>> = {
  drop_view: "view",
  drop_function: "function",
  drop_policy: "policy",
  drop_trigger: "trigger",
};

export interface MigrationFile {
  name: string;
  sql: string;
}

/**
 * Scans new migrations in the order they will be applied. A view, function, policy or trigger
 * that is dropped and then created again later in the same migrations is downgraded to
 * `attention`: it is usually a replacement, but the new definition still deserves a look.
 */
export function scanMigrations(files: readonly MigrationFile[]): StatementFinding[] {
  const parsed = files.flatMap((file) => splitStatements(file.sql).map((statement) => ({ file: file.name, statement })));
  const findings: StatementFinding[] = [];
  parsed.forEach(({ file, statement }, index) => {
    for (const draft of scanStatement(statement)) {
      const finding: StatementFinding = {
        file,
        line: statement.line,
        ...draft,
        statement: statement.original.length > STATEMENT_EXCERPT ? `${statement.original.slice(0, STATEMENT_EXCERPT - 1)}…` : statement.original,
      };
      const kind = RECREATABLE[draft.rule];
      if (kind) {
        const key = `${kind}:${draft.object}`;
        const recreated = parsed.slice(index + 1).some((later) => createdObjects(later.statement.text).includes(key));
        if (recreated) {
          finding.severity = "attention";
          finding.message = `${finding.message} It is created again later in the same migration, so check that the new definition is at least as strict.`;
        }
      }
      findings.push(finding);
    }
  });
  return findings;
}

/** True for findings that need a human to review the migration (exit code 4). */
export function needsReview(severity: Severity | "info"): boolean {
  return severity === "destructive" || severity === "security";
}
