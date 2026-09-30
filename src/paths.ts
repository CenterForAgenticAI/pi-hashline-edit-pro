import { homedir } from "node:os";
import { isAbsolute, relative, resolve as resolvePath, join, dirname, parse } from "node:path";


function homeBase(): string {
  const envHome = process.env.HOME;
  return envHome && envHome.length > 0 ? envHome : homedir();
}

function configBase(): string {
  if (process.platform !== "win32") {
    const xdg = process.env.XDG_CONFIG_HOME;
    if (xdg && xdg.length > 0) return xdg;
  }
  return join(homeBase(), ".config");
}

export function configDir(): string {
  const override = process.env.PI_HASHLINE_DIR;
  if (override && !isAbsolute(override)) {
    throw new Error("[E_CONFIG] PI_HASHLINE_DIR must be an absolute path");
  }
  return override || join(configBase(), "pi-hashline-edit-pro");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function hashStorePath(): string {
  return join(configDir(), "hash-store.sqlite");
}

export function legacyHashStorePath(): string {
  return join(configDir(), "hash-store.json");
}

export function sessionClaimsDir(): string {
  return join(configDir(), "sessions");
}

export function hashStoreDir(): string {
  return dirname(hashStorePath());
}

function expand(filePath: string): string {
  const home = homeBase();
  if (filePath === "~") return home;
  if (filePath.startsWith("~/")) return home + filePath.slice(1);
  return filePath;
}

export function toCwd(filePath: string, cwd: string): string {
  const expanded = expand(filePath);
  return isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
}

function pathDepth(path: string): number {
  const root = parse(path).root;
  return path.slice(root.length).split(/[\\/]+/).filter((part) => part.length > 0).length;
}

function climbsToRoot(cwd: string, relativePath: string): boolean {
  let climbs = 0;
  for (const part of relativePath.split("/")) {
    if (part !== "..") break;
    climbs += 1;
  }
  return climbs > 0 && climbs >= pathDepth(resolvePath(cwd));
}

export function toDisplayPath(cwd: string, absolutePath: string, fallback?: string): string {
  const rel = relative(cwd, absolutePath).replace(/\\/g, "/");
  if (rel.length === 0 || climbsToRoot(cwd, rel)) return fallback ?? absolutePath;
  return rel;
}
