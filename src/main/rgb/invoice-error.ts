import { SecurityViolation } from '../security/rules'
// Explain rejected input without changing the payment destination or invoice contents.
export function invoiceDecodeError(invoice: string, error: unknown): unknown {
  const message = String((error as { message?: string })?.message ?? error)
  if (!/invalid invoice/i.test(message)) return error

  const characters = Array.from(invoice)
  const index = characters.findIndex((character) => /[^\x21-\x7e]|[<>"{}|\\^`]/u.test(character))
  if (index !== -1) {
    const character = characters[index]
    const code = character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')
    const label = /[\p{C}\p{Z}\s]/u.test(character)
      ? `an invisible or whitespace character (U+${code})`
      : `“${character}” (U+${code})`
    const location = index === characters.length - 1 ? 'at the end' : `at character ${index + 1}`
    return new SecurityViolation(
      'invoice-format',
      `The invoice could not be read. It contains an unexpected character ${location}: ${label}. Compare it with the original invoice and remove any accidental extra character, or copy the full invoice again from your friend. The invoice has not been changed automatically.`
    )
  }
  return new SecurityViolation(
    'invoice-format',
    'The invoice could not be read. Copy the full RGB invoice again from your friend, without extra text. If it still fails, ask for a new invoice.'
  )
}
