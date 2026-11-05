const fs = require('fs');
const path = require('path');

const csvPath = path.join(__dirname, '..', 'linkedin', 'deepseek_last.csv');
const csv = fs.readFileSync(csvPath, 'utf8');
const lines = csv.split('\n');
const header = lines[0];
const rows = lines.slice(1).filter((l) => l.trim());

function csvCell(v) {
    const s = String(v ?? '').replace(/^"(.*)"$/, '$1');
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
}
function csvRow(arr) { return arr.map(csvCell).join(','); }

// Update map: match by a unique name fragment -> new array
const updates = {
    'ESRA KAVAS': ['UYGUN', 'Esra Kavas', 'Muhasebe ve İdari İşler Uzmanı (Ön muhasebe-Satın alma-Fatura-Bordro)', 'BEST PHARMA İlaç A.Ş.', 'Avcılar - İstanbul', 'EVET', 'Bilinmiyor (fatura/bordro ağırlıklı)', 'Hayır', 'O2W ✓; fatura-bordro-satın alma deneyimi', 'https://www.linkedin.com/in/esra-kavas-028817127/'],
    'Yavuz S.': ['UYGUN', 'Yavuz S.', 'Muhasebe Uzmanı', 'Smart Güneş Teknolojileri', 'İstanbul', 'EVET', 'Bilinmiyor (deneyim detayı kontrol)', 'Hayır', 'SAP FI/MM, cari mutabakat, e-fatura; O2W ✓', 'https://www.linkedin.com/in/yavuz-s-6235b172/'],
    'ELMAS DURSUN': ['UYGUN', 'ELMAS DURSUN', 'Muhasebe-Finans (İthalat-İhracat)', 'Atabay Pharma', 'İstanbul (profilde Türkiye)', 'EVET', 'Bilinmiyor', 'Karışık (SMMM durumu doğrulanmalı)', 'SAP, genel muhasebe, cari hesap, mutabakat; O2W ✓', 'https://www.linkedin.com/in/elmas-dursun-a0899b133/'],
    'Muhammet Kamilçelebi': ['ELENDİ', 'Muhammet KAMİLÇELEBİ', 'Muhasebe Uzmanı', 'Yeryüzü Gıda', 'Pendik - İstanbul', 'Görünmüyor', 'Bilinmiyor', 'Hayır', 'O2W Eksik', 'https://www.linkedin.com/in/muhammet-kamil%C3%A7elebi-17443a142/'],
};

