/**
 * Removes the user and password from Postgres connection strings. Everything from "postgres://"
 * to the last "@" on the line that is followed by a host counts as the user and password. No
 * character is excluded, so a password holding @, /, quotes, brackets, spaces or a JSON/HTML
 * escape of them is still covered; at worst more text than needed is hidden.
 */
export function redactDatabaseUrls(text: string): string {
  return text.replace(/(postgres(?:ql)?:\/\/)[^\n]*@(?=[A-Za-z0-9.\-[\]:]+(?:[/?#\s"'<>\\&,;)]|$))/g, "$1[redacted]@");
}
