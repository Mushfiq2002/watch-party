const NAME_KEY = "watch-party-name";
const HOST_KEY_PREFIX = "watch-party-host-";
const CLIENT_KEY_PREFIX = "watch-party-client-";

function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key) ?? sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStore(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      // Ignore quota / private-mode failures.
    }
  }
}

export function loadName(): string {
  return readStore(NAME_KEY) ?? "";
}

export function saveName(name: string): void {
  writeStore(NAME_KEY, name);
}

export function loadHostKey(code: string): string | null {
  return readStore(`${HOST_KEY_PREFIX}${code}`);
}

export function saveHostKey(code: string, key: string): void {
  writeStore(`${HOST_KEY_PREFIX}${code}`, key);
}

export function newHostKey(): string {
  return crypto.randomUUID();
}

export function loadClientId(code: string): string {
  const key = `${CLIENT_KEY_PREFIX}${code}`;
  const existing = readStore(key);
  if (existing) {
    return existing;
  }
  const created = crypto.randomUUID();
  writeStore(key, created);
  return created;
}
