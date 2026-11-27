export class LocalPrefs {
  private static readonly PREFIX = "olaseena.";

  static onError: ((error: unknown, action: string) => void) | null = null;

  private static fail(error: unknown, action: string): void {
    if (LocalPrefs.onError) LocalPrefs.onError(error, action);
    else console.error(`[Olaseena] ${action}`, error);
  }

  static get(key: string): string | null {
    try {
      return typeof localStorage === "undefined" ? null : localStorage.getItem(LocalPrefs.PREFIX + key);
    } catch (error) {
      LocalPrefs.fail(error, "prefs.read");
      return null;
    }
  }

  static set(key: string, value: string): void {
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(LocalPrefs.PREFIX + key, value);
    } catch (error) {
      LocalPrefs.fail(error, "prefs.write");
    }
  }
}
