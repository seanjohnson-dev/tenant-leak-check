/**
 * A small JSON Schema (2020-12) validator for the tests, so the published docs/report.schema.json
 * is checked against real reports without adding a dependency. It supports exactly the keywords
 * the schema uses and fails loudly on any other, so the schema cannot quietly outgrow it.
 */

type Schema = Record<string, unknown>;

const SUPPORTED = new Set([
  "$schema", "$id", "$defs", "$ref", "title", "description",
  "type", "enum", "const", "pattern", "minimum",
  "properties", "required", "additionalProperties", "items", "if", "then",
]);

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function typeMatches(value: unknown, expected: string): boolean {
  const actual = typeOf(value);
  return actual === expected || (expected === "number" && actual === "integer");
}

export function validate(root: Schema, value: unknown): string[] {
  const errors: string[] = [];
  const resolve = (ref: string): Schema => {
    const match = /^#\/\$defs\/(.+)$/.exec(ref);
    const target = match ? (root.$defs as Record<string, Schema> | undefined)?.[match[1] as string] : undefined;
    if (!target) throw new Error(`Unresolvable $ref ${ref}`);
    return target;
  };
  const check = (schema: Schema, data: unknown, path: string): void => {
    for (const key of Object.keys(schema)) if (!SUPPORTED.has(key)) throw new Error(`Schema keyword "${key}" at ${path} is not supported by the test validator`);
    if (typeof schema.$ref === "string") check(resolve(schema.$ref), data, path);
    if (typeof schema.type === "string" && !typeMatches(data, schema.type)) {
      errors.push(`${path}: expected ${schema.type}, got ${typeOf(data)}`);
      return;
    }
    if ("const" in schema && data !== schema.const) errors.push(`${path}: expected ${JSON.stringify(schema.const)}`);
    if (Array.isArray(schema.enum) && !schema.enum.includes(data as never)) errors.push(`${path}: ${JSON.stringify(data)} is not one of ${JSON.stringify(schema.enum)}`);
    if (typeof schema.pattern === "string" && typeof data === "string" && !new RegExp(schema.pattern).test(data)) errors.push(`${path}: "${data}" does not match ${schema.pattern}`);
    if (typeof schema.minimum === "number" && typeof data === "number" && data < schema.minimum) errors.push(`${path}: ${data} is below ${schema.minimum}`);
    if (typeOf(data) === "object") {
      const object = data as Record<string, unknown>;
      const properties = (schema.properties ?? {}) as Record<string, Schema>;
      for (const key of (schema.required ?? []) as string[]) if (!(key in object)) errors.push(`${path}: missing required "${key}"`);
      for (const [key, item] of Object.entries(object)) {
        if (properties[key]) check(properties[key], item, `${path}.${key}`);
        else if (schema.additionalProperties === false) errors.push(`${path}: unexpected property "${key}"`);
      }
    }
    if (Array.isArray(data) && schema.items) data.forEach((item, i) => check(schema.items as Schema, item, `${path}[${i}]`));
    if (schema.if && schema.then) {
      const before = errors.length;
      check(schema.if as Schema, data, path);
      const conditionHolds = errors.length === before;
      errors.length = before;
      if (conditionHolds) check(schema.then as Schema, data, path);
    }
  };
  check(root, value, "$");
  return errors;
}
