import re

with open("src/index.html", "r", encoding="utf-8") as f:
    text = f.read()

translations = [
    # UI Strings
    ("📄 Modello F24 Resmi Makbuzunu Görüntüle / İndir", "📄 View / Download Official Modello F24 Receipt"),
    ("<span>HIZLI SEÇİM:</span>", "<span>QUICK PRESETS:</span>"),
    ("Mühür Hash (SHA-256):", "Seal Hash (SHA-256):"),
    ("Kraken Avantajı: +%0.08", "Kraken Advantage: +0.08%"),

    # Toasts
    ("toast('rcv-cp', '✓', 'Adres Kopyalandı', text.slice(0, 24) + '...', 'green')", "toast('rcv-cp', '✓', 'Address Copied', text.slice(0, 24) + '...', 'green')"),
    ("'Yeni Mühür Üretildi: UTXO #'", "'Fresh Seal Generated: UTXO #'"),
    ("toast('new-seal', '🔄', 'Yeni Kör Mühür Üretildi', 'İstemci tarafı doğrulama için taze UTXO mühürlendi.', 'green')", "toast('new-seal', '🔄', 'Fresh Seal Generated', 'Fresh UTXO sealed for client-side cryptographic verification.', 'green')"),
    ("toast('af', '📋', 'Adres Dolduruldu', 'Panodaki doğrulanmış RGB fatura adresi eklendi.', 'blue')", "toast('af', '📋', 'Address Filled', 'Verified RGB invoice address filled from clipboard.', 'blue')"),
    ("'Tahmini Ücret: ' + (sats * 14) + ' sats (' + fiat + ')'", "'Estimated Fee: ' + (sats * 14) + ' sats (' + fiat + ')'"),
    ("toast('pdf-dl', '↓', 'PDF İndirildi', filename + ' masaüstünüze kaydedildi.', 'green')", "toast('pdf-dl', '↓', 'PDF Downloaded', filename + ' saved to your local device.', 'green')"),
    ("toast('rgb-dl', '⛓️', 'Konsinye Dosyası İndirildi', filename + ' (RGB20 State Bundle) dışa aktarıldı.', 'green')", "toast('rgb-dl', '⛓️', 'Consignment Exported', filename + ' (RGB20 State Bundle) exported successfully.', 'green')"),
    ("toast('f24-dl', '✓', 'F24 Makbuzu İndirildi', filename + ' resmi vergi arşivinize eklendi.', 'green')", "toast('f24-dl', '✓', 'F24 Receipt Downloaded', filename + ' added to your official tax archive.', 'green')"),

    # Command palette
    ('Eşleşen komut bulunamadı', 'No matching commands or invoices found'),

    # QVAC Lens Interactive Answers
    ("🧠 Mistral-7B yerel olarak yanıtlıyor...", "🧠 Mistral-7B responding locally..."),
    ("💡 <strong>Tahsilat Stratejisi:</strong> ' + currentTitle + ' için RGB20 akıllı sözleşme bildirimi üzerinden tek tıkla ödeme bağlantısı oluşturuldu. Karşı tarafa Nostr DM veya şifreli e-posta hatırlatması göndermek ödeme süresini ortalama %40 hızlandırmaktadır.", "💡 <strong>Settlement Strategy:</strong> One-click RGB20 smart contract invoice ready for ' + currentTitle + '. Sending an automated Nostr or encrypted email reminder expedites settlement by an average of 40%."),
    ("🏛️ <strong>Vergi & KDV Optimizasyonu:</strong> Bu kalem Agenzia delle Entrate reverse-charge rejimine dahildir. Yıl sonuna kadar ek donanım veya yazılım giderleri gösterilerek KDV mahsubu yapılabilir.", "🏛️ <strong>Fiscal & VAT Optimization:</strong> Item falls under EU Directive reverse-charge treatment. Legitimate deductible business expenses can be offset against liability prior to period close."),
    ("🛡️ <strong>Güvenilirlik & Kripto Mühür:</strong> Bu öğenin kriptografik bütünlüğü yerel hash kontrolünden başarıyla geçti. Karşı tarafın geçmiş ödeme güvenilirlik skoru %98.4 olup temerrüt riski minimumdur.", "🛡️ <strong>Cryptographic Integrity:</strong> Anchored single-use seal verified locally. Counterparty historical trust rating is 98.4% with near-zero default risk."),
    ("🔍 <strong>Özet Anlamı:</strong> ' + currentTitle + ' (' + currentVal + '), şirketinizin ' + currentTitle + ' akışındaki doğrulanmış defter kaydını temsil eder. Veriler yerel SQLite üzerinde şifrelidir.", "🔍 <strong>Ledger Context:</strong> ' + currentTitle + ' (' + currentVal + ') represents an encrypted double-entry ledger record. State is validated locally without third-party exposure."),
    ("⚡ <strong>QVAC Analizi:</strong> \"' + q + '\" sorunuz ' + currentTitle + ' bağlamında analiz edildi. İşlem tek kullanımlık mühür ile güvencede, bakiye uyumluluğu tam ve herhangi bir operasyonel engel bulunmuyor.", "⚡ <strong>QVAC Insight:</strong> Analysis for \"' + q + '\" in context of ' + currentTitle + ': Single-use seal anchored, double-entry balanced, and zero operational discrepancies detected."),

    # QVAC Context definitions
    ("let path = 'DASHBOARD › SİSTEM';", "let path = 'DASHBOARD › SYSTEM';"),
    ("let title = 'Bileşen';", "let title = 'Component';"),
    ("let val = 'Aktif';", "let val = 'Active';"),
    ("let where = 'Uygulama arayüz bileşeni.';", "let where = 'Application UI surface component.';"),
    ("let why = 'Yerel SQLite şifreli durumundan beslenmektedir.';", "let why = 'Anchored to local encrypted SQLite state.';"),
    ("let action = 'Bileşen doğrulanmış ve operasyonel.';", "let action = 'Component verified and fully operational.';"),

    ("path = 'FATURALAR › INV-0010 (GECİKMEDE)';", "path = 'INVOICES › INV-0010 (OVERDUE)';"),
    ("where = 'Faturalar listesi ve Dashboard son işlemler tablosundaki 2 Ekim vadeli alacak satırı.';", "where = 'Invoice ledger row due Oct 2 in accounts receivable.';"),
    ("why = '1400 Broadway, NY adresli müşteriye verilen 800 USDT tutarındaki yazılım/tasarım hizmeti faturasıdır. Vade 2 Ekim idi; 3 gün gecikmede olduğu için risk modülü tarafından işaretlendi.';", "why = 'B2B design & software contract for 800 USDT with client at 1400 Broadway, NY. Flagged by risk engine for being overdue.';"),
    ("action = 'Müşterinin geçmiş ödeme güvenilirlik skoru %98.4 (yüksek). QVAC, şifreli Nostr/E-posta protokolüyle otomatik ödeme hatırlatıcısı iletilmesini tavsiye eder.';", "action = 'Client credit rating is 98.4% (Tier 1). QVAC recommends dispatching an automated cryptographic reminder via Nostr/Email.';"),

    ("path = 'FATURALAR › INV-0009 (KESİNLEŞTİ)';", "path = 'INVOICES › INV-0009 (SETTLED)';"),
    ("where = 'Faturalar listesindeki 28 Eylül tarihli tahsil edilmiş resmi fatura kaydı.';", "where = 'Settled official invoice record dated Sep 28 in ledger.';"),
    ("why = 'Londra merkezli Arco Holdings\\'e verilen danışmanlık hizmeti karşılığıdır. 28 Eylül saat 14:37 UTC\\'de RGB20 konsinye transferiyle Bitcoin #834,112 bloğunda tek kullanımlık mühürle onaylandı.';", "why = 'Consulting engagement for London-based Arco Holdings. Confirmed on Bitcoin block #834,112 via RGB20 single-use seal.';"),
    ("action = 'AB Direktifi 2006/112/EC Madde 44 uyarınca KDV ters ibraz ile alıcıya intikal etti. Tüm defter kayıtları mutabakatlı ve yasal denetime hazır.';", "action = 'EU Directive 2006/112/EC Art. 44 reverse-charge applied. Ledger state audited and audit-ready.';"),

    ("path = 'FATURALAR › INV-0008 (FAZLALIK ANOMALİSİ)';", "path = 'INVOICES › INV-0008 (OVERPAYMENT)';"),
    ("where = 'Faturalar tablosundaki \\'Overpaid\\' etiketli 30 Eylül vadeli mutabakat satırı.';", "where = 'Reconciliation line labeled \\'Overpaid\\' in invoices ledger.';"),
    ("why = 'Fatura tutarı 500 USDT idi, ancak karşı taraf sehven 620 USDT yatırdı (+120 USDT fazlalık bakiye). Sistem bakiye uyuşmazlığı tespit etti.';", "why = 'Invoice total was 500 USDT; counterparty transferred 620 USDT (+120 USDT surplus). System detected discrepancy.';"),
    ("action = 'Fazlalık 120 USDT bloke altında. Karşı tarafa zincir dışı RGB20 iade işlemi yapılması veya gelecek faturaya mahsup edilmesi defter temizliği için önerilir.';", "action = 'Surplus 120 USDT segregated. Off-chain RGB20 refund or credit rollover recommended for ledger balance.';"),

    ("path = 'GÜVENLİK › INV-0007 (KRİPTO KARANTİNA)';", "path = 'SECURITY › INV-0007 (QUARANTINED)';"),
    ("val = '350.00 USDT (Bloke)';", "val = '350.00 USDT (Blocked)';"),
    ("where = 'Dashboard Acil Eylemler ve Sahtecilik Tespit ekranındaki kırmızı bayraklı işlem.';", "where = 'Red-flagged item in Fraud Detection and Dashboard Action queue.';"),
    ("why = 'İstemci tarafındaki PDF dosyasının SHA-256 hash değeri ile Bitcoin UTXO\\'suna mühürlenen sözleşme hash\\'i eşleşmedi. Şema bütünlüğü bozulmuş veya tahrif edilmiş.';", "why = 'Client-side PDF SHA-256 hash does not match contract hash anchored on Bitcoin UTXO. Tampering detected.';"),
    ("action = 'İşlem karantinaya alındı, fon transferi durduruldu. Sıfır finansal kayıp yaşandı. Müşteriyle iletişime geçilerek orijinal sözleşmenin tekrar imzalanması gerekir.';", "action = 'Transaction quarantined, funds protected. Zero loss incurred. Re-signing requested from client.';"),

    ("path = 'DASHBOARD › KÜMÜLATİF HACİM';", "path = 'DASHBOARD › CUMULATIVE VOLUME';"),
    ("title = 'Toplam Kesilen Faturalar';", "title = 'Total Gross Invoiced';"),
    ("where = 'Dashboard üst metrik kartı; tüm faturaların brüt toplamını gösterir.';", "where = 'Top dashboard metric card displaying gross invoiced volume.';"),
    ("why = 'Bu çeyrekte kesilen 5 faturanın toplam tutarıdır (Tahsil edilen 4,850 USDT + bekleyen 1,300 USDT + itirazlı 700 USDT).';", "why = 'Gross total across active quarter (4,850 USDT settled + 1,300 USDT pending + 700 USDT disputed).';"),
    ("action = 'Faturaların zamanında ödenme oranı %84 seviyesinde. Ortalama tahsilat süresi 3.2 gün olup sektör ortalamasından %22 daha hızlıdır.';", "action = 'On-time payment rate is 84%. Average settlement latency is 3.2 days, 22% faster than industry benchmark.';"),

    ("path = 'DASHBOARD › LİKİDİTE HAZİNESİ';", "path = 'DASHBOARD › LIQUIDITY TREASURY';"),
    ("title = 'Toplam Tahsil Edilen Kasa';", "title = 'Total Settled Treasury';"),
    ("where = 'Dashboard ana likidite kartı; harcanabilir doğrulanmış sermayeyi temsil eder.';", "where = 'Core liquidity card representing cleared, spendable balance.';"),
    ("why = 'Son 30 günde Arco Holdings (1,200 USDT) ve önceki 3 faturanın RGB20 transferleriyle akıllı sözleşme cüzdanına net girişiyle birikmiştir. Karşı taraf iflas riski %0\\'dır.';", "why = 'Accumulated via settled RGB20 transfers from Arco Holdings (1,200 USDT) and prior invoices into WDK wallet.';"),
    ("action = 'EUR/USDT kur sapması %0.12 ile güvenli bantta. Şirketin mevcut operasyonel giderlerine göre 4.8 aylık net nakit pisti sağlamaktadır.';", "action = 'EUR/USDT FX spread is within 0.12% safe band. Provides 4.8 months of operational expense runway.';"),

    ("path = 'DASHBOARD › BEKLEYEN ALACAKLAR';", "path = 'DASHBOARD › PENDING RECEIVABLES';"),
    ("title = 'Tahsilat Bekleyen Faturalar';", "title = 'Awaiting Settlement';"),
    ("where = 'Dashboard vadesi yaklaşan veya henüz ödenmemiş fatura göstergesi.';", "where = 'Dashboard indicator for upcoming and unsettled invoices.';"),
    ("why = 'Meridian Creative (800 USDT) ve Vertex Global (500 USDT) faturalarının toplam bekleyen alacak bakiyesidir.';", "why = 'Outstanding accounts receivable balance from Meridian Creative (800 USDT) and Vertex Global (500 USDT).';"),
    ("action = 'Banka iş günü takvimleri ve RGB mempool durumuna göre önümüzdeki 72 saat içinde %100 nakit gerçekleşme olasılığı tahmin edilmektedir.';", "action = 'Based on bank calendars and RGB mempool state, 100% settlement probability predicted within 72h.';"),

    ("path = 'DASHBOARD › DEFTER MUTABAKATI';", "path = 'DASHBOARD › RECONCILIATION';"),
    ("title = 'Fatura & Hesap Uyuşmazlığı';", "title = 'Invoice Discrepancy Index';"),
    ("val = '91 / 100 Sağlık';", "val = '91 / 100 Health';"),
    ("where = 'Defter mutabakat ve anomali uyarı göstergesi.';", "where = 'Ledger reconciliation and anomaly status indicator.';"),
    ("why = '1 adet vadesi geçmiş fatura (INV-0010) ve 1 adet fazla ödenen fatura (INV-0008, +120 USDT) sebebiyle bakiye uyarısı verilmektedir.';", "why = 'Balance flag triggered due to 1 overdue invoice (INV-0010) and 1 overpaid invoice (INV-0008, +120 USDT).';"),
    ("action = 'Dönem kapanışından önce Vertex Global\\'e 120 USDT iade emri verilmesi ve Meridian için hatırlatıcı gönderilmesi defter bütünlüğünü 100/100 yapar.';", "action = 'Issuing a 120 USDT refund to Vertex Global and sending a reminder to Meridian restores ledger health to 100/100.';"),

    ("path = 'DASHBOARD › İŞLEM AKIŞI';", "path = 'DASHBOARD › ACTIVITY FEED';"),
    ("title = 'Son Fatura Defteri';", "title = 'Recent Ledger Stream';"),
    ("val = 'Canlı Akış';", "val = 'Live Stream';"),
    ("where = 'Dashboard altındaki en son işlem gören faturaların kronolojik tablosu.';", "where = 'Chronological log of recent invoice settlements on Dashboard.';"),
    ("why = 'Son 30 gündeki ticari hareketlerin kriptografik mühürleriyle birlikte gerçek zamanlı listelenmesidir.';", "why = 'Real-time record of commercial operations alongside cryptographic single-use seals.';"),
    ("action = 'Tablodaki tüm satırlar yerel QVAC motoru tarafından şema ve hash kontrolünden geçirilmiştir; hiçbir sahte veri bulunmamaktadır.';", "action = 'All table rows verified locally by QVAC engine; zero synthetic or unverified entries present.';"),

    ("path = 'DASHBOARD › ACİL EYLEMLER';", "path = 'DASHBOARD › ACTION ITEMS';"),
    ("title = 'Kritik Risk ve Hata Havuzu';", "title = 'Critical Risk Queue';"),
    ("val = '1 Karantina Uyarısı';", "val = '1 Quarantine Alert';"),
    ("where = 'Kullanıcının anında müdahale etmesi gereken işlemleri gösteren uyarı bloğu.';", "where = 'Action center requiring supervisory confirmation or override.';"),
    ("why = 'INV-0007 nolu faturada tespit edilen PDF tahrifatı sebebiyle otomatik güvenlik kalkanı tetiklenmiştir.';", "why = 'Security shield triggered by cryptographic hash mismatch on invoice INV-0007.';"),
    ("action = 'Hatalı fatura karantinada olduğu sürece fon kaybı riski sıfırdır; manuel inceleme ile işlem sonlandırılabilir.';", "action = 'Zero loss risk while invoice remains quarantined. Can be dismissed or re-authenticated after audit.';"),

    ("path = 'VERGİ & KDV › 3. ÇEYREK TAHAKKUKU';", "path = 'TAX & VAT › Q3 ACCRUAL';"),
    ("title = 'Net Ödenecek KDV';", "title = 'Net Payable VAT';"),
    ("where = 'Vergi ve KDV Tahmin modülünde hesaplanan çeyreklik resmi vergi yükümlülüğü.';", "where = 'Quarterly statutory tax liability calculated in Tax & VAT Estimator.';"),
    ("why = 'İtalyan Vergi Dairesi (Agenzia delle Entrate) kurallarına göre 3. Çeyrekte yurtiçi faturalardan tahakkuk eden €2,250 brüt KDV\\'den, €420 indirilebilir meşru işletme gideri düşülerek hesaplandı.';", "why = 'Calculated per Agenzia delle Entrate rules: €2,250 gross VAT minus €420 deductible business expenses.';"),
    ("action = 'Son ödeme tarihi 16 Kasım 2026. Modello F24 üzerinden otomatik banka havalesiyle ödenmeye hazır durumda.';", "action = 'Due Nov 16, 2026. Pre-filled for SEPA settlement via Modello F24 protocol.';"),

    ("path = 'VERGİ ÖDEMESİ › MODELLO F24';", "path = 'TAX SETTLEMENT › MODELLO F24';"),
    ("title = 'Resmi Vergi Ödeme Emri';", "title = 'Official F24 Settlement Order';"),
    ("where = 'İtalyan Hazine Sistemi ile entegre resmi vergi ödeme formu.';", "where = 'Official electronic tax payment receipt integrated with treasury gateway.';"),
    ("why = 'Üçüncü çeyrek KDV tasfiyesi için Agenzia delle Entrate resmi \\'6033\\' vergi koduyla oluşturulan toplu ödeme fişidir.';", "why = 'Batch payment voucher created under tax code 6033 for Q3 VAT settlement.';"),
    ("action = 'Studio Mancini\\'nin kayıtlı SEPA IBAN hesabı üzerinden tek tıkla dijital imzalanıp hazineye iletilebilir.';", "action = 'Digitally signed and transmitted via Studio Mancini registered SEPA IBAN account.';"),

    ("path = 'VERGİ MEVZUATI › TERS İBRAZ';", "path = 'TAX REGULATION › REVERSE CHARGE';"),
    ("title = 'AB Sınır Ötesi KDV Muafiyeti';", "title = 'Cross-Border B2B Exemption';"),
    ("where = 'Yurtdışı B2B faturalarına uygulanan KDV muafiyet rejimi.';", "where = 'Statutory VAT treatment applied to cross-border B2B digital services.';"),
    ("why = 'Avrupa Birliği 2006/112/EC Direktifi Madde 44 uyarınca, AB ve ABD merkezli kurumsal müşterilere kesilen dijital hizmetlerde KDV sorumluluğu alıcıya aittir.';", "why = 'Under EU Directive 2006/112/EC Art. 44, VAT liability shifts to corporate client in recipient jurisdiction.';"),
    ("action = 'Fatura PDF\\'lerine \\'VAT Reverse-Charged\\' ibaresi ve alıcının geçerli VIES vergi numarası otomatik işlenmiştir.';", "action = 'Invoice PDFs automatically annotated with reverse-charge disclosure and validated VIES tax number.';"),

    ("path = 'CÜZDAN › TETHER WDK ÇEKİRDEĞİ';", "path = 'WALLET › TETHER WDK ENGINE';"),
    ("title = 'Self-Custodial Bitcoin/RGB Düğümü';", "title = 'Self-Custodial Bitcoin/RGB Node';"),
    ("val = '#834,192 Bloğuna Eşit';", "val = 'Synced to Block #834,192';"),
    ("where = 'Sol menü ve cüzdan sayfasında yerel anahtar ve düğüm senkronizasyon durumu.';", "where = 'Local key and node synchronization state in wallet surface.';"),
    ("why = 'Cüzdan özel anahtarları yerel cihazın donanım korumalı alanında (Secure Enclave) BIP39 standardıyla tutulur. Asla sunucuya gönderilmez.';", "why = 'Private keys stored in Secure Enclave under BIP39 standard. Never exposed to remote servers.';"),
    ("action = 'Düğüm gecikmesi 12ms. Tüm bakiyeler ve konsinyeler merkeziyetsiz olarak cihaz üzerinde doğrulanmaktadır.';", "action = 'Node latency is 12ms. All asset states and consignments validated client-side.';"),

    ("path = 'PİYASA › EN İYİ İCRA ROTASI';", "path = 'MARKETS › BEST EXECUTION ROUTE';"),
    ("title = 'Kraken vs Coinbase Arbitrajı';", "title = 'Kraken vs Coinbase Arbitrage';"),
    ("val = '%0.08 Komisyon Avantajı';", "val = '0.08% Fee Advantage';"),
    ("where = 'Bitcoin Ticareti ve Kripto/Fiat çıkış modülündeki emir defteri karşılaştırması.';", "where = 'Order book comparison in Bitcoin Trading and Treasury gateway.';"),
    ("why = 'Kraken EUR/BTC tahtasındaki alış-satış makası 1.2€ iken Coinbase\\'de 4.8€ seviyesindedir. Kraken daha derin emir defteri sunmaktadır.';", "why = 'Kraken EUR/BTC bid-ask spread is €1.20 vs €4.80 on Coinbase Prime, providing deeper liquidity.';"),
    ("action = 'Dönüşüm işlemlerinin Kraken API anahtarı üzerinden icra edilmesi her 1,000 EUR işlemde ~0.80 EUR tasarruf sağlar.';", "action = 'Executing conversions through Kraken API yields ~€0.80 savings per €1,000 volume.';"),

    ("path = 'RİSK KONTROL › PORTFÖY DAĞILIMI';", "path = 'RISK MANAGEMENT › EXPOSURE';"),
    ("title = 'Müşteri Yoğunlaşma Riski';", "title = 'Client Concentration Risk';"),
    ("val = '%35 Meridian Payı';", "val = '35% Meridian Share';"),
    ("where = 'Risk Yönetimi ekranındaki alacak yoğunluğu göstergesi.';", "where = 'Receivables concentration metric in Risk Management view.';"),
    ("why = 'Toplam 1,300 USDT alacağın 800 USDT\\'si tek bir firmaya (Meridian) ait olduğu için portföy bağımlılığı orta-yüksek seviyededir.';", "why = '800 USDT out of 1,300 USDT total receivables is concentrated with Meridian Creative.';"),
    ("action = 'Gelecek sözleşmelerde %30 peşinat şartı getirilerek tekil müşteri temerrüt riski azaltılabilir.';", "action = 'A 30% advance deposit term on future contracts mitigates single-counterparty default risk.';"),

    ("path = 'GÜVENLİK › SAHTECİLİK VE YAPTIRIM';", "path = 'SECURITY › FRAUD SHIELD';"),
    ("title = 'Sıfır-Bilgi Güvenlik Kalkanı';", "title = 'Zero-Knowledge Security Shield';"),
    ("val = '%100 Temiz Filtre';", "val = '100% Clean Pass';"),
    ("where = 'Sahtecilik Tespiti ekranındaki OFAC ve AB yaptırım tarama motoru.';", "where = 'OFAC and EU sanctions screening engine in Fraud Detection view.';"),
    ("why = 'Tüm fatura karşı tarafları yerel veritabanındaki OFAC ve EU AML yaptırım listeleriyle yerel cihazda karşılaştırılır.';", "why = 'Counterparty credentials screened client-side against local OFAC and EU AML databases.';"),
    ("action = 'Şüpheli işlem tespit edilmedi. Sistem her yeni fatura oluşturulduğunda yerel taramayı otomatik yineler.';", "action = 'Zero suspicious entities flagged. Automatic scan re-runs on every generated invoice.';"),

    ("path = 'MÜŞTERİ ANALİTİĞİ › PUANLAMA';", "path = 'CLIENT ANALYTICS › TRUST SCORE';"),
    ("title = 'Müşteri Kredi & Güvenilirlik Skoru';", "title = 'Client Reliability Score';"),
    ("val = '94 / 100 İtibar';", "val = '94 / 100 Rating';"),
    ("where = 'Müşteri Analitiği ekranındaki karşı taraf performans paneli.';", "where = 'Counterparty performance dashboard in Client Analytics.';"),
    ("why = 'Müşterilerin geçmiş fatura ödeme hızları, ortalama vadesinden önce ödeme sıklığı ve işlem hacimleriyle hesaplanmaktadır.';", "why = 'Derived from historical payment velocity, early settlement frequency, and transaction history.';"),
    ("action = 'Ortalama ödeme süresi 3.2 gün ile mükemmel seviyede. Yüksek puanlı müşterilere erken ödeme iskontosu sunulabilir.';", "action = 'Average payment latency is 3.2 days (Excellent). Early settlement discount recommended.';"),

    ("path = 'UYUMLULUK › MEVZUAT DENETİMİ';", "path = 'COMPLIANCE › REGULATORY AUDIT';"),
    ("title = 'VIES ve MiCA Regülasyon Uyumu';", "title = 'VIES & MiCA Regulatory Audit';"),
    ("val = '%100 Uyumlu';", "val = '100% Compliant';"),
    ("where = 'Uyumluluk Denetimi ekranındaki Avrupa Komisyonu yasal raporlama alanı.';", "where = 'Statutory European Commission compliance ledger.';"),
    ("why = 'Kayıtlı tüm müşterilerin KDV numaraları Avrupa Komisyonu VIES veritabanında aktif olarak doğrulanmıştır.';", "why = 'All VAT identification numbers verified active in European Commission VIES portal.';"),
    ("action = 'MiCA Kripto Varlık Düzenlemesi gereğince tüm RGB20 konsinye transferleri yerel olarak arşivlenmiş ve kanıtlanabilir durumdadır.';", "action = 'Under MiCA regulations, all RGB20 consignment states are archived locally and provable on-chain.';"),

    ("path = 'PROFİL › KURUMSAL KİMLİK';", "path = 'PROFILE › ENTITY CREDENTIALS';"),
    ("where = 'Sol alt kullanıcı alanı ve Profil Ayarları düzenleme ekranı.';", "where = 'Identity card and User Profile settings view.';"),
    ("why = 'Milano Ticaret Odası\\'na kayıtlı şahıs işletmesi kimliği. VIES veritabanında aktif ve Avrupa geneli sınır ötesi dijital hizmet faturası kesme yetkisine sahiptir.';", "why = 'Registered sole proprietorship in Milan Chamber of Commerce. Validated in VIES for intra-EU B2B services.';"),
    ("action = 'Kayıtlı SEPA IBAN ve fatura başlığı onaylı. Tüm fatura PDF\\'lerine bu yasal mühürler otomatik işlenmektedir.';", "action = 'SEPA IBAN and billing headers verified. Statutory disclosures automatically added to all invoice PDFs.';"),

    ("path = 'AYARLAR › DÜĞÜM ALTYAPISI';", "path = 'SETTINGS › NODE INFRASTRUCTURE';"),
    ("title = 'Yerel Electrum TLS Bağlantısı';", "title = 'Local Electrum TLS Node';"),
    ("where = 'Ayarlar ekranındaki düğüm ve ağ yapılandırma sekmesi.';", "where = 'Node connection tab in Settings view.';"),
    ("why = 'Uygulamanın üçüncü taraf sunuculara IP sızdırmadan kendi yerel Bitcoin tam düğümüne güvenle bağlanmasını sağlar.';", "why = 'Connects securely to local Bitcoin full node without leaking IP address or queries to third parties.';"),
    ("action = 'Gecikme 12ms, uçtan uca TLS şifrelemesi aktif. Gizli işlem yayınlama protokolü devrededir.';", "action = 'Latency is 12ms with end-to-end TLS encryption active. Private transaction broadcast protocol enabled.';"),

    ("title = navLabel + ' Modülü';", "title = navLabel + ' View';"),
    ("val = 'Çalışıyor';", "val = 'Operational';"),
    ("where = 'Sol gezinme menüsündeki temel uygulama alt sistemi bağlantısı.';", "where = 'Primary navigation link in application sidebar.';"),
    ("why = 'Finansal yönetimin ilgili alanına ait yerel modülü önbellekten anında ekrana yüklemek için kullanılır.';", "why = 'Instantly renders local cached workspace for the selected financial workflow.';"),
    ("action = 'Modül %100 yerel ortamda, sıfır bulut bağımlılığıyla çalışır. Tıklayarak modüle geçiş yapabilirsiniz.';", "action = 'Runs 100% locally with zero cloud dependencies. Click to navigate directly.';"),

    ("title = btnTxt || 'İşlem Butonu';", "title = btnTxt || 'Action Button';"),
    ("val = 'Tetiklemeye Hazır';", "val = 'Ready to Trigger';"),
    ("where = 'Arayüzdeki doğrudan kullanıcı aksiyon butonu.';", "where = 'Direct interactive user action button in active view.';"),
    ("why = 'Kullanıcının yerel şifreli defterde yeni bir durum geçişi veya veri güncellemesi başlatmasını sağlar.';", "why = 'Initiates a state transition or cryptographically verified mutation in local ledger.';"),
    ("action = 'Tıklama işlemi yerel kural motorundan onay alarak doğrulanmış işlem defterine yazılır.';", "action = 'Button triggers execution verified by local rule engine and commits state.';"),

    ("title = cleanSnippet || 'Arayüz Öğesi';", "title = cleanSnippet || 'Interface Element';"),
    ("val = 'Doğrulandı';", "val = 'Verified';"),
    ("where = 'Aktif ekrandaki ' + (cleanSnippet || 'metin/veri') + ' alanı.';", "where = 'Field representing ' + (cleanSnippet || 'data') + ' in active view.';"),
    ("why = 'Bu değer yerel şifreli SQLite veritabanından dinamik olarak çekilmiş olup, güncel sistem durumunu yansıtır.';", "why = 'Derived from local encrypted SQLite state, reflecting current verified ledger status.';"),
    ("action = 'Herhangi bir veri tutarsızlığı veya şema bozulması tespit edilmedi; durum %100 operasyoneldir.';", "action = 'Zero schema discrepancies or balance leaks detected; status is 100% operational.';")
]

for old, new in translations:
    text = text.replace(old, new)

with open("src/index.html", "w", encoding="utf-8") as f:
    f.write(text)

print("translate_all.py completed successfully!")
