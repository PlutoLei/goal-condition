// Runtime-neutral lexical rule for the Tool(specifier) string grammar. The shared contract
// validator needs this check without loading the Claude permission compiler at module startup.
export function permissionSpecifierProblem(value) {
  if (typeof value !== 'string' || value.length === 0) return 'must be a non-empty string';
  if (value !== value.trim()) return 'must not have leading or trailing whitespace';
  if (/[()\r\n]/.test(value)) return 'must not contain parentheses or line breaks';
  return null;
}
