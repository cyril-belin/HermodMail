// French copy — same shape as en.ts.
import type { Dictionary } from './en';

export const fr: Dictionary = {
  meta: {
    title: 'HermodMail — Une boîte mail où humains et agents IA travaillent ensemble',
    description:
      'Webmail open source auto-hébergeable avec serveur MCP natif. Vos agents lisent, rédigent et agissent dans votre boîte via des tokens à périmètre limité — vous gardez le contrôle. IMAP/SMTP, vrais brouillons, permissions granulaires.',
    skip: 'Aller au contenu',
  },
  nav: {
    problem: 'Pourquoi',
    story: 'Comment ça marche',
    webmail: 'Webmail',
    mcp: 'MCP',
    permissions: 'Permissions',
    developers: 'Développeurs',
    github: 'Voir sur GitHub',
  },
  footer: {
    tagline: 'Webmail open source pour humains et agents IA.',
    sections: {
      site: 'Site',
      project: 'Projet',
      legal: 'Licence',
    },
    links: {
      features: 'Fonctionnalités',
      permissions: 'Permissions',
      developers: 'Commencer',
      github: 'Dépôt GitHub',
      issues: 'Signaler un problème',
      license: 'Licence AGPL-3.0',
    },
    note: 'HermodMail est un logiciel libre sous AGPL-3.0-or-later. Site réalisé avec Astro, déployé sur GitHub Pages.',
    copyright: '© 2026 Cyril Belin',
  },
  hero: {
    eyebrow: 'Open source · Auto-hébergé · MCP natif',
    badge: 'v0.1.0-beta.1 · Première bêta publique',
    title: 'Une boîte mail où humains et agents IA travaillent <em>ensemble</em>.',
    lead: 'HermodMail est un véritable webmail IMAP/SMTP avec un serveur MCP natif. Vos agents lisent, rédigent et agissent dans votre boîte via des tokens à périmètre limité — pendant que vous gardez le contrôle de chaque dossier, de chaque permission et de chaque envoi.',
    ctaPrimary: 'Télécharger la bêta',
    ctaSecondary: 'Voir sur GitHub',
    shotCaption:
      "L'interface réelle d'HermodMail — dossiers IMAP, recherche instantanée, volet de lecture et actions IA quand un fournisseur est configuré.",
  },
  problem: {
    eyebrow: 'Le problème',
    title: "Email n'a pas été conçu pour les agents.",
    lead: "Connecter un agent IA à une messagerie, c'est souvent partager ses identifiants, bricoler des scripts fragiles et espérer que rien ne dérape. HermodMail part d'un autre principe :",
    principle: 'Une boîte. Un moteur partagé. Humain et agent accèdent avec des permissions contrôlées.',
    cards: [
      {
        title: 'Des tokens, pas des mots de passe partagés',
        body: "Créez un token d'API, choisissez ses scopes, confiez-le à votre agent. Les tokens commencent par hmt_ et seul un hash SHA-256 est stocké — la valeur complète n'est montrée qu'à la création.",
      },
      {
        title: 'Vérifiés à chaque appel',
        body: 'Les scopes sont relus en base à chaque appel d\'outil. Resserrez ou révoquez un token : cela s\'applique aussi aux sessions déjà ouvertes.',
      },
      {
        title: 'De vrais brouillons, pas des transcriptions de chat',
        body: "Les agents enregistrent de véritables brouillons IMAP — marqués \\Draft, visibles dans le dossier Brouillons — au lieu de coller du texte dans une fenêtre de discussion à part.",
      },
    ],
  },
  story: {
    eyebrow: 'Comment ça marche',
    title: "L'agent a fait le travail. L'humain a gardé la décision.",
    lead: 'Une collaboration typique : vous donnez une consigne à votre agent, il prépare de vrais brouillons dans votre boîte, et vous relisez et envoyez quand vous êtes prêt.',
    steps: [
      {
        title: 'Vous donnez la consigne',
        body: "« Prépare des brouillons de relance pour les comptes rencontrés la semaine dernière. » N'importe quel client MCP convient — l'agent se connecte avec son token.",
      },
      {
        title: "L'agent travaille via MCP",
        body: "Avec mail:write et ai:use, il fouille la boîte, rédige et enregistre de vrais brouillons IMAP. Rien n'est envoyé.",
      },
      {
        title: 'Les brouillons sont déjà là',
        body: 'Ouvrez le dossier Brouillons dans HermodMail. Chaque brouillon est un vrai message, lisible, modifiable et complémentable — avec le sélecteur de destinataires, les pièces jointes et vos habitudes de signature.',
      },
      {
        title: 'Vous décidez de ce qui part',
        body: "Relisez, ajustez, envoyez. Un token sans scope mail:send ne peut envoyer aucun message — la décision d'envoi vous reste.",
      },
    ],
    quote: "L'agent a fait le travail. L'humain a gardé la décision.",
    shotCaption: "Un brouillon enregistré par un agent via MCP, qui attend dans le dossier Brouillons.",
  },
  webmail: {
    eyebrow: 'Un vrai webmail, avant tout',
    title: 'Tout ce qu\'on attend d\'un client mail — <em>avec ou sans</em> IA.',
    lead: "HermodMail est un webmail complet, utilisable au quotidien. L'IA est une couche facultative, jamais une condition.",
    features: [
      { title: 'IMAP / SMTP', body: 'Les protocoles standards — fonctionne avec vos comptes existants.' },
      { title: 'Dossiers', body: 'Créez, renommez et gérez vos boîtes, avec garde-fous sur les dossiers système.' },
      { title: 'Recherche plein texte', body: 'Recherche SQLite rapide sur l\'objet, les correspondants et le corps.' },
      { title: 'Contacts', body: 'Récoltés automatiquement depuis vos messages, avec autocomplétion des destinataires.' },
      { title: 'Brouillons', body: 'De vrais brouillons IMAP, enregistrés et modifiables depuis n\'importe quel client.' },
      { title: 'Pièces jointes', body: 'Joignez des fichiers à la rédaction, téléchargez-les à la lecture.' },
      { title: 'fr / en / es', body: 'Une interface entièrement traduite en trois langues.' },
      { title: 'Thème sombre', body: 'Auto, clair ou sombre — il suit la préférence de votre système.' },
      { title: 'Multi-utilisateur', body: 'Boîtes et isolation par utilisateur, administrées par un compte admin.' },
      { title: 'Export Markdown', body: 'Exportez n\'importe quel message en Markdown propre.' },
    ],
    galleryLabel: 'Galerie de l\'interface',
    gallery: [
      {
        label: 'Boîte de réception',
        caption: 'Dossiers, liste et volet de lecture — avec résumé IA et brouillon de réponse IA à un clic.',
      },
      {
        label: 'Rédaction',
        caption: 'Composition avec autocomplétion des destinataires et enregistrement en brouillon.',
      },
      {
        label: 'Thème sombre',
        caption: "La même interface, confortable la nuit.",
      },
    ],
  },
  mcp: {
    eyebrow: 'MCP natif',
    title: 'Intégré dès la conception, pas greffé après coup.',
    lead: "L'interface web et les agents MCP ne passent pas par des chemins de code différents : les deux parlent au même moteur de messagerie, qui applique les mêmes règles de propriété et de permissions à une session navigateur comme à un token Bearer.",
    diagram: {
      ui: 'Interface web',
      uiNote: 'Vue 3, sessions humaines',
      agents: 'Agents MCP',
      agentsNote: 'tokens à périmètre · transport HTTP',
      engine: 'Moteur de messagerie partagé',
      engineNote: 'propriété + scopes vérifiés ici',
      imap: 'IMAP',
      smtp: 'SMTP',
      ai: 'Fournisseurs IA',
      aiNote: 'facultatif',
      caption: 'Deux portes, un moteur. Les permissions sont vérifiées à l\'intérieur du moteur, pas aux portes d\'entrée.',
    },
    toolsTitle: '17 outils, exposés en HTTP',
    toolsLead:
      'Pointez n\'importe quel client compatible MCP vers /mcp avec un en-tête Authorization: Bearer. Voici toute la surface, groupée par le scope exigé :',
    toolGroups: [
      {
        scope: 'mail:read',
        tools: ['list_accounts', 'list_folders', 'sync_folder', 'list_messages', 'search_messages', 'get_message', 'export_markdown'],
      },
      {
        scope: 'mail:write',
        tools: ['create_draft', 'mark_message', 'move_message'],
      },
      {
        scope: 'mail:send',
        tools: ['send_message'],
      },
      {
        scope: 'mail:delete',
        tools: ['delete_message'],
      },
      {
        scope: 'folder:write',
        tools: ['create_folder', 'rename_folder'],
      },
      {
        scope: 'folder:delete',
        tools: ['delete_folder'],
      },
      {
        scope: 'ai:use',
        tools: ['summarize_message', 'draft_reply'],
      },
    ],
    toolsNote:
      "get_message ne renvoie jamais de HTML brut — les agents reçoivent du contenu assaini. delete_folder exige un indicateur confirm explicite pour les dossiers non vides.",
  },
  permissions: {
    eyebrow: 'Permissions',
    title: 'Des permissions qui veulent dire quelque chose.',
    lead: 'Chaque token porte un ensemble précis de scopes. Le moteur les vérifie à chaque appel — et quelques règles valent quel que soit le cas.',
    scopes: [
      { scope: 'mail:read', body: 'Lister, synchroniser, lire, rechercher, exporter en Markdown, télécharger les pièces jointes.' },
      { scope: 'mail:write', body: 'Enregistrer des brouillons, changer les marqueurs, déplacer des messages.' },
      { scope: 'mail:send', body: 'Envoyer des messages via SMTP. À accorder en connaissance de cause.' },
      { scope: 'mail:delete', body: 'Supprimer des messages, avec un comportement respectant la Corbeille.' },
      { scope: 'folder:write', body: 'Créer et renommer des dossiers.' },
      { scope: 'folder:delete', body: 'Supprimer des dossiers — protégé pour les dossiers système et non vides.' },
      { scope: 'ai:use', body: "Utiliser les fonctions IA intégrées : résumé, classification, brouillon de réponse, traduction." },
    ],
    lifecycleTitle: 'Le cycle de vie du token',
    lifecycle: [
      {
        title: 'Montré une fois, haché pour toujours',
        body: "Seul un hash SHA-256 du token est stocké. S'il fuite, révoquez-le — rien à déchiffrer.",
      },
      {
        title: 'Modifiable à chaud',
        body: "Changez les scopes d'un token à tout moment ; le nouvel ensemble s'applique à l'appel suivant, même en session ouverte.",
      },
      {
        title: 'Révocable en un clic',
        body: 'Révoquez instantanément depuis Paramètres → Tokens API. Le token cesse de fonctionner immédiatement.',
      },
      {
        title: "Pas d'enrôlement de comptes",
        body: "Les tokens d'API ne peuvent jamais ajouter ni retirer de comptes mail. Un token d'agent en lecture seule divulgué ne peut pas enrôler de nouvelles boîtes.",
      },
    ],
    shotCaption: "Création d'un token à périmètre limité dans Paramètres → Tokens API (MCP).",
    honesty:
      "Honnête par conception : un agent qui détient mail:send peut envoyer de lui-même. HermodMail n'impose pas d'approbation humaine sur chaque message — il vous donne les moyens de décider précisément qui peut envoyer.",
  },
  models: {
    eyebrow: 'Apportez votre modèle',
    title: 'Aucun fournisseur IA imposé. Aucune dépendance cloud forcée.',
    lead: "Le webmail est pleinement fonctionnel avec l'IA désactivée — c'est le réglage par défaut. Quand vous voulez l'assistance intégrée, branchez le fournisseur en lequel vous avez déjà confiance :",
    options: [
      { title: "Aucun — par défaut", body: 'Résumé, classification, brouillon de réponse et traduction restent simplement masqués. Un webmail complet, rien de plus.' },
      { title: 'API compatibles OpenAI', body: "Tout point de terminaison parlant le format chat/completions, avec votre clé d'API chiffrée sur votre serveur." },
      { title: 'Ollama, en local', body: 'Exécutez les modèles sur votre propre machine — rien ne quitte votre infrastructure.' },
      { title: "Les agents apportent leur LLM", body: "Les clients MCP utilisent leur propre modèle ; le réglage de fournisseur d'HermodMail ne sert qu'à son assistant intégré." },
    ],
    fencing:
      "Le contenu des e-mails est, par définition, une donnée non fiable : le texte soumis au modèle est balisé comme donnée, et l'invite système interdit de le traiter comme des instructions.",
  },
  developers: {
    eyebrow: 'Pour les développeurs',
    title: "Auto-héberger est le but.",
    lead: 'Un serveur Node unique avec une base SQLite, ou un conteneur. Aucun service externe requis.',
    tabs: {
      docker: 'Docker / Podman',
      source: 'Depuis les sources',
      mcp: 'Client MCP',
    },
    docker: {
      comment1: '# .env contient HERMODMAIL_SECRET — la clé maîtresse de chiffrement',
      comment2: '# ou : podman-compose up -d --build',
      result: "HermodMail écoute sur http://localhost:8667 et stocke tout dans le volume hermodmail-data.",
    },
    source: {
      comment1: '# Nécessite Node >= 22',
      comment2: '# serveurs de développement : npm run dev + npm run dev:web (voir le README)',
      comment3: '# production :',
      firstRun: 'Ouvrez http://localhost:8667 — la première visite crée votre compte administrateur.',
    },
    mcp: {
      intro: "Créez un token dans Paramètres → Tokens API (MCP), choisissez ses scopes, puis pointez votre client MCP vers le serveur :",
      securityTitle: 'Avant une mise en ligne',
      security: "Définissez un HERMODMAIL_SECRET solide, servez l'application derrière TLS (le README inclut une configuration Caddy reverse-proxy prête à copier) et lisez les notes de sécurité avant d'exposer quoi que ce soit à Internet.",
      readmeLink: "Guide d'installation complet",
    },
    copy: 'Copier',
    copied: 'Copié',
  },
  opensource: {
    eyebrow: 'Open source, par conception',
    title: 'Votre serveur de messagerie doit être inspectable.',
    lead: "HermodMail est un logiciel libre sous AGPL-3.0-or-later. Lisez le moteur, auditez la cryptographie, lancez la suite de tests — et modifiez ce qui ne vous convient pas.",
    points: [
      { title: 'AGPL-3.0-or-later', body: 'Le texte complet de la licence accompagne le dépôt.' },
      { title: 'Architecture lisible', body: "Un moteur central, de fins adaptateurs HTTP et MCP, un front-end Vue 3. Rien de caché." },
      { title: 'Une suite de tests étendue', body: '200 tests automatisés (unitaires et à base de propriétés) couvrent le moteur, l\'authentification, la cryptographie, la surface MCP et le serving statique.' },
      { title: 'Intégration continue et audits', body: 'GitHub Actions exécute typecheck, build, tests et audits de dépendances (npm audit) sous Node 22 et 24 à chaque changement.' },
    ],
    links: {
      code: 'Lire le code source',
      issues: 'Signaler un problème',
      license: 'Lire la licence',
    },
    stage: "HermodMail est un projet jeune (v0.1.0-beta.1 — première bêta publique) en développement actif — testé avec de vraies boîtes mail, construit pour grandir au grand jour.",
  },
  conclusion: {
    title: "L'agent a fait le travail. <em>L'humain a gardé la décision.</em>",
    lead: 'Une boîte, un moteur, des permissions contrôlées — et un toit pour les humains comme pour les machines qui y travaillent.',
    cta: 'Télécharger la bêta',
    links: {
      source: 'Voir le code source',
      docs: 'Documentation',
      issues: 'Signaler un problème',
    },
    myth: "Hermóðr, messager de la mythologie nordique, traversait les mondes pour livrer ce qui comptait. HermodMail livre les vôtres — à vous, d'abord.",
  },
};