const fresh = [
    ['UYGUN', 'Fadime (KESİKTAŞ) KAHRAMAN', 'Muhasebeci', 'Aktif iş Arayan', 'İstanbul', 'EVET', '12+ yıl', 'Hayır', 'O2W ✓; 12+ yıl muhasebe; finansal yönetim, raporlama', 'https://www.linkedin.com/in/fadime-kahraman-4b343835/'],
    ['UYGUN', 'Gülnur Toksöz', 'Senior Accounting Specialist', 'Dr. Schär', 'İstanbul', 'Görünmüyor', 'Kıdemli (yıl görünmüyor)', 'Hayır', 'Logo Go3/Tiger, SAP, e-Fatura, e-Arşiv, ileri Excel, mutabakat; çok güçlü uyum. O2W kontrol edilmeli', 'https://www.linkedin.com/in/g%C3%BClnur-toks%C3%B6z-21514590/'],
    ['UYGUN', 'Onur Uçar', 'Muhasebe Şefi', 'Hupalupa Eğlence İşletmeciliği A.Ş', 'Maltepe - İstanbul', 'EVET', 'Kıdemli (yıl görünmüyor)', 'Hayır', 'O2W ✓; Muhasebe Şefi pozisyonu', 'https://www.linkedin.com/in/onur-u%C3%A7ar-46b253158/'],
    ['DOĞRULANMALI', 'Öznur TUTKUN', 'Muhasebe ve İnsan Kaynakları Yöneticisi', 'Arma Global', 'İstanbul', 'Görünmüyor', '~20 yıl (14 yıl muhasebe)', 'Hayır', 'Güçlü deneyim; finansal raporlama. O2W kontrol edilmeli', 'https://www.linkedin.com/in/%C3%B6znur-tutkun-05132341/'],
    ['DOĞRULANMALI', 'Özlem Filinta', 'Muhasebe', 'Turkish Airlines Holidays (eski Kıdemli Muhasebe Uzmanı)', 'Beykoz - İstanbul', 'Görünmüyor', '~15 yıl', 'Hayır', '~15 yıl muhasebe/raporlama. O2W kontrol edilmeli', 'https://www.linkedin.com/in/%C3%B6zlem-filinta-a8966816b/'],
    ['DOĞRULANMALI', 'Ferhat Çakır', 'Muhasebe Uzmanı', 'Yenitepe Kadıköy Sitesi', 'İstanbul', 'EVET (search rozeti)', 'Bilinmiyor', 'Hayır', 'Muhasebe Uzmanı; O2W rozeti arama sonuçlarında görüldü; deneyim yılı doğrulanmalı', 'https://www.linkedin.com/in/ferhat-%C3%A7ak%C4%B1r/'],
    ['DOĞRULANMALI', 'Hakan Dursun Düşmez', 'Muhasebe Uzmanı', 'Kimpur', 'İstanbul', 'Görünmüyor', 'Bilinmiyor', 'Stajyer (SMMM)', 'SMMM stajyeri; Excel. Deneyim yılı ve O2W kontrol edilmeli', 'https://www.linkedin.com/in/hakan-dursun-d%C3%BC%C5%9Fmez-872a37157/'],
    ['DOĞRULANMALI', 'Fatma Yılmaz', 'Muhasebe Uzmanı', 'YEO', 'Türkiye (İstanbul adayı)', 'Görünmüyor', 'Bilinmiyor', 'Hayır', 'Konum tam doğrulanamadı; deneyim ve O2W kontrol edilmeli', 'https://www.linkedin.com/in/fatma-yilmaz/'],
    ['DOĞRULANMALI', 'Ayşe Gül Yıldız', 'Kıdemli Muhasebe Uzmanı', 'Engin Grup', 'Kadıköy - İstanbul', 'Görünmüyor', 'Kıdemli (yıl görünmüyor)', 'Hayır', 'Kıdemli Muhasebe; O2W kontrol edilmeli', 'https://www.linkedin.com/in/ay%C5%9Fe-g%C3%BCl-y%C4%B1ld%C4%B1z-556a641b6/'],
    ['DOĞRULANMALI', 'Ruşan Kuriro', 'Ön Muhasebe Uzmanı', 'Anadolu Üniversitesi (öğrenci/mezun)', 'İstanbul', 'EVET', 'Bilinmiyor', 'Hayır', 'O2W ✓; Luca ERP; ön muhasebe ağırlıklı, genel muhasebe derinliği kontrol edilmeli', 'https://www.linkedin.com/in/ru%C5%9Fan-kuriro-aab153195/'],
    ['DOĞRULANMALI', 'Mert Yaşar', 'Muhasebe Uzmanı (Finansal Kapanış & ERP)', 'Digiturk', 'İstanbul', 'Görünmüyor', 'Bilinmiyor', 'Hayır', 'ERP sistem tasarımı, kapanış süreçleri. O2W kontrol edilmeli', 'https://www.linkedin.com/in/mert-yasar/'],
    ['DOĞRULANMALI', 'Mehmet Erdi Y.', 'Muhasebe Uzmanı', 'Pronet Güvenlik Hizmetleri', 'İstanbul', 'Görünmüyor', 'Bilinmiyor', 'Hayır', 'O2W ve deneyim kontrol edilmeli', 'https://www.linkedin.com/in/mehmet-erdi-y-489b37247/'],
    ['DOĞRULANMALI', 'Emine Çoban', 'Kıdemli Muhasebe Uzmanı', 'Softtech', 'Türkiye (konum belirsiz)', 'Görünmüyor', 'Kıdemli (yıl görünmüyor)', 'Hayır', 'Kıdemli ünvan; konum ve O2W kontrol edilmeli', 'https://www.linkedin.com/in/emine-%C3%A7oban-8a47465a/'],
    ['DOĞRULANMALI', 'İlker D.', 'Muhasebe Uzmanı', 'BPW Otomotiv A.Ş', 'İstanbul', 'Görünmüyor', 'Bilinmiyor', 'Hayır', 'Finansal muhasebe, GAAP, KDV iadeleri, ihracat. O2W kontrol edilmeli', 'https://www.linkedin.com/in/ilker-d-baa169209/'],
    ['DOĞRULANMALI', 'Murat ÖZTÜRK', 'Muhasebe ve İdari İşler Kıdemli Uzmanı', 'RoofStacks', 'Pendik - İstanbul', 'Görünmüyor', 'Kıdemli (yıl görünmüyor)', 'Hayır', 'SAP, finansal raporlama. O2W kontrol edilmeli', 'https://www.linkedin.com/in/murat-%C3%B6zt%C3%BCrk-299442170/'],
    ['DOĞRULANMALI', 'Ahmet İLERİ', 'Kıdemli Muhasebe Uzmanı', 'Görünmüyor (303 takipçi)', 'İstanbul', 'Görünmüyor', 'Bilinmiyor', 'Hayır', 'Genel muhasebe, vergi, KDV iade uzmanlığı, bordro. O2W kontrol edilmeli', 'https://www.linkedin.com/in/ahmet-ileri-b95850102/'],
    ['DOĞRULANMALI', 'Ağgül Çam', 'Muhasebe Uzman Yardımcısı', 'Sivas Cumhuriyet Üniversitesi', 'İstanbul', 'Görünmüyor', 'Bilinmiyor', 'Hayır', 'Uzman Yardımcısı seviyesi; deneyim ve O2W kontrol edilmeli', 'https://www.linkedin.com/in/a%C4%9Fg%C3%BCl-%C3%A7am-640330174/'],
    ['DOĞRULANMALI', 'Rahime Biçer', 'Muhasebe/Finans (Tura Çelik)', 'Tura Çelik Büro Mob. ve İnş. San. Tic. Ltd. Şti.', 'Türkiye (konum belirsiz)', 'Görünmüyor', '~10 yıl', 'Hayır', 'Excel, finansal raporlama; konum ve O2W kontrol edilmeli', 'https://www.linkedin.com/in/rahime-bi%C3%A7er/?locale=en'],
    ['DOĞRULANMALI', 'Ekrem Yavrucuk', 'Danışman - Finansman Şirketleri', 'Serbest çalışan', 'İstanbul', 'Görünmüyor', 'Bilinmiyor', 'Hayır', 'Danışman; muhasebe uygunluğu ve O2W kontrol edilmeli', 'https://www.linkedin.com/in/ekrem-yavrucuk-94a14661/'],
    ['DOĞRULANMALI', 'Zeynep Yıldırım Arslan', 'CPA', 'Tekfen Construction', 'Çekmeköy - İstanbul', 'Görünmüyor', 'Bilinmiyor', 'SMMM (CPA)', 'CPA ünvanı; deneyim ve O2W kontrol edilmeli', 'https://www.linkedin.com/in/zeynep-y%C4%B1ld%C4%B1r%C4%B1m-arslan-a322028b/'],
    ['DOĞRULANMALI', 'Serkan KALKAN', 'SAP Proje - FI/SD/MM Modül Uzmanı - Muhasebe Kıdemli Uzmanı (SMMM Adayı)', 'Görünmüyor', 'İstanbul', 'Görünmüyor', 'Kıdemli (yıl görünmüyor)', 'SMMM Adayı', 'SAP FI/SD/MM, e-Fatura; güçlü teknik uyum. O2W kontrol edilmeli', 'https://www.linkedin.com/in/serkankalkan-/'],
    ['DOĞRULANMALI', 'Eray Akarı', 'Accounting Specialist', 'Foil Ambalaj San. ve Tic. A.Ş', 'İstanbul', 'EVET', 'Bilinmiyor (34 bağlantı, genç aday)', 'Hayır', 'O2W ✓; deneyim yılı ve genel muhasebe derinliği kontrol edilmeli', 'https://www.linkedin.com/in/eray-akar%C4%B1-573351138/'],
];

