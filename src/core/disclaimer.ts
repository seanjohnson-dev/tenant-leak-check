/**
 * The one source of the "this is not a certification" wording. Every output
 * (CLI, Markdown, HTML, JSON) must include one of these. Tests enforce it.
 */
export const DISCLAIMER_SHORT =
  "This is an automated tenant-isolation test, not a security certification, audit or penetration test.";

export const DISCLAIMER_FULL =
  `${DISCLAIMER_SHORT} ` +
  "It shows whether, in a local copy of the project built from its migrations and filled with synthetic data, " +
  "one test customer could read, add, change or delete another test customer's data (or an anonymous visitor could) " +
  "through the Supabase APIs that were tested. " +
  "It does not cover application code, edge functions, anything using the service-role key, production settings, " +
  "real data, or anything the report lists as not tested or not covered.";
