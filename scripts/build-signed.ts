/**
 * Build a macOS bundle signed with a real codesigning identity.
 *
 * `tauri.conf.json` ships `signingIdentity: "-"` (ad-hoc) so that CI and
 * contributors without an Apple certificate can still build. Ad-hoc signatures
 * change with every build, so macOS treats each rebuild as a different app and
 * drops the Accessibility and Input Monitoring grants. Building with a stable
 * identity keeps those grants across rebuilds.
 *
 * Usage:
 *   bun run build:signed                   # .app only
 *   bun run build:signed -- --bundles app,dmg
 *   APPLE_SIGNING_IDENTITY="<sha1>" bun run build:signed
 */

import { spawnSync } from "child_process";

/** One codesigning identity from the login keychain. */
interface Identity {
  sha1: string;
  name: string;
}

/**
 * Identity kinds we accept, best first. `Developer ID Application` is the one
 * used for distribution outside the App Store; `Apple Development` is the
 * everyday certificate an Xcode account gets and is enough to keep permissions.
 */
const PREFERRED_PREFIXES = ["Developer ID Application", "Apple Development"];

function listIdentities(): Identity[] {
  const result = spawnSync(
    "security",
    ["find-identity", "-v", "-p", "codesigning"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `security find-identity failed: ${result.stderr?.trim() ?? "unknown error"}`,
    );
  }
  // Lines look like:  1) <SHA-1> "Apple Development: someone (TEAMID)"
  const pattern = /^\s*\d+\)\s+([0-9A-F]{40})\s+"(.+)"\s*$/i;
  const found: Identity[] = [];
  for (const line of result.stdout.split("\n")) {
    const match = pattern.exec(line);
    if (match) found.push({ sha1: match[1], name: match[2] });
  }
  return found;
}

/** Pick the identity to sign with, or explain why we cannot. */
function resolveIdentity(): Identity {
  const override = process.env.APPLE_SIGNING_IDENTITY?.trim();
  const identities = listIdentities();

  if (override) {
    const match = identities.find(
      (id) => id.sha1 === override.toUpperCase() || id.name === override,
    );
    // Trust the override even when it is not in the list: the user may be
    // naming an identity from a non-default keychain.
    return match ?? { sha1: override, name: override };
  }

  for (const prefix of PREFERRED_PREFIXES) {
    const match = identities.find((id) => id.name.startsWith(prefix));
    if (match) return match;
  }

  const available = identities.length
    ? identities.map((id) => `  - ${id.name}`).join("\n")
    : "  (none)";
  throw new Error(
    "No Apple codesigning identity found in the login keychain.\n" +
      `Looked for: ${PREFERRED_PREFIXES.join(", ")}.\n` +
      `Available identities:\n${available}\n\n` +
      "Add one in Xcode (Settings -> Accounts -> Manage Certificates), or set\n" +
      "APPLE_SIGNING_IDENTITY to the identity you want to use.",
  );
}

function main(): void {
  if (process.platform !== "darwin") {
    console.error("build:signed is macOS-only.");
    process.exit(1);
  }

  let identity: Identity;
  try {
    identity = resolveIdentity();
  } catch (error) {
    console.error(`\n${(error as Error).message}\n`);
    process.exit(1);
  }

  // Pass-through args win, so `-- --bundles app,dmg` overrides the default.
  const passThrough = process.argv.slice(2);
  const hasBundles = passThrough.some((arg) => arg.startsWith("--bundles"));
  const args = [
    "tauri",
    "build",
    ...(hasBundles ? [] : ["--bundles", "app"]),
    // Merged into tauri.conf.json, so the ad-hoc default stays in the repo.
    "--config",
    JSON.stringify({ bundle: { macOS: { signingIdentity: identity.sha1 } } }),
    ...passThrough,
  ];

  console.log(`Signing identity: ${identity.name}`);
  console.log(`               ${identity.sha1}\n`);

  const build = spawnSync("bunx", args, {
    stdio: "inherit",
    env: {
      ...process.env,
      // Required for the bundled C dependencies on current CMake (see AGENTS.md).
      CMAKE_POLICY_VERSION_MINIMUM:
        process.env.CMAKE_POLICY_VERSION_MINIMUM ?? "3.5",
      // tauri.conf.json is merged above; clear the env var so it cannot
      // silently take precedence over the identity we just resolved.
      APPLE_SIGNING_IDENTITY: identity.sha1,
    },
  });
  process.exit(build.status ?? 1);
}

main();
