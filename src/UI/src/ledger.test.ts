import { describe, expect, it } from 'vitest'
import { searchLedger, taxRecordsCsv, taxLedgerSummary } from './ledger'
import type { KasaSnapshot } from '../../preload/index.d'
import type { LedgerSource } from '../../shared/ledger-source'

const snapshot: KasaSnapshot = {
  proposals: [],
  invoices: [
    {
      id: 'abc123-full',
      client: 'Acme Studio',
      amount: 12.345678,
      received: 2.000001,
      state: 'Underpaid',
      createdAt: 0,
      expiresAt: 86400,
      rgbInvoice: 'rgb:test',
      recipientId: 'recipient'
    }
  ],
  payments: [
    {
      nodeIdx: 7,
      direction: 'in',
      invoiceId: 'abc123-full',
      received: 2.000001,
      status: 'settled',
      txid: 'tx-real',
      blockTime: 100
    }
  ]
}
const source: LedgerSource = {
  id: 'saved-usdt',
  label: 'Saved USDT source',
  backend: 'wdk',
  asset: {
    symbol: 'USDT',
    canonicalId: 'asset:usdt',
    network: 'bitcoin',
    decimals: 6,
    environment: 'live'
  }
}
const bitcoin: LedgerSource = {
  ...source,
  id: 'saved-bitcoin',
  label: 'Saved Bitcoin source',
  asset: { ...source.asset, symbol: 'BTC', canonicalId: 'bitcoin', decimals: 8 }
}
function saved(savedSource: LedgerSource = source): KasaSnapshot {
  return {
    proposals: [],
    invoices: [
      {
        ...snapshot.invoices[0],
        source: savedSource,
        amountRaw: 12345678,
        receivedRaw: 2000001
      }
    ],
    payments: [{ ...snapshot.payments[0], source: savedSource, receivedRaw: 2000001 }]
  }
}
const metric = (
  amount: string | null,
  records: number,
  unavailable = 0
): { amount: string | null; records: number; unavailable: number } => ({
  amount,
  records,
  unavailable
})

// Parse the actual quoted export, including escaped quotes and embedded newlines.
function csvRecords(csv: string): Record<string, string>[] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < csv.length; index++) {
    const character = csv[index]
    if (character === '"') {
      if (quoted && csv[index + 1] === '"') {
        cell += '"'
        index++
      } else quoted = !quoted
    } else if (character === ',' && !quoted) {
      row.push(cell)
      cell = ''
    } else if (character === '\r' && csv[index + 1] === '\n' && !quoted) {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      index++
    } else cell += character
  }
  if (cell || row.length) rows.push([...row, cell])
  const [headers, ...records] = rows
  for (const record of records) expect(record).toHaveLength(headers.length)
  return records.map((record) =>
    Object.fromEntries(headers.map((header, index) => [header, record[index]]))
  )
}

