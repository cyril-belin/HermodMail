import { ref } from 'vue'
import { api, ApiError } from '@/lib/api'

/**
 * Minimal reactive i18n for HermodMail. Three supported locales (fr, en, es);
 * French is the fallback for any unsupported browser language or missing key.
 *
 * Persistence: the explicit choice goes to localStorage immediately and to the
 * user's server settings (best effort). A server-side choice set from another
 * browser wins over the local one on the next settings load.
 */

export type Locale = 'fr' | 'en' | 'es'

export const LOCALES: Locale[] = ['fr', 'en', 'es']

/** Native names — always shown in their own language in the picker. */
export const LOCALE_NAMES: Record<Locale, string> = { fr: 'Français', en: 'English', es: 'Español' }

const STORAGE_KEY = 'hermodmail.locale'

function normalize(code: string): Locale | null {
  const base = code.toLowerCase().split('-')[0] ?? ''
  return base === 'fr' || base === 'en' || base === 'es' ? (base as Locale) : null
}

function storedLocale(): Locale | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return v ? normalize(v) : null
  } catch {
    return null
  }
}

function detectBrowserLocale(): Locale {
  const candidates = [...(navigator.languages ?? []), navigator.language ?? '']
  for (const code of candidates) {
    const l = normalize(code)
    if (l) return l
  }
  return 'fr' // documented fallback
}

/** Reactive UI locale, initialized once at module load. */
export const locale = ref<Locale>(storedLocale() ?? detectBrowserLocale())

// Remember even the detected value so the server-side preference (set from
// another browser) can take precedence later without ambiguity.
try {
  localStorage.setItem(STORAGE_KEY, locale.value)
} catch {
  /* private mode etc. — in-memory locale still works */
}

export function setLocale(l: Locale): void {
  locale.value = l
  try {
    localStorage.setItem(STORAGE_KEY, l)
  } catch {
    /* ignore */
  }
  // Persist server-side for the same user on other devices; harmless 401 when
  // not logged in yet (e.g. from the login screen).
  void api.put('/api/settings', { locale: l }).catch(() => {})
}

/** Called by the settings store: an explicit server-side choice wins locally. */
export function adoptServerLocale(serverLocale: string): void {
  const l = normalize(serverLocale)
  if (l && l !== locale.value) setLocale(l)
}

type Dict = Record<string, string>

