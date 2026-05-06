import { useEffect, useCallback } from "react";

interface ShortcutOptions {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}

export function useKeyboardShortcut(shortcut: ShortcutOptions, callback: () => void) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const matchKey = e.key.toLowerCase() === shortcut.key.toLowerCase();
      const matchCtrl = shortcut.ctrlKey ? e.ctrlKey : !e.ctrlKey || !shortcut.ctrlKey;
      const matchAlt = shortcut.altKey ? e.altKey : !e.altKey || !shortcut.altKey;
      const matchShift = shortcut.shiftKey ? e.shiftKey : true;
      const matchMeta = shortcut.metaKey ? e.metaKey : true;

      if (matchKey && matchCtrl && matchAlt && matchShift && matchMeta) {
        e.preventDefault();
        callback();
      }
    },
    [shortcut, callback]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);
}
