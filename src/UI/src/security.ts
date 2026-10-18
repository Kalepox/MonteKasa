import type { PaymentIntent, SecurityOperation } from '../../shared/security'
import './security.css'
import { securityNotice } from './security-notice'
import { visibleSecurityFindings } from './security-filter'
const panel = document.getElementById('view-security')!
const count = document.getElementById('security-count')!
const showResolved = document.getElementById('security-show-resolved') as HTMLInputElement
const resolvedCount = document.getElementById('security-resolved-count')!
showResolved.checked = false
showResolved.addEventListener('change', () => {
  void refreshSecurity()
})
document.getElementById('security-toggle')!.addEventListener('click', () => {
  void refreshSecurity()
})
const text = (tag: string, value: string): HTMLElement => {
  const node = document.createElement(tag)
  node.textContent = value
  return node
}
const amount = (raw: number): string => {
  const n = BigInt(raw)
  return `${n / 1000000n}.${(n % 1000000n).toString().padStart(6, '0')} USDT`
}
const errorText = (e: unknown): string =>
  String(e instanceof Error ? e.message : e).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    ''
  )
let loading = false
async function refreshSecurity(): Promise<void> {
  if (loading || !window.security) return
  loading = true
  try {
    const snapshot = await window.security.snapshot()
    const unresolved = snapshot.findings.filter((f) => !f.resolvedAt)
    count.textContent = unresolved.length ? ` · ${unresolved.length}` : ''
    count.setAttribute('aria-label', `${unresolved.length} unresolved notices`)
    resolvedCount.textContent = `(${snapshot.findings.length - unresolved.length})`
    const content = panel.querySelector('.security-content')!
    content.replaceChildren()
    content.append(
      text(
        'p',
        snapshot.monitoring.error
          ? `Monitoring unavailable: ${snapshot.monitoring.error}`
          : snapshot.monitoring.lastSuccess
            ? `Monitor last refreshed: ${new Date(snapshot.monitoring.lastSuccess * 1000).toLocaleString()}`
            : 'Monitoring has not run yet.'
      )
    )
    content.append(text('h3', 'Security notices'))
    const findings = visibleSecurityFindings(snapshot.findings, showResolved.checked)
    if (!findings.length)
      content.append(
        text('p', showResolved.checked ? 'No security notices.' : 'No active security notices.')
      )
    for (const finding of findings) {
      const row = document.createElement('article')
      const notice = securityNotice(finding)
      row.append(
        text('strong', notice.title),
        text('p', notice.reason),
        text(
          'small',
          `Last checked: ${new Date(finding.lastSeen * 1000).toLocaleString()}${finding.resolvedAt ? ` · Resolved: ${new Date(finding.resolvedAt * 1000).toLocaleString()}` : ''}`
        )
      )
      if (notice.evidence.length) {
        const evidence = document.createElement('details')
        evidence.append(text('summary', 'Supporting evidence'))
        for (const line of notice.evidence) evidence.append(text('p', line))
        row.append(evidence)
      }
      content.append(row)
    }
    content.append(text('h3', 'Payment operations (latest 200)'))
    for (const operation of snapshot.operations) {
      const row = document.createElement('article')
      row.append(
        text('strong', `${amount(operation.amountRaw)} · ${operation.state}`),
        text(
          'p',
          `Network: ${operation.network} · RGB: ${operation.rgbStatus} · Confirmations: ${operation.confirmations}`
        ),
        text('p', `Recipient: ${operation.recipientId}`),
        text('p', `Transaction: ${operation.txid ?? 'not yet observed'}`)
      )
      if (operation.checkedAt)
        row.append(
          text(
            'small',
            `Last observation: ${new Date(operation.checkedAt * 1000).toLocaleString()}`
          )
        )
      const history = document.createElement('details')
      history.append(text('summary', 'Operation history'))
      for (const entry of operation.history)
        history.append(
          text(
            'p',
            `${new Date(entry.at * 1000).toLocaleString()} · ${entry.state}: ${entry.detail}`
          )
        )
      row.append(history)
      content.append(row)
    }
  } catch (error) {
    count.textContent = ' · unavailable'
    panel.querySelector('.security-content')!.textContent = errorText(error)
  } finally {
    loading = false
  }
}
let reviewing = false
export async function reviewPayment(intent: PaymentIntent): Promise<SecurityOperation | undefined> {
  if (reviewing) throw new Error('A payment review is already open.')
  reviewing = true
  let dialog: HTMLDialogElement | undefined
  try {
    const review = await window.security.review(intent)
    const o = review.operation
    dialog = document.createElement('dialog')
    dialog.className = 'security-dialog security-review'
    dialog.append(text('h2', o.proposalId ? 'Review refund' : 'Review payment'))
    dialog.append(
      text('strong', amount(o.amountRaw)),
      text('p', `Network: ${o.network}`),
      text('p', `Asset: ${o.assetId}`),
      text('p', `Recipient: ${o.recipientId}`),
      text('p', `Fee rate: ${o.feeRate} sat/vB. This is a rate limit, not a guaranteed total fee.`),
      text('p', `Approval expires: ${new Date(o.approvalExpiresAt * 1000).toLocaleTimeString()}`)
    )
    for (const warning of review.warnings) dialog.append(text('p', warning))
    const label = document.createElement('label')
    const verified = document.createElement('input')
    verified.type = 'checkbox'
    label.append(
      verified,
      document.createTextNode(
        ' I independently verified this refund destination with the customer.'
      )
    )
    if (o.proposalId) dialog.append(label)
    const status = text(
      'p',
      'Check these exact details. Payment status will be monitored after submission.'
    )
    const cancel = document.createElement('button')
    cancel.textContent = 'Cancel'
    const approve = document.createElement('button')
    approve.textContent = 'Approve and submit'
    approve.disabled = Boolean(o.proposalId)
    verified.onchange = () => {
      approve.disabled = !verified.checked
    }
    dialog.append(status, cancel, approve)
    document.body.append(dialog)
    dialog.showModal()
    return await new Promise<SecurityOperation | undefined>((resolve) => {
      let submitting = false
      cancel.onclick = () => dialog!.close()
      dialog!.addEventListener('cancel', (event) => {
        if (submitting) event.preventDefault()
      })
      dialog!.addEventListener('close', () => resolve(undefined), { once: true })
      approve.onclick = async () => {
        submitting = true
        approve.disabled = cancel.disabled = verified.disabled = true
        status.textContent = 'Revalidating and submitting. Do not send again.'
        try {
          const result = await window.security.execute(o.id, review.approvalToken, verified.checked)
          resolve(result)
          dialog!.close()
        } catch (error) {
          status.textContent = `${errorText(error)} Close this review and start a new one.`
          submitting = false
          cancel.disabled = false
        }
      }
    })
  } finally {
    dialog?.remove()
    reviewing = false
    void refreshSecurity()
  }
}
window.kasa?.onChanged(() => {
  void refreshSecurity()
})
void refreshSecurity()