const fr: Dict = {
  // ---- login / setup -------------------------------------------------------
  'login.signin': 'Se connecter',
  'login.signing_in': 'Connexion…',
  'login.email': 'Email',
  'login.password': 'Mot de passe',
  'setup.welcome': 'Bienvenue sur HermodMail',
  'setup.subtitle': 'Créer le premier compte administrateur',
  'setup.display_name': 'Nom affiché',
  'setup.password_hint': 'Mot de passe (8 caractères minimum)',
  'setup.confirm': 'Confirmer le mot de passe',
  'setup.mismatch': 'Les mots de passe ne correspondent pas',
  'setup.creating': 'Création…',
  'setup.create': 'Créer le compte administrateur',

  // ---- top bar / folders ----------------------------------------------------
  'nav.compose': 'Écrire',
  'nav.settings': 'Paramètres',
  'nav.sign_out': 'Déconnexion ({email})',
  'nav.search_placeholder': 'Rechercher dans tous les dossiers…',
  'folders.title': 'Dossiers',
  'folders.new_folder': 'Nouveau dossier',
  'folders.refresh': 'Actualiser',
  'folders.refreshing': 'Actualisation…',
  'folders.create_title': 'Nouveau dossier',
  'folders.create_desc': "Utilisez le délimiteur du serveur pour l'imbrication, ex. Travail/Projets",
  'folders.name_placeholder': 'Nom du dossier',
  'common.cancel': 'Annuler',
  'common.create': 'Créer',

  // ---- message list -----------------------------------------------------------
  'list.filter_all': 'Tous',
  'list.filter_unseen': 'Non lus',
  'list.filter_flagged': 'Suivis',
  'list.filter_attachments': 'Pièces jointes',
  'list.count': '{n} messages',
  'list.loading': 'Chargement…',
  'list.results': '{n} résultats dans tous les dossiers — ',
  'list.clear': 'effacer',
  'list.no_messages': 'Aucun message',
  'list.newer': 'Récents',
  'list.older': 'Anciens',
  'list.unread_title': 'Non lu',
  'list.summarized': 'résumé',
  'list.no_subject': '(sans objet)',
  'list.unknown_recipient': '(inconnu)',

  // ---- reader -------------------------------------------------------------------
  'reader.fetching': 'Récupération du message…',
  'reader.flag': 'Suivre',
  'reader.unflag': 'Ne plus suivre',
  'reader.mark_read': 'Marquer comme lu',
  'reader.mark_unread': 'Marquer comme non lu',
  'reader.reply': 'Répondre',
  'reader.reply_all': 'Répondre à tous',
  'reader.edit_draft': 'Modifier le brouillon',
  'reader.delete': 'Supprimer',
  'reader.ai_summary': 'Résumé IA',
  'reader.ai_draft': 'Réponse IA',
  'reader.thinking': 'Réflexion…',
  'reader.use_reply': 'Utiliser cette réponse',
  'reader.use_reply_confirm': 'Une réponse est déjà en cours de rédaction. Remplacer son contenu par la proposition IA ?',
  'reader.no_body': '(pas de contenu)',
  'reader.select_message': 'Sélectionnez un message pour le lire',
  'reader.attachment_oversize': 'Trop volumineuse pour être mise en cache — téléchargement indisponible',
  'reader.download': 'Télécharger',
  'reader.to': 'à {recipients}',
  'reader.quote_prefix': 'Le {when}, {who} a écrit :',

  // ---- translation ------------------------------------------------------------------
  'translate.button': 'Traduire',
  'translate.busy': 'Traduction…',
  'translate.target_label': 'Traduire vers',
  'translate.show_original': 'Original',
  'translate.show_translation': 'Traduction',
  'translate.banner': 'Traduit de l’{from} vers le {to}',
  'translate.banner_unknown_source': 'Traduit vers le {to}',
  'translate.lang_fr': 'français',
  'translate.lang_en': 'anglais',
  'translate.lang_es': 'espagnol',
  'translate.lang_unknown': 'langue inconnue',

  // ---- compose --------------------------------------------------------------------------
  'compose.reply_title': 'Répondre',
  'compose.new_title': 'Nouveau message',
  'compose.from': 'De : {name}',
  'compose.to': 'À',
  'compose.cc': 'Cc',
  'compose.subject': 'Objet',
  'compose.subject_placeholder': 'Objet',
  'compose.body_placeholder': 'Écrivez votre message…',
  'compose.attachments': 'Pièces jointes',
  'compose.files_attached': '{n} fichier(s) joint(s)',
  'compose.save_draft': 'Enregistrer le brouillon',
  'compose.saving_draft': 'Enregistrement…',
  'compose.send': 'Envoyer',
  'compose.sending': 'Envoi…',
  'compose.sent': 'Message envoyé.',

  // ---- settings ---------------------------------------------------------------------------
  'settings.title': 'Paramètres',
  'settings.tab_accounts': 'Comptes mail',
  'settings.tab_contacts': 'Contacts',
  'settings.tab_tokens': 'Jetons API (MCP)',
  'settings.tab_users': 'Utilisateurs',
  'settings.tab_ai': 'IA',
  'settings.language_title': 'Langue de l’interface',
  'settings.language_desc': 'Choix mémorisé sur cet appareil et associé à votre compte pour vos autres appareils.',
  'settings.appearance_title': 'Langue et apparence',
  'settings.theme_title': 'Thème',
  'settings.theme_auto': 'Automatique (système)',
  'settings.theme_light': 'Clair',
  'settings.theme_dark': 'Sombre',

  'settings.sync_card_title': 'Synchronisation',
  'settings.sync_card_desc': 'Fréquence de rafraîchissement automatique de la boîte de réception.',
  'settings.refresh_0': 'Manuel uniquement',
  'settings.refresh_30000': '30 secondes',
  'settings.refresh_60000': '1 minute',
  'settings.refresh_120000': '2 minutes',
  'settings.refresh_300000': '5 minutes',
  'settings.refresh_600000': '10 minutes',

  'settings.add_account': 'Ajouter un compte mail',
  'settings.testing': 'Test…',
  'settings.test': 'Test',
  'settings.test_ok': 'Connexion OK — {n} dossier(s)',
  'settings.edit': 'Modifier',
  'settings.delete_account_confirm': 'Retirer ce compte d’HermodMail ? Les messages sur le serveur mail ne sont pas touchés.',
  'settings.no_accounts': 'Aucun compte mail pour l’instant. Ajoutez-en un pour lire vos messages.',
  'settings.edit_account_title': 'Modifier le compte',
  'settings.add_account_title': 'Ajouter un compte mail',
  'settings.edit_account_desc': 'Laissez les mots de passe vides pour conserver ceux enregistrés.',
  'settings.add_account_desc': 'Vos identifiants sont chiffrés (AES-256-GCM) avant stockage.',
  'settings.acc_name': 'Nom du compte',
  'settings.acc_email': 'Adresse email',
  'settings.imap_section': 'IMAP (entrant)',
  'settings.smtp_section': 'SMTP (sortant)',
  'settings.host': 'Hôte',
  'settings.port': 'Port',
  'settings.security': 'Sécurité',
  'settings.security_none': 'Aucune',
  'settings.username': 'Identifiant',
  'settings.username_imap_hint': 'généralement votre email',
  'settings.username_smtp_hint': '(vide = celui de l’IMAP)',
  'settings.password_app': 'Mot de passe / mot de passe d’application',
  'settings.password_smtp_hint': '(vide = celui de l’IMAP)',
  'settings.unchanged': '(inchangé)',
  'settings.saving': 'Enregistrement…',
  'settings.save': 'Enregistrer',

  'settings.contacts_card_title': 'Carnet d’adresses automatique',
  'settings.contacts_card_desc':
    'Les correspondants de vos mails reçus et envoyés sont ajoutés automatiquement et alimentent l’autocomplétion à la rédaction. Vous pouvez aussi créer, modifier ou supprimer des contacts manuellement.',
  'settings.new_contact': 'Nouveau contact',
  'settings.message_count': '{n} message(s)',
  'settings.source_manual': '· manuel',
  'settings.no_contacts': 'Aucun contact pour l’instant — ils apparaissent automatiquement dès que vous recevez ou envoyez des mails.',
  'settings.edit_contact_title': 'Modifier le contact',
  'settings.new_contact_title': 'Nouveau contact',
  'settings.contact_email': 'Email',
  'settings.contact_name': 'Nom affiché',
  'settings.optional': 'optionnel',
  'settings.delete_contact_confirm': 'Supprimer ce contact ? (il pourra être reconstitué automatiquement depuis les prochains mails)',

  'settings.tokens_card_title': 'Connecter des agents IA via MCP',
  'settings.tokens_card_desc':
    'Créez un jeton avec permissions, puis pointez votre client MCP vers <code>/mcp</code> avec l’en-tête <code>Authorization: Bearer &lt;token&gt;</code>. Le jeton n’accorde que les permissions sélectionnées.',
  'settings.token_name': 'Nom du jeton',
  'settings.create': 'Créer',
  'settings.token_created': 'Jeton créé — copiez-le maintenant, il ne sera plus jamais affiché :',
  'settings.close': 'Fermer',
  'settings.mask': 'Masquer',
  'settings.unmask': 'Afficher',
  'settings.copy': 'Copier',
  'settings.copied': 'Copié !',
  'settings.copy_failed': 'Copie impossible dans ce navigateur — affichez le jeton et copiez-le manuellement.',
  'settings.revoke': 'Révoquer',
  'settings.revoke_confirm': 'Révoquer ce jeton ? Les agents connectés perdent immédiatement l’accès.',
  'settings.edit_scopes': 'Modifier les permissions',
  'settings.edit_scopes_title': 'Modifier les permissions',
  'settings.edit_scopes_desc':
    'La valeur du jeton ne change pas : l’agent configuré continue de fonctionner sans modification. Les changements prennent effet immédiatement.',
  'settings.new_privileges_confirm': 'Ce jeton va obtenir de nouveaux privilèges : {scopes}. Confirmer ?',
  'settings.no_tokens': 'Aucun jeton pour l’instant.',
  'settings.token_hash_note':
    'La valeur complète d’un jeton n’est visible qu’au moment de sa création — seul son empreinte (hash) est conservée. Un jeton existant ne peut donc pas être copié ni réaffiché : si vous l’avez perdu, révoquez-le et créez-en un nouveau.',
  'settings.created_at': 'créé le {date}',

  'settings.users_email': 'Email',
  'settings.users_display_name': 'Nom affiché',
  'settings.users_password': 'Mot de passe',
  'settings.users_admin': 'Administrateur',
  'settings.create_user': 'Créer l’utilisateur',
  'settings.delete_user_confirm': 'Supprimer cet utilisateur ? Tous ses comptes mail et jetons seront supprimés.',

  'settings.ai_provider': 'Fournisseur',
  'settings.ai_disabled': 'Désactivé',
  'settings.ai_ollama': 'Ollama (local)',
  'settings.ai_openai': 'API compatible OpenAI',
  'settings.ai_model': 'Modèle',
  'settings.ai_base_url': 'URL de base (vide = défaut)',
  'settings.ai_api_key': 'Clé API (compatible OpenAI uniquement)',
  'settings.ai_api_key_ph': 'stockée chiffrée ; laissez vide pour conserver',
  'settings.ai_hint': 'Consigne système personnalisée (ton, langue…)',
  'settings.ai_hint_ph': 'ex. Toujours répondre en français',
  'settings.test_connection': 'Tester la connexion',
  'settings.provider_replied': 'Le fournisseur a répondu : « {reply} »',
  'settings.ai_security_note':
    'Le contenu des mails est toujours isolé en donnée non fiable avant envoi au modèle (garde anti-injection). Les résumés et brouillons IA sont stockés par message et inclus dans les exports MCP.',

  // ---- errors (server codes + common messages) ------------------------------------------------
  'error.unauthorized': 'Session expirée ou authentification requise.',
  'error.forbidden': 'Action non autorisée pour ce compte ou ce jeton.',
  'error.not_found': 'Ressource introuvable.',
  'error.conflict': 'Conflit : cette opération est déjà en cours ou la ressource existe déjà.',
  'error.mail_connection': 'Échec de connexion au serveur mail.',
  'error.mail_protocol': 'Le serveur mail a répondu une erreur de protocole.',
  'error.ai_unavailable': 'Le fournisseur IA est indisponible ou mal configuré.',
  'error.internal': 'Erreur interne du serveur.',
  'error.network': 'Impossible de joindre le serveur — vérifiez votre connexion.',
  'error.unsupported_refresh': 'Intervalle de rafraîchissement non pris en charge.',
  'error.no_text_content': 'Ce message n’a pas de contenu texte à traiter.',
  'error.unsupported_target': 'Langue cible non prise en charge.',
  'error.ai_not_configured': "L'IA n'est pas configurée. Un administrateur peut la configurer dans Paramètres → IA.",
  'error.ai_no_key': 'Le fournisseur IA « compatible OpenAI » nécessite une clé API.',
  'error.login_failed': 'Connexion impossible.',
  'error.setup_failed': 'Échec de la création du compte.',
  'error.generic': 'Une erreur est survenue.',
}

