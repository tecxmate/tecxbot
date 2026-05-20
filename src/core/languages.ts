export type SupportedLanguage = {
  code: string;
  publicCode: string;
  name: string;
  nativeName: string;
};

export const SUPPORTED_LANGUAGES: SupportedLanguage[] = [
  { code: 'en', publicCode: 'en', name: 'English', nativeName: 'English' },
  { code: 'zh-TW', publicCode: 'tw', name: 'Traditional Chinese', nativeName: '繁體中文' },
  { code: 'zh-CN', publicCode: 'cn', name: 'Simplified Chinese', nativeName: '简体中文' },
  { code: 'ja', publicCode: 'ja', name: 'Japanese', nativeName: '日本語' },
  { code: 'ko', publicCode: 'ko', name: 'Korean', nativeName: '한국어' },
  { code: 'th', publicCode: 'th', name: 'Thai', nativeName: 'ไทย' },
  { code: 'vi', publicCode: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt' },
  { code: 'id', publicCode: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia' },
  { code: 'es', publicCode: 'es', name: 'Spanish', nativeName: 'Español' },
  { code: 'fr', publicCode: 'fr', name: 'French', nativeName: 'Français' },
  { code: 'de', publicCode: 'de', name: 'German', nativeName: 'Deutsch' },
  { code: 'it', publicCode: 'it', name: 'Italian', nativeName: 'Italiano' },
  { code: 'pt', publicCode: 'pt', name: 'Portuguese', nativeName: 'Português' },
  { code: 'ru', publicCode: 'ru', name: 'Russian', nativeName: 'Русский' },
  { code: 'ar', publicCode: 'ar', name: 'Arabic', nativeName: 'العربية' },
  { code: 'hi', publicCode: 'hi', name: 'Hindi', nativeName: 'हिन्दी' },
  { code: 'tr', publicCode: 'tr', name: 'Turkish', nativeName: 'Türkçe' },
  { code: 'fil', publicCode: 'fil', name: 'Filipino', nativeName: 'Filipino' },
  { code: 'my', publicCode: 'my', name: 'Burmese', nativeName: 'မြန်မာ' },
];

const languageByCode = new Map(SUPPORTED_LANGUAGES.map((language) => [language.code.toLowerCase(), language]));
const languageByPublicCode = new Map(SUPPORTED_LANGUAGES.map((language) => [language.publicCode.toLowerCase(), language]));

export function normalizeLanguageCode(code: string) {
  const trimmed = code.trim();
  const direct = languageByCode.get(trimmed.toLowerCase());
  if (direct) return direct.code;
  const publicCode = languageByPublicCode.get(trimmed.toLowerCase());
  if (publicCode) return publicCode.code;
  if (trimmed.toLowerCase() === 'zh') return 'zh-TW';
  if (trimmed.toLowerCase() === 'cn') return 'zh-CN';
  if (trimmed.toLowerCase() === 'tw') return 'zh-TW';
  return undefined;
}

export function getLanguageLabel(code: string) {
  const language = languageByCode.get(code.toLowerCase());
  return language ? `${language.publicCode}: ${language.name} (${language.nativeName})` : code;
}

export function listLanguageCodes() {
  return SUPPORTED_LANGUAGES.map((language) => language.publicCode).join(', ');
}
