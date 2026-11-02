import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Official HermodMail product site, published on GitHub Pages at /HermodMail/
export default defineConfig({
  site: 'https://cyril-belin.github.io',
  base: '/HermodMail',
  // GitHub Pages serves directory indexes (/fr/) and redirects /fr → /fr/;
  // 'always' makes the dev/preview servers match that production behaviour.
  trailingSlash: 'always',
  integrations: [
    sitemap({
      // GitHub Pages serves directory indexes with a trailing slash; keep
      // sitemap URLs consistent with the canonical URLs in <head>.
      serialize(item) {
        return { ...item, url: item.url.endsWith('/') ? item.url : `${item.url}/` };
      },
    }),
  ],
  build: {
    inlineStylesheets: 'auto',
  },
  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'fr'],
    // English lives at the root (/), French under /fr/
    prefixDefaultLocale: false,
  },
});