const en: Dict = {
  'login.signin': 'Sign in',
  'login.signing_in': 'Signing in…',
  'login.email': 'Email',
  'login.password': 'Password',
  'setup.welcome': 'Welcome to HermodMail',
  'setup.subtitle': 'Create the first administrator account',
  'setup.display_name': 'Display name',
  'setup.password_hint': 'Password (min. 8 characters)',
  'setup.confirm': 'Confirm password',
  'setup.mismatch': 'Passwords do not match',
  'setup.creating': 'Creating…',
  'setup.create': 'Create admin account',

  'nav.compose': 'Compose',
  'nav.settings': 'Settings',
  'nav.sign_out': 'Sign out ({email})',
  'nav.search_placeholder': 'Search all folders…',
  'folders.title': 'Folders',
  'folders.new_folder': 'New folder',
  'folders.refresh': 'Refresh',
  'folders.refreshing': 'Refreshing…',
  'folders.create_title': 'New folder',
  'folders.create_desc': "Use the server's delimiter for nesting, e.g. Work/Projects",
  'folders.name_placeholder': 'Folder name',
  'common.cancel': 'Cancel',
  'common.create': 'Create',

  'list.filter_all': 'All',
  'list.filter_unseen': 'Unread',
  'list.filter_flagged': 'Flagged',
  'list.filter_attachments': 'Attachments',
  'list.count': '{n} messages',
  'list.loading': 'Loading…',
  'list.results': '{n} results across folders — ',
  'list.clear': 'clear',
  'list.no_messages': 'No messages',
  'list.newer': 'Newer',
  'list.older': 'Older',
  'list.unread_title': 'Unread',
  'list.summarized': 'summarized',
  'list.no_subject': '(no subject)',
  'list.unknown_recipient': '(unknown)',

  'reader.fetching': 'Fetching message…',
  'reader.flag': 'Flag',
  'reader.unflag': 'Unflag',
  'reader.mark_read': 'Mark read',
  'reader.mark_unread': 'Mark unread',
  'reader.reply': 'Reply',
  'reader.reply_all': 'Reply all',
  'reader.edit_draft': 'Edit draft',
  'reader.delete': 'Delete',
  'reader.ai_summary': 'AI summary',
  'reader.ai_draft': 'AI draft reply',
  'reader.thinking': 'Thinking…',
  'reader.use_reply': 'Use this reply',
  'reader.use_reply_confirm': 'A reply is already being drafted. Replace its content with the AI proposal?',
  'reader.no_body': '(no body)',
  'reader.select_message': 'Select a message to read it',
  'reader.attachment_oversize': 'Too large to be cached — unavailable for download',
  'reader.download': 'Download',
  'reader.to': 'to {recipients}',
  'reader.quote_prefix': 'On {when}, {who} wrote:',

  'translate.button': 'Translate',
  'translate.busy': 'Translating…',
  'translate.target_label': 'Translate to',
  'translate.show_original': 'Original',
  'translate.show_translation': 'Translation',
  'translate.banner': 'Translated from {from} to {to}',
  'translate.banner_unknown_source': 'Translated to {to}',
  'translate.lang_fr': 'French',
  'translate.lang_en': 'English',
  'translate.lang_es': 'Spanish',
  'translate.lang_unknown': 'unknown language',

  'compose.reply_title': 'Reply',
  'compose.new_title': 'New message',
  'compose.from': 'From: {name}',
  'compose.to': 'To',
  'compose.cc': 'Cc',
  'compose.subject': 'Subject',
  'compose.subject_placeholder': 'Subject',
  'compose.body_placeholder': 'Write your message…',
  'compose.attachments': 'Attachments',
  'compose.files_attached': '{n} file(s) attached',
  'compose.save_draft': 'Save draft',
  'compose.saving_draft': 'Saving…',
  'compose.send': 'Send',
  'compose.sending': 'Sending…',
  'compose.sent': 'Message sent.',

  'settings.title': 'Settings',
  'settings.tab_accounts': 'Mail accounts',
  'settings.tab_contacts': 'Contacts',
  'settings.tab_tokens': 'API tokens (MCP)',
  'settings.tab_users': 'Users',
  'settings.tab_ai': 'AI',
  'settings.language_title': 'Interface language',
  'settings.language_desc': 'Remembered on this device and linked to your account for your other devices.',
  'settings.appearance_title': 'Language & appearance',
  'settings.theme_title': 'Theme',
  'settings.theme_auto': 'Automatic (system)',
  'settings.theme_light': 'Light',
  'settings.theme_dark': 'Dark',

  'settings.sync_card_title': 'Synchronization',
  'settings.sync_card_desc': 'Automatic inbox refresh frequency.',
  'settings.refresh_0': 'Manual only',
  'settings.refresh_30000': '30 seconds',
  'settings.refresh_60000': '1 minute',
  'settings.refresh_120000': '2 minutes',
  'settings.refresh_300000': '5 minutes',
  'settings.refresh_600000': '10 minutes',

  'settings.add_account': 'Add mail account',
  'settings.testing': 'Testing…',
  'settings.test': 'Test',
  'settings.test_ok': 'Connection OK — {n} folder(s)',
  'settings.edit': 'Edit',
  'settings.delete_account_confirm': 'Remove this account from HermodMail? Messages on the mail server are not touched.',
  'settings.no_accounts': 'No mail account yet. Add one to start reading mail.',
  'settings.edit_account_title': 'Edit account',
  'settings.add_account_title': 'Add mail account',
  'settings.edit_account_desc': 'Leave passwords blank to keep the stored ones.',
  'settings.add_account_desc': 'Your credentials are encrypted (AES-256-GCM) before storage.',
  'settings.acc_name': 'Account name',
  'settings.acc_email': 'Email address',
  'settings.imap_section': 'IMAP (incoming)',
  'settings.smtp_section': 'SMTP (outgoing)',
  'settings.host': 'Host',
  'settings.port': 'Port',
  'settings.security': 'Security',
  'settings.security_none': 'None',
  'settings.username': 'Username',
  'settings.username_imap_hint': 'usually your email',
  'settings.username_smtp_hint': '(blank = IMAP one)',
  'settings.password_app': 'Password / app password',
  'settings.password_smtp_hint': '(blank = IMAP one)',
  'settings.unchanged': '(unchanged)',
  'settings.saving': 'Saving…',
  'settings.save': 'Save',

  'settings.contacts_card_title': 'Automatic address book',
  'settings.contacts_card_desc':
    'Correspondents from your incoming and outgoing mail are added automatically and power compose autocompletion. You can also create, edit or delete contacts manually.',
  'settings.new_contact': 'New contact',
  'settings.message_count': '{n} message(s)',
  'settings.source_manual': '· manual',
  'settings.no_contacts': 'No contacts yet — they appear automatically as soon as you receive or send mail.',
  'settings.edit_contact_title': 'Edit contact',
  'settings.new_contact_title': 'New contact',
  'settings.contact_email': 'Email',
  'settings.contact_name': 'Display name',
  'settings.optional': 'optional',
  'settings.delete_contact_confirm': 'Delete this contact? (it can be rebuilt automatically from future mail)',

  'settings.tokens_card_title': 'Connect AI agents via MCP',
  'settings.tokens_card_desc':
    'Create a scoped token, then point your MCP client at <code>/mcp</code> with header <code>Authorization: Bearer &lt;token&gt;</code>. The token only grants the scopes you select.',
  'settings.token_name': 'Token name',
  'settings.create': 'Create',
  'settings.token_created': 'Token created — copy it now, it will not be shown again:',
  'settings.close': 'Close',
  'settings.mask': 'Hide',
  'settings.unmask': 'Show',
  'settings.copy': 'Copy',
  'settings.copied': 'Copied!',
  'settings.copy_failed': 'Cannot copy in this browser — reveal the token and copy it manually.',
  'settings.revoke': 'Revoke',
  'settings.revoke_confirm': 'Revoke this token? Connected agents will lose access immediately.',
  'settings.edit_scopes': 'Edit permissions',
  'settings.edit_scopes_title': 'Edit permissions',
  'settings.edit_scopes_desc':
    "The token value does not change: the configured agent keeps working without changes. Changes take effect immediately.",
  'settings.new_privileges_confirm': 'This token will gain new privileges: {scopes}. Confirm?',
  'settings.no_tokens': 'No token yet.',
  'settings.token_hash_note':
    "A token's full value is only visible at creation time — only its hash is stored. An existing token can therefore not be copied or shown again: if you lost it, revoke it and create a new one.",
  'settings.created_at': 'created {date}',

  'settings.users_email': 'Email',
  'settings.users_display_name': 'Display name',
  'settings.users_password': 'Password',
  'settings.users_admin': 'Administrator',
  'settings.create_user': 'Create user',
  'settings.delete_user_confirm': 'Delete this user? All their mail accounts and tokens will be removed.',

  'settings.ai_provider': 'Provider',
  'settings.ai_disabled': 'Disabled',
  'settings.ai_ollama': 'Ollama (local)',
  'settings.ai_openai': 'OpenAI-compatible API',
  'settings.ai_model': 'Model',
  'settings.ai_base_url': 'Base URL (blank = default)',
  'settings.ai_api_key': 'API key (OpenAI-compatible only)',
  'settings.ai_api_key_ph': 'stored encrypted; leave blank to keep',
  'settings.ai_hint': 'Custom system hint (tone, language…)',
  'settings.ai_hint_ph': 'e.g. Always answer in English',
  'settings.test_connection': 'Test connection',
  'settings.provider_replied': 'Provider replied: "{reply}"',
  'settings.ai_security_note':
    'Email content is always fenced as untrusted data before being sent to the model (prompt-injection guard). AI summaries and drafts are stored per message and included in MCP exports.',

  'error.unauthorized': 'Session expired or authentication required.',
  'error.forbidden': 'Action not allowed for this account or token.',
  'error.not_found': 'Resource not found.',
  'error.conflict': 'Conflict: this operation is already running or the resource already exists.',
  'error.mail_connection': 'Failed to connect to the mail server.',
  'error.mail_protocol': 'The mail server answered with a protocol error.',
  'error.ai_unavailable': 'The AI provider is unavailable or misconfigured.',
  'error.internal': 'Internal server error.',
  'error.network': 'Cannot reach the server — check your connection.',
  'error.unsupported_refresh': 'Unsupported refresh interval.',
  'error.no_text_content': 'This message has no text content to process.',
  'error.unsupported_target': 'Unsupported target language.',
  'error.ai_not_configured': 'AI is not configured. An administrator can configure it in Settings → AI.',
  'error.ai_no_key': 'The "OpenAI-compatible" AI provider requires an API key.',
  'error.login_failed': 'Login failed.',
  'error.setup_failed': 'Setup failed.',
  'error.generic': 'Something went wrong.',
}

