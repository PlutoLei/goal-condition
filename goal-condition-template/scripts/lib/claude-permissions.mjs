// Claude permissions are a Tool(specifier) string DSL with no escaping grammar. The lexical
// representability rule lives in a runtime-neutral module because the shared contract validator
// also needs it; compilation and launch remain Claude-owned.
import { permissionSpecifierProblem } from './permission-specifier.mjs';

export { permissionSpecifierProblem } from './permission-specifier.mjs';

export class PermissionSpecifierError extends TypeError {}

export function assertPermissionSpecifier(value) {
  const problem = permissionSpecifierProblem(value);
  if (problem !== null) throw new PermissionSpecifierError(`Claude permission specifier ${problem}`);
  return value;
}

export function permissionRule(tool, specifier) {
  assertPermissionSpecifier(tool);
  assertPermissionSpecifier(specifier);
  return `${tool}(${specifier})`;
}