const elendi = [
    ['ELENDİ', 'Semra Erdem', 'SMMM / Muhasebe Uzmanı', 'Yıldız Holding (Milford Yıldız Gıda + Önem Gıda)', 'Kartal - İstanbul', 'Görünmüyor', '~4 yıl (2+2)', 'EVET', 'SMMM Ünvanı - ELENDİ', 'https://www.linkedin.com/in/semra-erdem-2b640196/'],
    ['ELENDİ', 'Emine Gök Yavuzkan', 'İnsan Kaynakları ve Kalite Yöneticisi', 'Mövenpick Hotel Istanbul Bosphorus', 'İstanbul', 'Görünmüyor', '5+ yıl (İK)', 'Hayır', 'İK odaklı, muhasebe değil', 'https://www.linkedin.com/in/eminegok/'],
    ['ELENDİ', 'Mustafa KESERCİ', 'Seyahat Acentesi - Arkman Uzmanı', 'Arbeta Turizm', 'İstanbul', 'Görünmüyor', '1998 muhasebe başlangıcı, son 14 yıl turizm', 'Hayır', 'Turizm sektöründe, muhasebe dışı', 'https://www.linkedin.com/in/mustafa-keserci-36743817/'],
    ['ELENDİ', 'İrem Gelişli', 'İK', 'Gül Al Otomotiv', 'İstanbul', 'Görünmüyor', 'Bilinmiyor', 'Hayır', 'İK rolü, muhasebe değil', 'https://www.linkedin.com/in/iremgelisli/?locale=en'],
    ['ELENDİ', 'Büşra Bayrak TAŞKAN', 'İnsan Kaynakları Uzmanı', 'Ekol Lojistik', 'Tuzla - İstanbul', 'Görünmüyor', '24 yaş, yeni mezun', 'Hayır', 'İK rolü, muhasebe değil', 'https://www.linkedin.com/in/b%C3%BC%C5%9Fra-bayrak-ta%C5%9Fkan-1956361a7/'],
    ['ELENDİ', 'Cem Alar', 'İnsan Kaynakları (10+ yıl)', 'Etra Holding', 'Bahçelievler - İstanbul', 'Görünmüyor', '10+ yıl (İK)', 'Hayır', 'İK odaklı, muhasebe değil', 'https://www.linkedin.com/in/cem-alar-314542169/'],
    ['ELENDİ', 'ARİF USLU', 'Mali Müşavir', 'ARİF USLU MUHASEBE BÜROSU', 'İstanbul', 'Görünmüyor', '1999 başlangıç, MM 2017', 'EVET', 'Mali Müşavir Ünvanı - ELENDİ', 'https://www.linkedin.com/in/arif-uslu-12aba5b0/'],
    ['ELENDİ', 'Ahmet Karaca', 'Stj. Mali Müşavir', 'Arıkanlı Holding', 'İstanbul', 'Görünmüyor', 'Stajyer', 'Stajyer', 'Stajyer Mali Müşavir - ELENDİ (deneyim < 3 yıl sınıfında)', 'https://www.linkedin.com/in/ahmetkaraca-accounting/'],
    ['ELENDİ', 'Asuman Çalışkan', 'Serbest Muhasebeci Mali Müşavir', 'Panasonic Electric Works Türkiye', 'İstanbul', 'Görünmüyor', '2004-2008 ve 2017-2018 görünüyor', 'EVET', 'SMMM Ünvanı - ELENDİ', 'https://www.linkedin.com/in/asuman-%C3%A7al%C4%B1%C5%9Fkan-bba514a0'],
    ['ELENDİ', 'Fatma Ünlü Bulut', 'Laboratuar', 'Laboratuar Mind Craft', 'Sarıyer - İstanbul', 'Görünmüyor', 'Bilinmiyor', 'Hayır', 'Muhasebe rolü değil', 'https://www.linkedin.com/in/fatma-%C3%BCnl%C3%BC-bulut-600495221/'],
    ['ELENDİ', 'Gamze Ç.', 'Belirtilmemiş (Başlık: Yok)', 'İstanbul İlaç Kozmetik Tur. San. ve Tic. Ltd. Şti.', 'Türkiye', 'Görünmüyor', 'Bilinmiyor', 'Hayır', 'Profil bilgisi yetersiz', 'https://www.linkedin.com/in/gamze-%C3%A7-63142870/'],
    ['ELENDİ', 'Ercan B.', 'Ön muhasebe ve İK Uzmanı', 'ESEL Denizcilik Gemi İnş. San. ve Tic. Ltd. Şti', 'İstanbul', 'Görünmüyor', 'Bilinmiyor', 'Hayır', 'Ön muhasebe/İK ağırlıklı, genel muhasebe değil', 'https://www.linkedin.com/in/ercan-b-816664165/'],
];