const es: Dict = {
  'login.signin': 'Iniciar sesión',
  'login.signing_in': 'Iniciando sesión…',
  'login.email': 'Correo electrónico',
  'login.password': 'Contraseña',
  'setup.welcome': 'Bienvenido a HermodMail',
  'setup.subtitle': 'Crea la primera cuenta de administrador',
  'setup.display_name': 'Nombre visible',
  'setup.password_hint': 'Contraseña (mín. 8 caracteres)',
  'setup.confirm': 'Confirmar contraseña',
  'setup.mismatch': 'Las contraseñas no coinciden',
  'setup.creating': 'Creando…',
  'setup.create': 'Crear cuenta de administrador',

  'nav.compose': 'Redactar',
  'nav.settings': 'Ajustes',
  'nav.sign_out': 'Cerrar sesión ({email})',
  'nav.search_placeholder': 'Buscar en todas las carpetas…',
  'folders.title': 'Carpetas',
  'folders.new_folder': 'Nueva carpeta',
  'folders.refresh': 'Actualizar',
  'folders.refreshing': 'Actualizando…',
  'folders.create_title': 'Nueva carpeta',
  'folders.create_desc': 'Usa el delimitador del servidor para anidar, p. ej. Trabajo/Proyectos',
  'folders.name_placeholder': 'Nombre de la carpeta',
  'common.cancel': 'Cancelar',
  'common.create': 'Crear',

  'list.filter_all': 'Todos',
  'list.filter_unseen': 'No leídos',
  'list.filter_flagged': 'Destacados',
  'list.filter_attachments': 'Adjuntos',
  'list.count': '{n} mensajes',
  'list.loading': 'Cargando…',
  'list.results': '{n} resultados en todas las carpetas — ',
  'list.clear': 'borrar',
  'list.no_messages': 'No hay mensajes',
  'list.newer': 'Recientes',
  'list.older': 'Anteriores',
  'list.unread_title': 'No leído',
  'list.summarized': 'resumido',
  'list.no_subject': '(sin asunto)',
  'list.unknown_recipient': '(desconocido)',

  'reader.fetching': 'Recuperando mensaje…',
  'reader.flag': 'Destacar',
  'reader.unflag': 'Quitar destacado',
  'reader.mark_read': 'Marcar como leído',
  'reader.mark_unread': 'Marcar como no leído',
  'reader.reply': 'Responder',
  'reader.reply_all': 'Responder a todos',
  'reader.edit_draft': 'Editar borrador',
  'reader.delete': 'Eliminar',
  'reader.ai_summary': 'Resumen IA',
  'reader.ai_draft': 'Respuesta IA',
  'reader.thinking': 'Pensando…',
  'reader.use_reply': 'Usar esta respuesta',
  'reader.use_reply_confirm': 'Ya hay una respuesta en redacción. ¿Reemplazar su contenido con la propuesta de la IA?',
  'reader.no_body': '(sin contenido)',
  'reader.select_message': 'Selecciona un mensaje para leerlo',
  'reader.attachment_oversize': 'Demasiado grande para almacenarse en caché — descarga no disponible',
  'reader.download': 'Descargar',
  'reader.to': 'para {recipients}',
  'reader.quote_prefix': 'El {when}, {who} escribió:',

  'translate.button': 'Traducir',
  'translate.busy': 'Traduciendo…',
  'translate.target_label': 'Traducir al',
  'translate.show_original': 'Original',
  'translate.show_translation': 'Traducción',
  'translate.banner': 'Traducido del {from} al {to}',
  'translate.banner_unknown_source': 'Traducido al {to}',
  'translate.lang_fr': 'francés',
  'translate.lang_en': 'inglés',
  'translate.lang_es': 'español',
  'translate.lang_unknown': 'idioma desconocido',

  'compose.reply_title': 'Responder',
  'compose.new_title': 'Mensaje nuevo',
  'compose.from': 'De: {name}',
  'compose.to': 'Para',
  'compose.cc': 'Cco',
  'compose.subject': 'Asunto',
  'compose.subject_placeholder': 'Asunto',
  'compose.body_placeholder': 'Escribe tu mensaje…',
  'compose.attachments': 'Adjuntos',
  'compose.files_attached': '{n} archivo(s) adjunto(s)',
  'compose.save_draft': 'Guardar borrador',
  'compose.saving_draft': 'Guardando…',
  'compose.send': 'Enviar',
  'compose.sending': 'Enviando…',
  'compose.sent': 'Mensaje enviado.',

  'settings.title': 'Ajustes',
  'settings.tab_accounts': 'Cuentas de correo',
  'settings.tab_contacts': 'Contactos',
  'settings.tab_tokens': 'Tokens API (MCP)',
  'settings.tab_users': 'Usuarios',
  'settings.tab_ai': 'IA',
  'settings.language_title': 'Idioma de la interfaz',
  'settings.language_desc': 'Se recuerda en este dispositivo y se asocia a tu cuenta para tus otros dispositivos.',
  'settings.appearance_title': 'Idioma y apariencia',
  'settings.theme_title': 'Tema',
  'settings.theme_auto': 'Automático (sistema)',
  'settings.theme_light': 'Claro',
  'settings.theme_dark': 'Oscuro',

  'settings.sync_card_title': 'Sincronización',
  'settings.sync_card_desc': 'Frecuencia de actualización automática de la bandeja de entrada.',
  'settings.refresh_0': 'Solo manual',
  'settings.refresh_30000': '30 segundos',
  'settings.refresh_60000': '1 minuto',
  'settings.refresh_120000': '2 minutos',
  'settings.refresh_300000': '5 minutos',
  'settings.refresh_600000': '10 minutos',

  'settings.add_account': 'Añadir cuenta de correo',
  'settings.testing': 'Probando…',
  'settings.test': 'Probar',
  'settings.test_ok': 'Conexión OK — {n} carpeta(s)',
  'settings.edit': 'Editar',
  'settings.delete_account_confirm': '¿Quitar esta cuenta de HermodMail? Los mensajes del servidor de correo no se tocan.',
  'settings.no_accounts': 'Aún no hay cuentas de correo. Añade una para empezar a leer.',
  'settings.edit_account_title': 'Editar cuenta',
  'settings.add_account_title': 'Añadir cuenta de correo',
  'settings.edit_account_desc': 'Deja las contraseñas vacías para conservar las guardadas.',
  'settings.add_account_desc': 'Tus credenciales se cifran (AES-256-GCM) antes de guardarse.',
  'settings.acc_name': 'Nombre de la cuenta',
  'settings.acc_email': 'Dirección de correo',
  'settings.imap_section': 'IMAP (entrante)',
  'settings.smtp_section': 'SMTP (saliente)',
  'settings.host': 'Servidor',
  'settings.port': 'Puerto',
  'settings.security': 'Seguridad',
  'settings.security_none': 'Ninguna',
  'settings.username': 'Usuario',
  'settings.username_imap_hint': 'normalmente tu correo',
  'settings.username_smtp_hint': '(vacío = el de IMAP)',
  'settings.password_app': 'Contraseña / contraseña de aplicación',
  'settings.password_smtp_hint': '(vacío = el de IMAP)',
  'settings.unchanged': '(sin cambios)',
  'settings.saving': 'Guardando…',
  'settings.save': 'Guardar',

  'settings.contacts_card_title': 'Libreta de direcciones automática',
  'settings.contacts_card_desc':
    'Los corresponsales de tu correo recibido y enviado se añaden automáticamente y alimentan el autocompletado al redactar. También puedes crear, editar o eliminar contactos manualmente.',
  'settings.new_contact': 'Nuevo contacto',
  'settings.message_count': '{n} mensaje(s)',
  'settings.source_manual': '· manual',
  'settings.no_contacts': 'Aún no hay contactos — aparecen automáticamente en cuanto recibes o envías correos.',
  'settings.edit_contact_title': 'Editar contacto',
  'settings.new_contact_title': 'Nuevo contacto',
  'settings.contact_email': 'Correo electrónico',
  'settings.contact_name': 'Nombre visible',
  'settings.optional': 'opcional',
  'settings.delete_contact_confirm': '¿Eliminar este contacto? (podrá reconstruirse automáticamente con los próximos correos)',

  'settings.tokens_card_title': 'Conectar agentes de IA vía MCP',
  'settings.tokens_card_desc':
    'Crea un token con permisos y apunta tu cliente MCP a <code>/mcp</code> con la cabecera <code>Authorization: Bearer &lt;token&gt;</code>. El token solo concede los permisos que selecciones.',
  'settings.token_name': 'Nombre del token',
  'settings.create': 'Crear',
  'settings.token_created': 'Token creado — cópialo ahora, no se volverá a mostrar:',
  'settings.close': 'Cerrar',
  'settings.mask': 'Ocultar',
  'settings.unmask': 'Mostrar',
  'settings.copy': 'Copiar',
  'settings.copied': '¡Copiado!',
  'settings.copy_failed': 'No se puede copiar en este navegador — muestra el token y cópialo manualmente.',
  'settings.revoke': 'Revocar',
  'settings.revoke_confirm': '¿Revocar este token? Los agentes conectados perderán el acceso de inmediato.',
  'settings.edit_scopes': 'Editar permisos',
  'settings.edit_scopes_title': 'Editar permisos',
  'settings.edit_scopes_desc':
    'El valor del token no cambia: el agente configurado sigue funcionando sin cambios. Los cambios surten efecto de inmediato.',
  'settings.new_privileges_confirm': 'Este token obtendrá nuevos privilegios: {scopes}. ¿Confirmar?',
  'settings.no_tokens': 'Aún no hay tokens.',
  'settings.token_hash_note':
    'El valor completo de un token solo es visible al crearlo — solo se guarda su huella (hash). Un token existente no puede copiarse ni mostrarse de nuevo: si lo perdiste, revócalo y crea uno nuevo.',
  'settings.created_at': 'creado el {date}',

  'settings.users_email': 'Correo electrónico',
  'settings.users_display_name': 'Nombre visible',
  'settings.users_password': 'Contraseña',
  'settings.users_admin': 'Administrador',
  'settings.create_user': 'Crear usuario',
  'settings.delete_user_confirm': '¿Eliminar este usuario? Se borrarán todas sus cuentas de correo y tokens.',

  'settings.ai_provider': 'Proveedor',
  'settings.ai_disabled': 'Desactivado',
  'settings.ai_ollama': 'Ollama (local)',
  'settings.ai_openai': 'API compatible con OpenAI',
  'settings.ai_model': 'Modelo',
  'settings.ai_base_url': 'URL base (vacío = predeterminada)',
  'settings.ai_api_key': 'Clave API (solo compatible con OpenAI)',
  'settings.ai_api_key_ph': 'guardada cifrada; deja vacío para conservar',
  'settings.ai_hint': 'Indicación de sistema personalizada (tono, idioma…)',
  'settings.ai_hint_ph': 'p. ej. Responde siempre en español',
  'settings.test_connection': 'Probar conexión',
  'settings.provider_replied': 'El proveedor respondió: «{reply}»',
  'settings.ai_security_note':
    'El contenido de los correos siempre se aísla como dato no fiable antes de enviarse al modelo (protección anti-inyección). Los resúmenes y borradores de IA se guardan por mensaje y se incluyen en las exportaciones MCP.',

  'error.unauthorized': 'Sesión expirada o autenticación requerida.',
  'error.forbidden': 'Acción no permitida para esta cuenta o token.',
  'error.not_found': 'Recurso no encontrado.',
  'error.conflict': 'Conflicto: esta operación ya está en curso o el recurso ya existe.',
  'error.mail_connection': 'No se pudo conectar con el servidor de correo.',
  'error.mail_protocol': 'El servidor de correo devolvió un error de protocolo.',
  'error.ai_unavailable': 'El proveedor de IA no está disponible o está mal configurado.',
  'error.internal': 'Error interno del servidor.',
  'error.network': 'No se puede contactar con el servidor — comprueba tu conexión.',
  'error.unsupported_refresh': 'Intervalo de actualización no admitido.',
  'error.no_text_content': 'Este mensaje no tiene contenido de texto que procesar.',
  'error.unsupported_target': 'Idioma de destino no admitido.',
  'error.ai_not_configured': 'La IA no está configurada. Un administrador puede configurarla en Ajustes → IA.',
  'error.ai_no_key': 'El proveedor de IA «compatible con OpenAI» necesita una clave API.',
  'error.login_failed': 'No se pudo iniciar sesión.',
  'error.setup_failed': 'Error al crear la cuenta.',
  'error.generic': 'Se produjo un error.',
}

