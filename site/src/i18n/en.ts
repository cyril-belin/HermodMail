// English copy — the reference dictionary. fr.ts must keep the exact same shape.
export const en = {
  meta: {
    title: 'HermodMail — A mailbox where humans and AI agents work together',
    description:
      'Open-source, self-hosted webmail with a native MCP server. AI agents read, draft and act inside your mailbox through scoped tokens — you keep full control. IMAP/SMTP, real drafts, granular permissions.',
    skip: 'Skip to content',
  },
  nav: {
    problem: 'Why',
    story: 'How it works',
    webmail: 'Webmail',
    mcp: 'MCP',
    permissions: 'Permissions',
    developers: 'Developers',
    github: 'View on GitHub',
  },
  footer: {
    tagline: 'Open-source webmail for humans and AI agents.',
    sections: {
      site: 'Site',
      project: 'Project',
      legal: 'Legal',
    },
    links: {
      features: 'Features',
      permissions: 'Permissions',
      developers: 'Get started',
      github: 'GitHub repository',
      issues: 'Issues',
      license: 'AGPL-3.0 license',
    },
    note: 'HermodMail is free software under AGPL-3.0-or-later. Site built with Astro, deployed on GitHub Pages.',
    copyright: '© 2026 Cyril Belin',
  },
  hero: {
    eyebrow: 'Open source · Self-hosted · MCP native',
    badge: 'v0.1.0-beta.1 · Public Beta',
    title: 'A mailbox where humans and AI agents work <em>together</em>.',
    lead: 'HermodMail is a real IMAP/SMTP webmail with a native MCP server. Your agents read, draft and act inside your mailbox through scoped tokens — while you keep control of every folder, every permission and every send.',
    ctaPrimary: 'Download Beta',
    ctaSecondary: 'View on GitHub',
    shotCaption:
      'The actual HermodMail interface — IMAP folders, live search, reading pane and AI actions when a provider is configured.',
  },
  problem: {
    eyebrow: 'The problem',
    title: "Email wasn't built for agents.",
    lead: 'Connecting an AI agent to a mailbox usually means sharing your credentials, wiring brittle scripts together and hoping nothing goes wrong. HermodMail starts from a different principle:',
    principle: 'One mailbox. One shared engine. Human and agent access with controlled permissions.',
    cards: [
      {
        title: 'Scoped tokens, not shared passwords',
        body: 'Create an API token, pick its scopes, hand it to your agent. Tokens start with hmt_ and only a SHA-256 hash is ever stored — the full value is shown once at creation.',
      },
      {
        title: 'Checked on every call',
        body: 'Scopes are re-read from the database on each tool call. Tighten or revoke a token and it applies to sessions that are already open.',
      },
      {
        title: 'Real drafts, not chat transcripts',
        body: 'Agents save genuine IMAP drafts — flagged \\Draft, visible in the Drafts folder — instead of pasting text through a separate chat window.',
      },
    ],
  },
  story: {
    eyebrow: 'How it works',
    title: 'The agent did the work. The human kept the decision.',
    lead: 'A typical collaboration: you brief your agent, it prepares real drafts in your mailbox, and you review and send when you are ready.',
    steps: [
      {
        title: 'You brief your agent',
        body: '"Prepare follow-up drafts for the accounts I met last week." Any MCP client works — the agent connects with its token.',
      },
      {
        title: 'The agent works over MCP',
        body: 'With mail:write and ai:use, it searches your mailbox, composes and saves real IMAP drafts. Nothing is sent.',
      },
      {
        title: 'The drafts are already there',
        body: 'Open the Drafts folder in HermodMail. Each draft is a real message you can read, edit and complete — with the recipient picker, attachments and your signature habits.',
      },
      {
        title: 'You decide what leaves',
        body: 'Review, tweak, send. A token without mail:send cannot send a single message — the sending decision stays with you.',
      },
    ],
    quote: 'The agent did the work. The human kept the decision.',
    shotCaption: 'A draft saved by an agent through MCP, waiting in the Drafts folder.',
  },
  webmail: {
    eyebrow: 'A real webmail, first',
    title: 'Everything you expect from a mail client — <em>with or without</em> AI.',
    lead: 'HermodMail is a complete webmail you can use every day. AI is an optional layer, never a requirement.',
    features: [
      { title: 'IMAP / SMTP', body: 'Standard mail protocols — works with existing accounts.' },
      { title: 'Folders', body: 'Create, rename and manage mailboxes with system-folder guardrails.' },
      { title: 'Full-text search', body: 'Fast SQLite full-text search across subject, people and body.' },
      { title: 'Contacts', body: 'Automatically harvested from your mail, with recipient autocomplete.' },
      { title: 'Drafts', body: 'Real IMAP drafts, saved and editable from any client.' },
      { title: 'Attachments', body: 'Attach files when composing, download them when reading.' },
      { title: 'fr / en / es', body: 'A fully translated interface in three languages.' },
      { title: 'Dark theme', body: 'Auto, light or dark — it follows your system preference.' },
      { title: 'Multi-user', body: 'Per-user mailboxes and isolation, managed by an admin.' },
      { title: 'Markdown export', body: 'Export any message to clean Markdown.' },
    ],
    galleryLabel: 'Interface gallery',
    gallery: [
      {
        label: 'Mailbox',
        caption: 'Folders, list and reading pane — with AI summary and AI draft reply one click away.',
      },
      {
        label: 'Compose',
        caption: 'Composition with recipient autocomplete and save-as-draft.',
      },
      {
        label: 'Dark theme',
        caption: 'The same interface, comfortable at night.',
      },
    ],
  },
  mcp: {
    eyebrow: 'Native MCP',
    title: 'Built in, not bolted on.',
    lead: 'The web interface and MCP agents do not go through different code paths: both speak to the same mail engine, which enforces the same ownership and permission rules for a browser session and a Bearer token alike.',
    diagram: {
      ui: 'Web UI',
      uiNote: 'Vue 3, human sessions',
      agents: 'MCP agents',
      agentsNote: 'scoped tokens · HTTP transport',
      engine: 'Shared mail engine',
      engineNote: 'ownership + scopes enforced here',
      imap: 'IMAP',
      smtp: 'SMTP',
      ai: 'AI providers',
      aiNote: 'optional',
      caption: 'Two doors, one engine. Permissions are checked inside the engine, not in the front doors.',
    },
    toolsTitle: '17 tools, exposed over HTTP',
    toolsLead:
      'Point any MCP-compatible client at /mcp with an Authorization: Bearer header. Here is the full surface, grouped by the scope it requires:',
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
      'get_message never returns raw HTML — agents receive sanitized content. delete_folder requires an explicit confirm flag for non-empty folders.',
  },
  permissions: {
    eyebrow: 'Permissions',
    title: 'Permissions that mean something.',
    lead: 'Every token carries a precise set of scopes. The engine checks them on each call — and a few rules hold no matter what.',
    scopes: [
      { scope: 'mail:read', body: 'List, sync, read, search messages, export Markdown, download attachments.' },
      { scope: 'mail:write', body: 'Save drafts, change flags, move messages between folders.' },
      { scope: 'mail:send', body: 'Send messages over SMTP. Grant this one deliberately.' },
      { scope: 'mail:delete', body: 'Delete messages, with Trash-aware behaviour.' },
      { scope: 'folder:write', body: 'Create and rename folders.' },
      { scope: 'folder:delete', body: 'Delete folders — guarded for system folders and non-empty mailboxes.' },
      { scope: 'ai:use', body: 'Use the built-in AI features: summarize, classify, draft reply, translate.' },
    ],
    lifecycleTitle: 'The token lifecycle',
    lifecycle: [
      {
        title: 'Shown once, hashed forever',
        body: 'Only a SHA-256 hash of the token is stored. If it leaks, revoke it — nothing to decrypt.',
      },
      {
        title: 'Editable live',
        body: 'Change a token\'s scopes at any time; the new set applies on the next call, even in open sessions.',
      },
      {
        title: 'Revocable in one click',
        body: 'Revoke instantly from Settings → API tokens. The token stops working immediately.',
      },
      {
        title: 'No account enrollment',
        body: 'API tokens can never add or remove mail accounts. A leaked read-only agent token cannot enroll new mailboxes.',
      },
    ],
    shotCaption: 'Creating a scoped token in Settings → API tokens (MCP).',
    honesty:
      'Honest by design: an agent holding mail:send can send on its own. HermodMail does not force human approval on every message — it gives you the tools to decide exactly who may send.',
  },
  models: {
    eyebrow: 'Bring your own model',
    title: 'No mandatory AI provider. No forced cloud dependency.',
    lead: 'The webmail is fully functional with AI turned off — that is the default. When you want built-in assistance, plug in the provider you already trust:',
    options: [
      { title: 'None — the default', body: 'Summarize, classify, draft-reply and translate simply stay hidden. A complete webmail, nothing more.' },
      { title: 'OpenAI-compatible APIs', body: 'Any endpoint speaking the chat/completions format, with your API key stored encrypted on your server.' },
      { title: 'Ollama, locally', body: 'Run models on your own machine — nothing leaves your infrastructure.' },
      { title: 'Agents bring their own LLM', body: 'MCP clients use their own model; HermodMail\'s provider setting is only for its built-in assistant.' },
    ],
    fencing:
      'Email content is untrusted by definition: text fed to the model is fenced as data and the system prompt forbids treating it as instructions.',
  },
  developers: {
    eyebrow: 'For developers',
    title: 'Running your own is the point.',
    lead: 'A single Node server with a SQLite database, or a container. No external services required.',
    tabs: {
      docker: 'Docker / Podman',
      source: 'From source',
      mcp: 'MCP client',
    },
    docker: {
      comment1: '# .env holds HERMODMAIL_SECRET — the encryption master key',
      comment2: '# or: podman-compose up -d --build',
      result: 'HermodMail listens on http://localhost:8667 and stores everything in the hermodmail-data volume.',
    },
    source: {
      comment1: '# Requires Node >= 22',
      comment2: '# development servers: npm run dev + npm run dev:web (see README)',
      comment3: '# production:',
      firstRun: 'Open http://localhost:8667 — the first visit creates your admin account.',
    },
    mcp: {
      intro: 'Create a token in Settings → API tokens (MCP), pick its scopes, then point your MCP client at the server:',
      securityTitle: 'Before going public',
      security: 'Set a strong HERMODMAIL_SECRET, serve the app behind TLS (the README includes a ready-to-copy Caddy reverse-proxy configuration) and read the security notes before exposing anything to the internet.',
      readmeLink: 'Full installation guide',
    },
    copy: 'Copy',
    copied: 'Copied',
  },
  opensource: {
    eyebrow: 'Open source, by design',
    title: 'Your mail server should be inspectable.',
    lead: 'HermodMail is free software under AGPL-3.0-or-later. Read the engine, audit the crypto, run the test suite — and change what does not suit you.',
    points: [
      { title: 'AGPL-3.0-or-later', body: 'The full license text ships with the repository.' },
      { title: 'Readable architecture', body: 'A core engine, thin HTTP and MCP adapters, a Vue 3 front-end. Nothing hidden.' },
      { title: 'An extensive test suite', body: '200 automated tests (unit and property-based) cover the engine, auth, crypto, the MCP surface and static serving.' },
      { title: 'Continuous integration & audits', body: 'GitHub Actions runs typecheck, build, tests and dependency audits (npm audit) on Node 22 and 24 for every change.' },
    ],
    links: {
      code: 'Read the source',
      issues: 'Report an issue',
      license: 'Read the license',
    },
    stage: 'HermodMail is a young project (v0.1.0-beta.1 — first public beta) under active development — tested with real mailboxes, built to grow in the open.',
  },
  conclusion: {
    title: 'The agent did the work. <em>The human kept the decision.</em>',
    lead: 'One mailbox, one engine, controlled permissions — and a home for both the people and the machines that work there.',
    cta: 'Download the beta',
    links: {
      source: 'View the source',
      docs: 'Documentation',
      issues: 'Report an issue',
    },
    myth:
      'Hermod\'r, messenger of Norse myth, crossed worlds to deliver what mattered. HermodMail delivers yours — to you, first.',
  },
};

export type Dictionary = typeof en;
