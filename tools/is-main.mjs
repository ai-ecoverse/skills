import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// True when the module at `importMetaUrl` is the script node was asked to run.
// realpath both sides: argv[1] keeps symlinks (macOS /tmp, symlinked checkouts),
// import.meta.url doesn't. A plain resolve() compare skips main() and exits 0.
export function isMain(importMetaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}
