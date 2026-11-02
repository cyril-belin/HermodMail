import { describe, expect, it } from 'vitest'
import { detectLanguage } from '@/lib/langdetect'

describe('detectLanguage (AI-free heuristic)', () => {
  it('detects French', () => {
    expect(detectLanguage('Bonjour, vous trouverez ci-joint la facture du mois. Merci de nous confirmer la réception avant vendredi. Cordialement, Madame Durand.')).toBe('fr')
  })

  it('detects English', () => {
    expect(detectLanguage('Hello, please find attached the invoice for this month. Thank you for your confirmation. Best regards, the team will follow up shortly.')).toBe('en')
  })

  it('detects Spanish', () => {
    expect(detectLanguage('Hola, le adjuntamos la factura del mes. Gracias por su confirmación. Un saludo cordial, estimado señor, estamos a su disposición para más información.')).toBe('es')
  })

  it('works on HTML input (tags are stripped)', () => {
    expect(detectLanguage('<html><body><p>Bonjour, merci pour votre message. Nous vous répondrons très rapidement.</p><p>Cordialement</p></body></html>')).toBe('fr')
  })

  it('reports other languages as "other", not as a false positive', () => {
    expect(detectLanguage('Guten Tag, anbei finden Sie die Rechnung für diesen Monat. Vielen Dank für Ihre Bestätigung und freundliche Grüße.')).toBe('other')
  })

  it('returns null when there is not enough text', () => {
    expect(detectLanguage('Hello!')).toBe(null)
    expect(detectLanguage('')).toBe(null)
    expect(detectLanguage(null)).toBe(null)
  })

  it('returns other for long text in none of the three languages', () => {
    expect(detectLanguage('Sehr geehrte Damen und Herren, hiermit uebersende ich Ihnen die Unterlagen fuer das letzte Quartal. Mit freundlichen Gruessen und vielen Dank im Voraus fuer Ihre Rueckmeldung.')).toBe('other')
  })
})
