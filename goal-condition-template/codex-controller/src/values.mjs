export function assertControllerRuntime(version = process.versions.node) {
  const [major, minor, patch] = version.split('.').map(Number);
  const supported = major > 24 || (major === 24 && (minor > 15 || (minor === 15 && patch >= 0)));
  if (supported) return true;

  const error = new Error('Codex GoalSession v2 requires Node.js 24.15.0 or newer');
  error.code = 'CODEX_CONTROLLER_NODE_UNSUPPORTED';
  throw error;
}
