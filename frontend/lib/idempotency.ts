/**
 * Stable idempotency keys per UI action.
 *
 * The key for a given scope (e.g. "pay:ord_123") is minted once and kept in
 * sessionStorage until the action SUCCEEDS. Double-clicks, network retries and
 * page reloads therefore resend the SAME key — the backend replays the stored
 * result instead of charging twice. Only success clears the key.
 */
export function actionKey(scope: string): string {
  const storageKey = `idem:${scope}`;
  try {
    const existing = sessionStorage.getItem(storageKey);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    sessionStorage.setItem(storageKey, fresh);
    return fresh;
  } catch {
    return crypto.randomUUID(); // SSR/storage-disabled fallback
  }
}

export function clearActionKey(scope: string): void {
  try {
    sessionStorage.removeItem(`idem:${scope}`);
  } catch {
    /* ignore */
  }
}
