import { defineI18n, type I18nConfig } from 'fumadocs-core/i18n';
import { defineI18nUI } from 'fumadocs-ui/i18n';

export const i18nConfig = {
  defaultLanguage: 'en',
  languages: ['en', 'zh'] as Array<'en' | 'zh'>,
  hideLocale: 'default-locale',
  fallbackLanguage: 'en',
  parser: 'dot',
} satisfies I18nConfig<'en' | 'zh'>;

export const i18n = defineI18n(i18nConfig);

export const i18nUI = defineI18nUI(i18n, {
  en: { displayName: 'English' },
  zh: { displayName: '简体中文' },
});
