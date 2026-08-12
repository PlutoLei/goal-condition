// Claude permissions are a Tool(specifier) string DSL with no escaping grammar. Keep the
// representability rule in one place so contract validation, compilation, and the launch gate
// cannot drift into accepting different delimiter surfaces.

export function permissionSpecifierProblem(value) {
  if (typeof value !== 'string' || value.length === 0) return 'must be a non-empty string';
  if (value !== value.trim()) return 'must not have leading or trailing whitespace';
  if (/[()\r\n]/.test(value)) return 'must not contain parentheses or line breaks';
  return null;
}

export function assertPermissionSpecifier(value) {
  const problem = permissionSpecifierProblem(value);
  if (problem !== null) throw new TypeError(`Claude permission specifier ${problem}`);
  return value;
}

export function permissionRule(tool, specifier) {
  assertPermissionSpecifier(tool);
  assertPermissionSpecifier(specifier);
  return `${tool}(${specifier})`;
}
