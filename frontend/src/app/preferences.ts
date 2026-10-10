export interface Preferences {
  cardClickToPlay: boolean;
  navCollapsed: boolean;
}

const key = "javm:preferences";

export function readPreferences(): Preferences {
  const defaults = {
    cardClickToPlay: true,
    navCollapsed: window.matchMedia("(max-width: 850px)").matches,
  };
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!saved || typeof saved !== "object") return defaults;
    return {
      cardClickToPlay:
        "cardClickToPlay" in saved && typeof saved.cardClickToPlay === "boolean"
          ? saved.cardClickToPlay
          : defaults.cardClickToPlay,
      navCollapsed:
        "navCollapsed" in saved && typeof saved.navCollapsed === "boolean"
          ? saved.navCollapsed
          : defaults.navCollapsed,
    };
  } catch {
    return defaults;
  }
}

export function savePreferences(value: Preferences): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