const messages: Record<Locale, Dict> = { fr, en, es }

/** Translate a key in the current locale, falling back to French, then the key. */
export function t(key: string, params?: Record<string, string | number>): string {
  const raw = messages[locale.value][key] ?? fr[key] ?? key
  if (!params) return raw
  return raw.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`))
}

// ----- error translation ---------------------------------------------------------------------

const ERROR_CODE_KEYS: Record<string, string> = {
  unauthorized: 'error.unauthorized',
  forbidden: 'error.forbidden',
  not_found: 'error.not_found',
  conflict: 'error.conflict',
  mail_connection: 'error.mail_connection',
  mail_protocol: 'error.mail_protocol',
  ai_unavailable: 'error.ai_unavailable',
  internal: 'error.internal',
}

/** Specific server messages worth translating verbatim; anything else is shown as-is. */
const ERROR_MESSAGE_KEYS: [RegExp, string][] = [
  [/^Unsupported refresh interval$/i, 'error.unsupported_refresh'],
  [/^This message has no text content to (summarize|translate)$/i, 'error.no_text_content'],
  [/^Unsupported target language/i, 'error.unsupported_target'],
  [/^AI is not configured/i, 'error.ai_not_configured'],
  [/AI provider "openai-compatible" requires an API key/i, 'error.ai_no_key'],
]

function matchMessageKey(message: string): string | undefined {
  for (const [re, key] of ERROR_MESSAGE_KEYS) {
    if (re.test(message)) return key
  }
  return undefined
}

/**
 * Best-effort user-facing error message: known server codes/messages become
 * translated sentences (with the raw detail appended when it adds value);
 * anything else falls back to the raw message.
 */
export function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (err instanceof ApiError) {
    const key = ERROR_CODE_KEYS[err.code] ?? matchMessageKey(err.message)
    if (!key) return raw
    // These codes carry a useful provider/protocol detail worth keeping.
    const withDetail = err.code === 'ai_unavailable' || err.code === 'mail_connection' || err.code === 'mail_protocol'
    return withDetail && raw ? `${t(key)} — ${raw}` : t(key)
  }
  if (/failed to fetch|networkerror|load failed/i.test(raw)) return t('error.network')
  return raw
}
