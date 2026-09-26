import { platform } from "@tauri-apps/plugin-os";

/**
 * Manual update check against the latest GitHub release. Sayso doesn't update
 * itself: this only finds the newest installer for this platform and hands
 * its URL to the browser. Every macOS release is signed with the same
 * certificate (scripts/macos-signing.sh), so the downloaded app installs over
 * the old one and keeps its permissions.
 */
export const RELEASES_URL =
  "https://github.com/zuijiaosy/sayso/releases/latest";
const API_URL = "https://api.github.com/repos/zuijiaosy/sayso/releases/latest";

export interface UpdateInfo {
  /** Latest released version, without the leading "v". */
  version: string;
  newer: boolean;
  /** Installer for this platform, or the release page when there is none. */
  downloadUrl: string;
}

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

const parse = (v: string) =>
  v
    .replace(/^v/, "")
    .split(/[.+-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);

/** True when `a` is a higher x.y.z than `b`. */
export const isNewer = (a: string, b: string) => {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] > y[i];
  }
  return false;
};

const installerPattern = (): RegExp | null => {
  switch (platform()) {
    case "macos":
      return /aarch64\.dmg$/i;
    case "windows":
      return /-setup\.exe$/i;
    default:
      return null;
  }
};

export async function checkForUpdate(current: string): Promise<UpdateInfo> {
  const response = await fetch(API_URL, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`GitHub ${response.status}`);
  const release = (await response.json()) as {
    tag_name: string;
    html_url: string;
    assets: ReleaseAsset[];
  };
  const pattern = installerPattern();
  const asset = pattern
    ? release.assets.find((a) => pattern.test(a.name))
    : undefined;
  const version = release.tag_name.replace(/^v/, "");
  return {
    version,
    newer: isNewer(version, current),
    downloadUrl: asset?.browser_download_url ?? release.html_url,
  };
}