// Merge: rewrite matched existing rows, then append fresh+elendi
const out = [header];
const nameToRow = new Map(rows.map((r) => {
    const cols = r.split(',');
    const name = (cols[1] || '').replace(/^"(.*)"$/, '$1').trim();
    return [name.toLowerCase(), r];
}));

for (const line of rows) {
    const cols = line.split(',');
    const name = (cols[1] || '').replace(/^"(.*)"$/, '$1').trim().toLowerCase();
    let replaced = false;
    for (const [key, arr] of Object.entries(updates)) {
        const k = key.toLowerCase();
        if (name === k || (name.includes(k) && k.length > 3)) {
            out.push(csvRow(arr));
            replaced = true;
            break;
        }
    }
    if (!replaced) out.push(line);
}
for (const rowArr of [...fresh, ...elendi]) {
    const u = rowArr[rowArr.length - 1];
    const exists = out.some((l) => l.split(',').some((part) => part.trim() === u));
    if (!exists) out.push(csvRow(rowArr));
}

fs.writeFileSync(csvPath, out.join('\n') + '\n');
console.log('written', out.length - 1, 'data rows.');

// summary
let n = { UYGUN: 0, DOĞRULANMALI: 0, ELENDİ: 0 };
let icons = {};
for (const r of out.slice(1)) {
    const s = (r || '').split(',')[0].replace(/"/g, '');
    if (s in n) n[s]++;
}
console.log('summary:', JSON.stringify(n));