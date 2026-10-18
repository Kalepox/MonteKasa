// This version is deliberately limited to the listed tax years. A future year
// needs a separately reviewed rule version, rather than inheriting the last rate.
// The agency's circular PDF returned HTTP 403 during review; its original text
// was checked in a published PDF copy. The reference below remains the agency URL.
export const personalBtcRules = {
  id: 'it-personal-btc-disposals-2025-2026-v1',
  reviewedAt: '2026-10-18',
  rates: { 2025: 26, 2026: 33 },
  method:
    'Add the selected year’s supported BTC disposal proceeds and subtract their documented, externally allocated LIFO acquisition costs. Apply the year’s rate to the positive net gain. Decimal inputs stay exact; tax is rounded once, after netting, to the nearest cent (half up). This preview does not apply tax-return whole-euro rounding, reconstruct acquisition lots or verify their allocation.',
  limitations: [
    'For Italian personal users in the dichiarativo regime, using supported BTC disposals in 2025 or 2026 only. Business activity, other regimes and other assets need a separate calculation.',
    'The €2,000 exemption does not apply from 2025. The rate is 26% for 2025 and 33% for BTC in 2026; no rate is assumed for later years.',
    'Acquisition and disposal fees are not deducted. Crypto spent on fees requires its own quantity and tax-treatment review; excluding costs does not establish that those payments are tax-free.',
    'A missing or unverified acquisition cost blocks this estimate. The statutory zero-cost rule for undocumented basis is not applied automatically to incomplete app records.',
    'LIFO allocation must account for the taxpayer’s relevant BTC acquisition and disposal history, including activity outside this app. A saved reference alone does not establish the numerical basis.',
    'Recheck every supplied allocation when acquisition or disposal history changes. A saved review is bound to its disposal record, not automatically invalidated by changes to other records or external history.',
    'The result is before earlier-year losses, withholding, credits and tax already paid. It is an estimate for the included saved records, not the taxpayer’s whole annual liability or an amount ready to pay.',
    'A same-year net loss produces no tax in this calculation; it is not a refund. The app does not establish or carry forward a tax loss automatically.',
    'Swaps, gifts, inheritance, revalued basis and other unsupported transactions need separate review. Holding tax, reporting obligations and other taxes remain outside this estimate.'
  ],
  sources: [
    {
      title: 'Law 207/2024, article 1, paragraphs 23–29',
      url: 'https://www.normattiva.it/atto/caricaDettaglioAtto?atto.codiceRedazionale=24G00229&atto.dataPubblicazioneGazzetta=2024-12-31&bloccoAggiornamentoBreadCrumb=true&classica=true&generaTabId=true&tipoDettaglio=vigente&title=lbl.dettaglioAtto',
      detail:
        'Current text checked on 18 October 2026: 26% in 2025, the general 33% crypto rate from 2026, removal of the €2,000 threshold from 2025 and special revaluation rules. The 2026 exception for qualifying euro-denominated e-money tokens does not cover BTC.'
    },
    {
      title: 'TUIR, article 68, paragraph 9-bis',
      url: 'https://def.finanze.it/DocTribFrontend/getAttoNormativoDetail.do?ACTION=getArticolo&articolo=Articolo+68&codiceOrdinamento=0000000000000680000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000&id=%7B31D694E8-4398-4030-873B-FEAF5A6647F9%7D',
      detail:
        'Rules applicable to the supported years: proceeds less acquisition basis, netting relevant gains and losses, documentary evidence for basis and conditional loss carryforward for no more than four subsequent tax years.'
    },
    {
      title: 'Agenzia delle Entrate, Circular 30/E of 27 October 2023',
      url: 'https://www.agenziaentrate.gov.it/portale/documents/20143/5589638/Circolare+criptoattivita+del+27+ottobre+2023.pdf',
      detail:
        'Printed page 50 excludes acquisition and disposal costs; pages 54–55 describe LIFO for assets of the same denomination in the dichiarativo regime and separate crypto losses from ordinary financial gains. Later legislation replaces the circular’s historical rate and threshold where applicable.'
    }
  ]
} as const
