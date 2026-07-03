const SECRET_KEY = "bai-office-write-secret";

function writeSecret(): string {
  return String(import.meta.env.VITE_OFFICE_SECRET || localStorage.getItem(SECRET_KEY) || "").trim();
}

export function setWriteSecret(secret: string): void {
  const trimmed = secret.trim();
  if (trimmed) localStorage.setItem(SECRET_KEY, trimmed);
  else localStorage.removeItem(SECRET_KEY);
}

export function hasWriteSecret(): boolean {
  return Boolean(writeSecret());
}

function authHeaders(): HeadersInit {
  const secret = writeSecret();
  return secret ? { Authorization: `Bearer ${secret}` } : {};
}

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || "Request failed");
  return data as T;
}

export async function apiWrite<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...init.headers,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || "Request failed");
  return data as T;
}
