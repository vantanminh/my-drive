import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { currentLang, translate, LANG_KEY, type Lang, type MessageKey } from './messages';

export type { Lang, MessageKey };
export { LANG_KEY };

type TFn = (key: MessageKey, vars?: Record<string, string | number>) => string;

type I18nValue = {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: TFn;
};

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(currentLang);
  const value = useMemo<I18nValue>(() => ({
    lang,
    setLang(next: Lang) {
      setLangState(next);
      try {
        localStorage.setItem(LANG_KEY, next);
      } catch {
        // Storage may be unavailable; language simply won't persist.
      }
      document.documentElement.lang = next;
    },
    t: (key, vars) => translate(lang, key, vars)
  }), [lang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used inside <I18nProvider>');
  return context;
}

// For use outside React components (format.ts, helpers).
export function tGlobal(key: MessageKey, vars?: Record<string, string | number>): string {
  return translate(currentLang(), key, vars);
}