describe('Commercialista ledger summary', () => {
  it('keeps invoice receipts and settled payment observations in separate totals', () => {
    const records = saved()
    const summary = taxLedgerSummary({
      ...records,
      payments: [...records.payments, { ...records.payments[0], nodeIdx: 8 }]
    })
    expect(summary).toMatchObject({
      invoiceCount: 1,
      underpaid: 1,
      overpaid: 0,
      unsettled: 0,
      unlinked: 0,
      undated: 0
    })
    expect(summary).not.toHaveProperty('requested')
    expect(summary).not.toHaveProperty('received')
    expect(summary.groups).toEqual([
      {
        source,
        conflict: false,
        invoiceCount: 1,
        paymentCount: 2,
        unsettled: 0,
        requested: metric('12.345678', 1),
        received: metric('2.000001', 1),
        incoming: metric('4.000002', 2),
        outgoing: metric(null, 0)
      }
    ])
  })
  it('keeps failed, pending, orphaned and undated observations visible but out of settled totals', () => {
    const records = saved()
    const summary = taxLedgerSummary({
      ...records,
      payments: [
        { ...records.payments[0], status: 'pending', invoiceId: null, blockTime: null },
        { ...records.payments[0], nodeIdx: 8, status: 'failed', invoiceId: 'missing' },
        { ...records.payments[0], nodeIdx: 9, status: 'unrecognised' }
      ]
    })
    expect(summary.unsettled).toBe(3)
    expect(summary.unlinked).toBe(2)
    expect(summary.undated).toBe(1)
    expect(summary.groups[0]).toMatchObject({
      paymentCount: 3,
      unsettled: 3,
      received: metric('2.000001', 1),
      incoming: metric(null, 0),
      outgoing: metric(null, 0)
    })
  })
  it('uses saved precision and raw values instead of current app-converted amounts', () => {
    const records = saved(bitcoin)
    records.invoices[0].amountRaw = 123456789
    records.invoices[0].receivedRaw = 100000001
    records.payments[0].receivedRaw = 1
    expect(taxLedgerSummary(records).groups[0]).toMatchObject({
      requested: metric('1.23456789', 1),
      received: metric('1.00000001', 1),
      incoming: metric('0.00000001', 1)
    })
  })
  it('sums raw amounts without floating point drift', () => {
    const records = saved()
    records.invoices = [100000, 200000].map((raw, index) => ({
      ...records.invoices[0],
      id: `invoice-${index}`,
      amount: 999,
      received: 999,
      amountRaw: raw,
      receivedRaw: raw,
      state: 'Overpaid'
    }))
    const summary = taxLedgerSummary(records)
    expect(summary.groups[0].requested).toEqual(metric('0.300000', 2))
    expect(summary.groups[0].received).toEqual(metric('0.300000', 2))
    expect(summary.overpaid).toBe(2)
  })
  it.each<[number, number, string]>([
    [0, 100, '100'],
    [8, 0, '0.00000000'],
    [18, 1, '0.000000000000000001']
  ])('preserves precision %s for raw amount %s', (decimals, raw, expected) => {
    const records = saved({ ...source, asset: { ...source.asset, decimals } })
    records.invoices[0].amountRaw = raw
    expect(taxLedgerSummary(records).groups[0].requested).toEqual(metric(String(expected), 1))
  })
  it('sums safe individual raw values exactly when their total exceeds Number.MAX_SAFE_INTEGER', () => {
    const records = saved({ ...source, asset: { ...source.asset, decimals: 0 } })
    records.invoices = [0, 1].map((index) => ({
      ...records.invoices[0],
      id: `large-${index}`,
      amountRaw: Number.MAX_SAFE_INTEGER
    }))
    expect(taxLedgerSummary(records).groups[0].requested).toEqual(metric('18014398509481982', 2))
  })
  it('separates sources and asset identity even when their ticker symbols match', () => {
    const sources: LedgerSource[] = [
      source,
      { ...source, id: 'another-source', label: source.label },
      { ...source, id: 'another-asset', asset: { ...source.asset, canonicalId: 'asset:other' } },
      { ...source, id: 'another-network', asset: { ...source.asset, network: 'ethereum' } },
      { ...source, id: 'test-source', asset: { ...source.asset, environment: 'test' } },
      { ...source, id: 'unknown-environment', asset: { ...source.asset, environment: 'unknown' } }
    ]
    const groups = taxLedgerSummary({
      proposals: [],
      invoices: sources.map((item, index) => ({
        ...saved(item).invoices[0],
        id: `invoice-${index}`
      })),
      payments: []
    }).groups
    expect(groups).toHaveLength(sources.length)
    expect(groups.map((group) => group.source?.id)).toEqual(sources.map((item) => item.id))
    expect(groups.every((group) => group.requested.amount === '12.345678')).toBe(true)
    expect(groups.map((group) => group.source?.asset.environment)).toEqual([
      'live',
      'live',
      'live',
      'live',
      'test',
      'unknown'
    ])
  })
  it('keeps renamed source labels in the same group', () => {
    const records = saved()
    records.payments[0].source = { ...source, label: 'New display label' }
    const groups = taxLedgerSummary(records).groups
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({
      conflict: false,
      invoiceCount: 1,
      paymentCount: 1,
      incoming: metric('2.000001', 1)
    })
  })
  it.each([
    { ...source, backend: 'kaleido' as const },
    { ...source, asset: { ...source.asset, decimals: 8 } },
    { ...source, asset: { ...source.asset, symbol: 'OTHER' } },
    { ...source, asset: { ...source.asset, canonicalId: 'other' } },
    { ...source, asset: { ...source.asset, network: 'other' } },
    { ...source, asset: { ...source.asset, environment: 'test' as const } }
  ])('withholds totals when a saved source ID has contradictory metadata: %j', (conflicting) => {
    const records = saved()
    records.payments[0].source = conflicting
    const groups = taxLedgerSummary(records).groups
    expect(groups).toHaveLength(2)
    expect(groups.every((group) => group.conflict)).toBe(true)
    expect(
      groups.every((group) => group.requested.amount === null && group.incoming.amount === null)
    ).toBe(true)
    expect(groups.reduce((sum, group) => sum + group.requested.unavailable, 0)).toBe(1)
    expect(groups.reduce((sum, group) => sum + group.incoming.unavailable, 0)).toBe(1)
  })
  it('does not infer legacy source identity from a linked invoice', () => {
    const records = saved()
    records.payments[0].source = undefined
    const groups = taxLedgerSummary(records).groups
    expect(groups).toHaveLength(2)
    expect(groups.find((group) => !group.source)).toMatchObject({
      conflict: false,
      invoiceCount: 0,
      paymentCount: 1,
      incoming: metric(null, 1, 1),
      requested: metric(null, 0)
    })
  })
  it('keeps legacy and malformed metadata records visible without inventing currency totals', () => {
    const records = saved({ ...source, asset: { ...source.asset, network: '' } })
    records.invoices.push({ ...snapshot.invoices[0], id: 'legacy' })
    expect(taxLedgerSummary(records).groups).toEqual([
      {
        source: undefined,
        conflict: false,
        invoiceCount: 2,
        paymentCount: 1,
        unsettled: 0,
        requested: metric(null, 2, 2),
        received: metric(null, 2, 2),
        incoming: metric(null, 1, 1),
        outgoing: metric(null, 0)
      }
    ])
  })
  it.each([undefined, NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    'withholds complete totals instead of silently omitting an unsafe raw amount: %s',
    (raw) => {
      const records = saved()
      records.invoices.push({
        ...records.invoices[0],
        id: 'unsafe',
        amountRaw: raw,
        receivedRaw: raw
      })
      records.payments.push({ ...records.payments[0], nodeIdx: 8, receivedRaw: raw })
      expect(taxLedgerSummary(records).groups[0]).toMatchObject({
        requested: metric(null, 2, 1),
        received: metric(null, 2, 1),
        incoming: metric(null, 2, 1)
      })
    }
  )
  it('keeps settled incoming and outgoing observations distinct, including payment-only sources', () => {
    const records = saved(bitcoin)
    records.invoices = []
    records.payments = [
      { ...records.payments[0], receivedRaw: 100000000, invoiceId: null },
      {
        ...records.payments[0],
        nodeIdx: 8,
        direction: 'out',
        receivedRaw: 25000000,
        invoiceId: null
      },
      {
        ...records.payments[0],
        nodeIdx: 9,
        direction: 'out',
        status: 'confirming',
        receivedRaw: 99999999,
        invoiceId: null
      }
    ]
    expect(taxLedgerSummary(records).groups[0]).toMatchObject({
      invoiceCount: 0,
      paymentCount: 3,
      unsettled: 1,
      requested: metric(null, 0),
      received: metric(null, 0),
      incoming: metric('1.00000000', 1),
      outgoing: metric('0.25000000', 1)
    })
  })
  it('returns an empty ledger without inventing an asset or zero tax estimate', () => {
    expect(taxLedgerSummary({ invoices: [], payments: [], proposals: [] })).toEqual({
      invoiceCount: 0,
      underpaid: 0,
      overpaid: 0,
      unsettled: 0,
      unlinked: 0,
      undated: 0,
      groups: []
    })
  })
  it('leaves every saved record and source unchanged', () => {
    const records = saved()
    const before = structuredClone(records)
    taxLedgerSummary(records)
    taxRecordsCsv(records)
    expect(records).toEqual(before)
  })
})

describe('recorded ledger search', () => {
  it.each(['acme studio', 'INV-ABC123', '12.345678', '1970-01-01', 'Underpaid'])(
    'finds invoice by %s',
    (query) => {
      expect(searchLedger(snapshot, query)).toContain('Invoice abc123-full')
    }
  )
  it('finds payments by transaction ID and includes their status', () => {
    expect(searchLedger(snapshot, 'tx-real settled')).toContain('Payment 7')
    expect(searchLedger(snapshot, 'tx-real')).toContain('2.000001 USDT')
  })
  it('requires every search term and handles blank and no-match queries', () => {
    expect(searchLedger(snapshot, 'acme missing')).toContain('No matching')
    expect(searchLedger(snapshot, '')).toContain('Enter a client')
    expect(searchLedger({ invoices: [], payments: [], proposals: [] }, 'acme')).toContain(
      'No matching'
    )
  })
  it('handles unlinked payments and missing dates', () => {
    const result = searchLedger(
      { ...snapshot, payments: [{ ...snapshot.payments[0], invoiceId: null, blockTime: null }] },
      'tx-real'
    )
    expect(result).toContain('Unlinked payment')
    expect(result).toContain('Date unavailable')
  })
})

describe('tax records CSV', () => {
  it('exports saved source metadata and generic amount columns without assuming USDT', () => {
    const csv = taxRecordsCsv(saved(bitcoin))
    expect(csv).not.toContain('Amount_USDT')
    expect(csv).not.toContain('Received_USDT')
    const invoice = csvRecords(csv).find((row) => row.Record_Type === 'Invoice')!
    expect(invoice).toMatchObject({
      Source_ID: 'saved-bitcoin',
      Source_Label: 'Saved Bitcoin source',
      Backend: 'wdk',
      Asset_ID: 'bitcoin',
      Network: 'bitcoin',
      Environment: 'live',
      Decimals: '8',
      Requested_Amount: '0.12345678',
      Invoice_Received_Amount: '0.02000001',
      Payment_Observed_Amount: '',
      Amount_Unit: 'BTC'
    })
    expect(invoice.Requested_Raw).toBe('12345678')
    expect(invoice.Invoice_Received_Raw).toBe('2000001')
    expect(csv).toContain('Tax liability is not calculated')
  })
  it('exports each source total separately without mixing assets or adding observations to invoices', () => {
    const usdt = saved()
    const btc = saved(bitcoin)
    btc.invoices[0].id = 'btc-invoice'
    btc.payments[0].nodeIdx = 8
    btc.payments[0].invoiceId = 'btc-invoice'
    const rows = csvRecords(
      taxRecordsCsv({
        proposals: [],
        invoices: [...usdt.invoices, ...btc.invoices],
        payments: [...usdt.payments, ...btc.payments]
      })
    )
    const invoiceTotals = rows.filter((row) => row.Record_Type === 'Invoice totals')
    expect(invoiceTotals).toHaveLength(2)
    expect(invoiceTotals.find((row) => row.Source_ID === source.id)).toMatchObject({
      Requested_Amount: '12.345678',
      Invoice_Received_Amount: '2.000001',
      Payment_Observed_Amount: '',
      Amount_Unit: 'USDT'
    })
    expect(invoiceTotals.find((row) => row.Source_ID === bitcoin.id)).toMatchObject({
      Requested_Amount: '0.12345678',
      Invoice_Received_Amount: '0.02000001',
      Payment_Observed_Amount: '',
      Amount_Unit: 'BTC'
    })
    const observedTotals = rows.filter((row) => row.Record_Type === 'Settled payment observations')
    expect(observedTotals).toHaveLength(2)
    expect(observedTotals.find((row) => row.Source_ID === source.id)).toMatchObject({
      Direction: 'in',
      Payment_Observed_Amount: '2.000001',
      Requested_Amount: '',
      Invoice_Received_Amount: ''
    })
    expect(observedTotals.find((row) => row.Source_ID === bitcoin.id)).toMatchObject({
      Direction: 'in',
      Payment_Observed_Amount: '0.02000001'
    })
  })
  it('preserves outgoing direction, unsettled statuses and raw observations in individual rows', () => {
    const records = saved(bitcoin)
    records.payments = ['settled', 'pending', 'failed'].map((status, index) => ({
      ...records.payments[0],
      nodeIdx: index,
      direction: 'out',
      invoiceId: null,
      status,
      blockTime: index ? null : 100,
      receivedRaw: 25000000
    }))
    const rows = csvRecords(taxRecordsCsv(records)).filter(
      (row) => row.Record_Type === 'Payment observation'
    )
    expect(rows).toHaveLength(3)
    expect(rows.map((row) => row.Status)).toEqual(['settled', 'pending', 'failed'])
    expect(rows.every((row) => row.Direction === 'out')).toBe(true)
    expect(rows.every((row) => row.Payment_Observed_Amount === '0.25000000')).toBe(true)
    expect(rows.every((row) => row.Payment_Observed_Raw === '25000000')).toBe(true)
    expect(rows.every((row) => row.Transaction_ID === 'tx-real')).toBe(true)
    expect(
      rows.every((row) => row.Invoice_Received_Amount === '' && row.Requested_Amount === '')
    ).toBe(true)
    expect(rows[1].Date_UTC).toBe('')
  })
  it('retains legacy rows with unknown units while withholding their totals', () => {
    const rows = csvRecords(taxRecordsCsv(snapshot))
    expect(rows.find((row) => row.Record_Type === 'Invoice')).toMatchObject({
      Requested_Amount: '12.345678',
      Invoice_Received_Amount: '2.000001',
      Amount_Unit: 'recorded app units',
      Source_ID: '',
      Asset_ID: ''
    })
    expect(rows.find((row) => row.Record_Type === 'Payment observation')).toMatchObject({
      Payment_Observed_Amount: '2.000001',
      Amount_Unit: 'recorded app units',
      Source_ID: ''
    })
    expect(rows.find((row) => row.Record_Type === 'Invoice totals')).toMatchObject({
      Requested_Amount: 'Unavailable',
      Invoice_Received_Amount: 'Unavailable'
    })
    expect(taxRecordsCsv(snapshot)).not.toContain('USDT')
  })
  it('does not fill unsafe known-source values with legacy converted amounts', () => {
    const records = saved(bitcoin)
    records.invoices[0].amountRaw = undefined
    records.invoices[0].receivedRaw = -1
    records.payments[0].receivedRaw = Number.MAX_SAFE_INTEGER + 1
    const rows = csvRecords(taxRecordsCsv(records))
    const invoice = rows.find((row) => row.Record_Type === 'Invoice')!
    const payment = rows.find((row) => row.Record_Type === 'Payment observation')!
    expect(invoice.Amount_Unit).toBe('BTC')
    expect(invoice.Requested_Amount).toBe('Unavailable')
    expect(invoice.Invoice_Received_Amount).toBe('Unavailable')
    expect(payment.Payment_Observed_Amount).toBe('Unavailable')
    expect(invoice.Invoice_Received_Raw).toBe("'-1")
    expect(payment.Payment_Observed_Raw).toBe(String(Number.MAX_SAFE_INTEGER + 1))
    expect(`${invoice.Notes} ${payment.Notes}`).toMatch(/unavailable|unsafe|missing/i)
  })
  it('retains conflicting source records without an authoritative combined total', () => {
    const records = saved()
    records.payments[0].source = { ...source, asset: { ...source.asset, decimals: 8 } }
    const rows = csvRecords(taxRecordsCsv(records))
    expect(
      rows.filter((row) => ['Invoice', 'Payment observation'].includes(row.Record_Type))
    ).toHaveLength(2)
    expect(rows.find((row) => row.Record_Type === 'Invoice totals')).toMatchObject({
      Requested_Amount: 'Unavailable',
      Invoice_Received_Amount: 'Unavailable'
    })
    expect(rows.find((row) => row.Record_Type === 'Invoice')).toMatchObject({
      Requested_Amount: 'Unavailable',
      Requested_Raw: '12345678'
    })
    expect(rows.find((row) => row.Record_Type === 'Payment observation')).toMatchObject({
      Payment_Observed_Amount: 'Unavailable',
      Payment_Observed_Raw: '2000001'
    })
    expect(rows.some((row) => /conflict/i.test(row.Notes))).toBe(true)
  })
  it('keeps test activity visibly distinct in metadata and totals', () => {
    const testSource: LedgerSource = {
      ...source,
      id: 'test-source',
      asset: { ...source.asset, environment: 'test', network: 'testnet' }
    }
    const rows = csvRecords(taxRecordsCsv(saved(testSource)))
    for (const row of rows.filter((row) => row.Source_ID === 'test-source')) {
      expect(row.Environment).toBe('test')
      expect(row.Network).toBe('testnet')
    }
    expect(rows.find((row) => row.Record_Type === 'Invoice')?.Environment).toBe('test')
  })
  it('exports empty records without inventing currency totals or claiming zero taxes', () => {
    const csv = taxRecordsCsv({ invoices: [], payments: [], proposals: [] })
    const rows = csvRecords(csv)
    expect(rows.some((row) => row.Record_Type === 'Invoice totals')).toBe(false)
    expect(rows.some((row) => row.Record_Type === 'Settled payment observations')).toBe(false)
    expect(csv).toContain('Tax liability is not calculated')
    expect(csv).not.toContain('USDT')
  })
  it('escapes client names and every free-text source field against spreadsheet formulas', () => {
    const malicious: LedgerSource = {
      ...source,
      id: '=source',
      label: '+SUM(1),"x"\nline',
      asset: { ...source.asset, symbol: '@symbol', canonicalId: '-asset', network: '=network' }
    }
    const records = saved(malicious)
    records.invoices[0].client = '=SUM(1),"x"\nline'
    const csv = taxRecordsCsv(records)
    expect(csv).toContain('"\'=SUM(1),""x""\nline"')
    const invoice = csvRecords(csv).find((row) => row.Record_Type === 'Invoice')!
    expect(invoice).toMatchObject({
      Client: '\'=SUM(1),"x"\nline',
      Source_ID: "'=source",
      Source_Label: '\'+SUM(1),"x"\nline',
      Amount_Unit: "'@symbol",
      Asset_ID: "'-asset",
      Network: "'=network"
    })
  })
})
